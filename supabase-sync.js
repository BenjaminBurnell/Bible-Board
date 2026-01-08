// supabase-sync.js
// Handles all auth, loading, saving, and ownership checks for the editor.
import { sb } from "./supabaseClient.js";

if (!window.BoardAPI) {
  console.error("BoardAPI not found. Ensure script.js loads before supabase-sync.js");
}

const BUCKET = "bible-boards";


// =====================
// Visibility helpers
// =====================
const VIS_PRIVATE = "private";
const VIS_PUBLIC = "public_view";

async function isBoardPublic(ownerId, boardId) {
  if (!ownerId || !boardId) return false;

  const fileName = `${boardId}.json`;
  const folder = `${ownerId}/public`;

  // Try LIST first (cheap)
  try {
    const { data, error } = await sb.storage
      .from(BUCKET)
      .list(folder, { search: fileName, limit: 1 });

    if (!error && Array.isArray(data)) {
      return data.some((f) => f.name === fileName);
    }
  } catch (_) {}

  // Fallback: try signing the exact file (also cheap)
  try {
    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(`${folder}/${fileName}`, 30);

    return !!data?.signedUrl && !error;
  } catch (_) {
    return false;
  }
}

// Refreshes window.__boardVisibility for the CURRENT URL board/owner
async function refreshBoardVisibility() {
  const params = new URLSearchParams(window.location.search);
  const boardId = params.get("board");
  const ownerId = params.get("owner");

  if (!boardId || !ownerId) {
    window.__boardVisibility = VIS_PRIVATE;
    return window.__boardVisibility;
  }

  // If you're not the owner, you're necessarily viewing a public board
  const { data: userData } = await sb.auth.getUser();
  const viewerId = userData?.user?.id;

  if (!viewerId || viewerId !== ownerId) {
    window.__boardVisibility = VIS_PUBLIC;
    return window.__boardVisibility;
  }

  window.__boardVisibility = (await isBoardPublic(ownerId, boardId))
    ? VIS_PUBLIC
    : VIS_PRIVATE;

  return window.__boardVisibility;
}

window.BoardAPI = window.BoardAPI || {};
window.BoardAPI.refreshVisibility = refreshBoardVisibility;



const DEFAULT_TITLE = "Untitled Bible Board";
const SAVE_DEBOUNCE_MS = 1000;
const RETRY_DELAYS = [200, 500, 1200];

// ---------- State ----------
let currentUser = null;
let lastLoadedUpdatedAt = null;
let saveDebounceTimer = null;
let currentSavePromise = null;
let pendingSave = false;
let lastKnownUser = null;
let hideBadgeTimer = null;

// State for URL params
let currentBoardId = null; 
let currentOwnerId = null; 
let isReadOnly = false; 

// CRITICAL FIX: Tracks the ID of the board currently ON SCREEN.
// We use this for saving to prevent overwriting data during a switch.
let loadedBoardId = null;

// ---------- NEW: Durable Save Helpers ----------

async function sha256String(s) {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VERIFY_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];

async function verifyPersistence(path, expectedHash) {
  console.log(`Verifying hash: ${expectedHash.substring(0, 8)}...`);
  for (let i = 0; i < VERIFY_BACKOFF_MS.length; i++) {
    try {
      const data = await downloadFreshOrThrow(path);
      const text = await data.text();
      const got = await sha256String(text);

      if (got === expectedHash) {
        console.log(`Verify success (attempt ${i + 1})`);
        return true;
      }
    } catch (e) {
      console.warn(`Verify exception (attempt ${i + 1}):`, e.message);
    }
    await new Promise(r => setTimeout(r, VERIFY_BACKOFF_MS[i]));
  }
  throw new Error("Verification failed: storage not yet consistent");
}

// ---------- DOM helpers ----------
const statusBadge = document.getElementById("persistence-status");
const accessBlocker = document.getElementById("access-denied-blocker");

function getTitleEl() {
  return (
    document.getElementById("title-textbox") ||
    document.getElementById("bible-whiteboard-title") ||
    document.querySelector('[data-role="board-title"]') ||
    null
  );
}
function readTitle() {
  const el = getTitleEl();
  if (!el) return "";
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value || "";
  return (el.textContent || "").trim();
}

function setWindowTitle(title) {
  const clean = (title || "").trim();
  document.title = `${clean || "Untitled Board"} - BibleBoard`;
}

function writeTitle(v) {
  const el = getTitleEl();
  if (!el) return;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = v || "";
  else el.textContent = v || "";
}

function initializeBoardId() {
  try {
    const params = new URLSearchParams(window.location.search);
    currentBoardId = params.get("board") || null;
    currentOwnerId = params.get("owner") || null; 

    if (currentBoardId) {
      console.log(`Targeting board ID: ${currentBoardId}`);
    } else {
      console.log("No board ID found.");
    }
  } catch (e) {
    console.error("Failed to parse URL params:", e);
  }
}

const pathFor = (uid, boardId) => {
  if (!uid) return null;
  if (boardId) return `${uid}/boards/${boardId}.json`;
  return `${uid}/board.json`;
};

const pathForPublic = (uid, boardId) => `${uid}/public/${boardId}.json`;

// ===============================
// Visibility helpers
// ===============================
function setClientVisibility(v) {
  // v: "private" | "public_view"
  window.__boardVisibility = v;
  window.dispatchEvent(
    new CustomEvent("bibleboard:visibility", {
      detail: { boardId: currentBoardId, ownerId: currentOwnerId, visibility: v },
    })
  );
}

async function computeOwnerVisibility(ownerId, boardId) {
  const publicPath = pathForPublic(ownerId, boardId);

  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(publicPath, 30);
    if (error || !data?.signedUrl) return "private";

    const resp = await fetch(data.signedUrl, { method: "HEAD", cache: "no-store" });
    return resp.ok ? "public_view" : "private";
  } catch {
    return "private";
  }
}

async function refreshVisibilityForCurrentBoard(user, ownerId) {
  // If you're not the owner, you can only be here via /public
  if (!user || user.id !== ownerId) {
    setClientVisibility("public_view");
    return "public_view";
  }

  const v = await computeOwnerVisibility(ownerId, currentBoardId);
  setClientVisibility(v);
  return v;
}

/**
 * Moves a board file between private and public folders.
 * @param {string} uid - The user's Supabase UID
 * @param {string} boardId - The board ID
 * @param {boolean} makePublic - true = publish, false = unpublish
 */
async function moveBoardVisibility(uid, boardId, makePublic) {
  const src = makePublic
    ? pathFor(uid, boardId)
    : pathForPublic(uid, boardId);
  const dest = makePublic
    ? pathForPublic(uid, boardId)
    : pathFor(uid, boardId);

  // Download board content
  const { data, error: dlErr } = await sb.storage.from(BUCKET).download(src);
  if (dlErr || !data) throw new Error("Download failed: " + (dlErr?.message || ""));

  // Upload to destination
  const blob = new Blob([await data.text()], { type: "application/json" });
  const { error: upErr } = await sb.storage.from(BUCKET).upload(dest, blob, {
    upsert: true,
    cacheControl: "no-store",
  });
  if (upErr) throw new Error("Upload failed: " + (upErr.message || ""));

  // Delete original (optional)
  await sb.storage.from(BUCKET).remove([src]);

  console.log(makePublic ? "✅ Board published." : "✅ Board unpublished.");
  return dest;
}

async function downloadFreshOrThrow(path) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 10);
  if (error || !data?.signedUrl) {
    const e = new Error(error?.message || "failed to create signed URL");
    e.status = error?.status || 0;
    throw e;
  }
  const url = data.signedUrl + (data.signedUrl.includes("?") ? "&" : "?") + `cb=${Date.now()}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) {
    const e = new Error(`fresh download bad status: ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return await resp.blob();
}

// ---------- UI Feedback Badge ----------
function showPersistenceBadge(status) {
  if (!statusBadge) return;
  clearTimeout(hideBadgeTimer);
  statusBadge.style.display = "block";
  statusBadge.style.opacity = "1";

  switch (status) {
    case "login-required":
      statusBadge.textContent = "Please sign in";
      statusBadge.style.color = "var(--muted)";
      break;
    case "creating":
      statusBadge.textContent = "Creating board...";
      statusBadge.style.color = "var(--muted)";
      break;
    case "loading":
      statusBadge.textContent = "Loading...";
      statusBadge.style.color = "var(--muted)";
      break;
    case "saving":
      statusBadge.textContent = "Saving...";
      statusBadge.style.color = "var(--muted)";
      break;
    case "saved":
      statusBadge.textContent = "Saved";
      statusBadge.style.color = "var(--accent)";
      hideBadgeTimer = setTimeout(hidePersistenceBadge, 1500);
      break;
    case "offline":
      statusBadge.textContent = "Offline";
      statusBadge.style.color = "#f3a54a"; 
      break;
    case "readonly":
      statusBadge.textContent = "View-only";
      statusBadge.style.color = "var(--muted)";
      break;
    case "no-access":
      statusBadge.textContent = "Access Denied";
      statusBadge.style.color = "#e55353"; 
      break;
    case "error":
      statusBadge.textContent = "Save Error";
      statusBadge.style.color = "#e55353"; 
      break;
    case "error-load":
      statusBadge.textContent = "Load Error";
      statusBadge.style.color = "#e55353"; 
      break;
  }
}
function hidePersistenceBadge() {
  if (!statusBadge) return;
  statusBadge.style.opacity = "0";
  hideBadgeTimer = setTimeout(() => {
    statusBadge.style.display = "none";
  }, 300);
}

async function withRetries(fn, retries = 3, delays = RETRY_DELAYS) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isAuthError = error.status === 401 || error.status === 403 || error.status === 400;
      if (isAuthError || i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, delays[i] || 1000));
    }
  }
}

// ---------- Board Serialization / Deserialization ----------
function serializeBoard() {
  const { viewport, getConnections, itemKey, getScale } = window.BoardAPI;

  const elements = [];
  document.querySelectorAll(".board-item").forEach((el) => {
    const base = {
      vkey: itemKey(el),
      left: el.style.left,
      top: el.style.top,
      zIndex: el.style.zIndex || 1,
    };

    if (el.classList.contains("bible-verse")) {
      elements.push({
        ...base, type: "verse",
        text: el.querySelector(".verse-text-content")?.textContent || "",
        reference: el.querySelector(".verse-text-reference")?.textContent || "",
      });
    } else if (el.classList.contains("text-note")) {
      elements.push({
        ...base, type: "note",
        html: el.querySelector(".text-content")?.innerHTML || "",
      });
    } else if (el.classList.contains("interlinear-card")) {
      elements.push({ ...base, type: "interlinear", ...el.dataset });
    } else if (el.classList.contains("song-item")) {
      elements.push({
        ...base, type: "song",
        title: el.querySelector(".song-name")?.textContent || "",
        artist: el.querySelector(".song-artist")?.textContent || "",
        cover: el.querySelector(".song-cover")?.src || "",
      });
    }
  });

  const connections = getConnections().map((c) => ({
    a: itemKey(c.itemA),
    b: itemKey(c.itemB),
    color: c.color || (c.path && c.path.style.stroke) || undefined,
  }));

  const sc = getScale();
  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;
  const centerX = (viewport.scrollLeft + vpW / 2) / sc;
  const centerY = (viewport.scrollTop + vpH / 2) / sc;

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    title: readTitle() || DEFAULT_TITLE,
    viewport: { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, scale: sc, centerX, centerY },
    elements,
    connections,
  };
}

function deserializeBoard(payload) {
  if (!payload) return;
  const { clearBoard, addBibleVerse, addTextNote, addInterlinearCard, addSongElement, getElementByVKey, connectItems, setScale, viewport, updateAllConnections } = window.BoardAPI;

  window.__RESTORING_FROM_SUPABASE = true;

  try {
    clearBoard();
    writeTitle(payload.title || DEFAULT_TITLE);
    setWindowTitle(payload.title || "");

    (payload.elements || []).forEach((data) => {
      let el;
      if (data.type === "verse") el = addBibleVerse(data.reference, data.text, true);
      else if (data.type === "note") el = addTextNote(data.html);
      else if (data.type === "interlinear") el = addInterlinearCard(data);
      else if (data.type === "song") el = addSongElement(data);

      if (el) {
        el.dataset.vkey = data.vkey;
        el.style.left = data.left || "4000px";
        el.style.top = data.top || "4000px";
        el.style.zIndex = data.zIndex || 1;
      }
    });

    (payload.connections || []).forEach((c) => {
      const elA = getElementByVKey(c.a);
      const elB = getElementByVKey(c.b);
      if (elA && elB) connectItems(elA, elB, c.color);
    });

    const s = payload.viewport;
    if (s) {
      setScale(s.scale || 1);
      const applyScroll = () => {
        const sc = s.scale || 1;
        const tLeft = s.centerX != null ? s.centerX * sc - viewport.clientWidth / 2 : (s.scrollLeft || 0);
        const tTop = s.centerY != null ? s.centerY * sc - viewport.clientHeight / 2 : (s.scrollTop || 0);
        viewport.scrollLeft = Math.max(0, tLeft);
        viewport.scrollTop = Math.max(0, tTop);
      };
      applyScroll();
      requestAnimationFrame(() => requestAnimationFrame(applyScroll));
    } else {
      setScale(1);
      viewport.scrollLeft = 3500;
      viewport.scrollTop = 3500;
    }

    lastLoadedUpdatedAt = payload.updatedAt;
    setTimeout(updateAllConnections, 50);
  } catch (e) {
    console.error("Failed to deserialize board:", e);
  } finally {
    window.__RESTORING_FROM_SUPABASE = false;
  }
}

// ---------- Core Storage Ops ----------

async function ensureBoardFile(user, ownerId) {
  const path = pathFor(ownerId, currentBoardId);
  if (!path) return false;

  try {
    await sb.storage.from(BUCKET).download(path);
    return true;
  } catch (error) {
    const isMissing = error?.status === 404 || error?.statusCode === 404;
    if (!isMissing) return false;
    if (ownerId !== user.id) return false;

    console.log("Creating default board file...");
    showPersistenceBadge("creating");
    try {
      const defaultPayload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        title: "Untitled Bible Board",
        viewport: { scrollLeft: 3500, scrollTop: 3500, scale: 1 },
        elements: [], connections: [],
      };
      const blob = new Blob([JSON.stringify(defaultPayload, null, 2)], { type: "application/json" });
      await withRetries(() => sb.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: "application/json", cacheControl: "0" }));
      hidePersistenceBadge();
      return true;
    } catch (createError) {
      console.warn("Failed to create default board:", createError);
      return false;
    }
  }
}





function setVisibilityState(visibility, ready = true) {
  window.__boardVisibility = visibility;
  window.__boardVisibilityReady = ready;

  window.dispatchEvent(
    new CustomEvent("bibleboard:visibility", {
      detail: {
        boardId: currentBoardId,
        ownerId: currentOwnerId,
        visibility,
        ready,
      },
    })
  );
}

async function refreshVisibility() {
  // mark “not ready” immediately so UI can disable/hide things
  setVisibilityState(window.__boardVisibility || "private", false);

  const owner = currentOwnerId || lastKnownUser?.id;
  const bid = currentBoardId;
  if (!owner || !bid) {
    setVisibilityState("private", true);
    return "private";
  }

  const publicPath = pathForPublic(owner, bid);

  // quickest “exists?” check without downloading the file
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(publicPath, 60);

  const visibility = !error && data?.signedUrl ? "public_view" : "private";
  setVisibilityState(visibility, true);
  return visibility;
}






async function loadBoard(user, ownerId) {
  const path = pathFor(ownerId, currentBoardId);
  if (!path) return;
  setClientVisibility("private"); // clear stale value from previous board

  // --- 1. STRICT CLIENT-SIDE GUARD ---
  // If the board belongs to someone else (based on URL), block it immediately.
  // We don't even need to ask Supabase, because we know the answer is "No".
  if (ownerId !== user.id) {
    console.warn("Attempting to load shared board...");

    const publicPath = pathForPublic(ownerId, currentBoardId);
    try {
      showPersistenceBadge("loading");
      const blob = await withRetries(() => downloadFreshOrThrow(publicPath));
      const text = await blob.text();
      const json = JSON.parse(text || "{}");
      isReadOnly = true;
      if (window.BoardAPI?.applyReadOnlyGuards) window.BoardAPI.applyReadOnlyGuards(true);
      deserializeBoard(json);
      loadedBoardId = currentBoardId; // good to set even in readonly
      setClientVisibility("public_view");
      const blocker = document.getElementById("access-denied-blocker");
      if (blocker) blocker.style.display = "none";
      hidePersistenceBadge();
      await refreshVisibility();
      await refreshVisibilityForCurrentBoard(user, ownerId);
      return;
    } catch {
      console.warn("No shared board found or access denied.");
      showPersistenceBadge("no-access");
      const blocker = document.getElementById("access-denied-blocker");
      if (blocker) blocker.style.display = "flex";
      window.BoardAPI.clearBoard();
      return;
    }
  }


  // --- 2. Standard Loading for Owner ---
  showPersistenceBadge("loading");

  try {
    const blob = await withRetries(() => downloadFreshOrThrow(path));
    const text = await blob.text();
    const json = JSON.parse(text || "{}");
    
    deserializeBoard(json);
    loadedBoardId = currentBoardId;
    
    // Success!
    hidePersistenceBadge();

  } catch (error) {
    // Since we blocked non-owners above, any error here is happening to YOU (the owner).
    // It's likely just that the file doesn't exist yet (404).
    
    const isMissing = error?.status === 404 || error?.statusCode === 404 || (error.message && error.message.includes("not found"));
    
    if (isMissing) {
      // File missing? Create it.
      console.log("Board file missing. Creating new default board...");
      const ok = await ensureBoardFile(user, ownerId);
      
      if (ok) {
        // Creation successful, load empty state
        deserializeBoard(serializeBoard()); // Loads default state
        loadedBoardId = currentBoardId; 
        showPersistenceBadge("saved");
      } else {
        showPersistenceBadge("error-load");
      }
    } else {
      console.error("Load error:", error);
      showPersistenceBadge("error-load");
    }
  }
}

async function saveBoard(user) {
  // FIX: Use loadedBoardId instead of currentBoardId/URL
  // This ensures we save to the board currently on screen, not the one in the URL bar.
  const activeId = loadedBoardId;

  if (isReadOnly || !activeId) return;
  if (currentSavePromise) {
    pendingSave = true;
    return;
  }

  showPersistenceBadge("saving");
  const payload = serializeBoard();
  const path = pathFor(user.id, activeId); // Save to the loaded ID
  
  if (!path) {
    showPersistenceBadge("error");
    return;
  }

  const json = JSON.stringify(payload, null, 2);
  const hash = await sha256String(json);
  const blob = new Blob([json], { type: "application/json" });

  const saveOp = async () => {
    try {
      return await sb.storage.from(BUCKET).update(path, blob, { upsert: false, contentType: "application/json", cacheControl: "no-store" });
    } catch (updateError) {
      return sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: "application/json", cacheControl: "no-store" });
    }
  };

  currentSavePromise = withRetries(saveOp);

  try {
    await currentSavePromise;
    await verifyPersistence(path, hash);
    lastLoadedUpdatedAt = payload.updatedAt;
    showPersistenceBadge("saved");

    // ✅ Add this here
    if (window.__boardVisibility === "public_view") {
      const publicPath = pathForPublic(user.id, activeId);
      await sb.storage.from(BUCKET).upload(publicPath, blob, {
        upsert: true,
        contentType: "application/json",
        cacheControl: "no-store",
      });
    }
  } catch (error) {
    console.warn("Failed to save:", error);
    showPersistenceBadge("error");
  } finally {
    currentSavePromise = null;
    if (pendingSave) {
      pendingSave = false;
      scheduleSave(user, 0);
    }
  }
}

function scheduleSave(user, delay = SAVE_DEBOUNCE_MS) {
  if (!user || isReadOnly) return;
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => saveBoard(user), delay);
}

// ---------- Auth Lifecycle ----------
async function refreshAuthUI() {
  const signinBtn = document.getElementById("signin-btn");
  const signoutBtn = document.getElementById("signout-btn");
  const authed = !!lastKnownUser;
  if (signinBtn) signinBtn.style.display = authed ? "none" : "inline-flex";
  if (signoutBtn) signoutBtn.style.display = authed ? "inline-flex" : "none";
}

document.getElementById("signin-btn")?.addEventListener("click", async () => {
  await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
});
document.getElementById("signout-btn")?.addEventListener("click", async () => {
  await sb.auth.signOut();
  window.location.reload(); // Reload on sign out is fine
});

let shareViewerInterceptorInstalled = false;

function updateViewerTopButtons() {
  const shareBtn = document.getElementById("share-btn");
  const scriptureBtn = document.getElementById("scripture-mode-toggle");

  const user = lastKnownUser;
  const owner = currentOwnerId || user?.id;

  const isOwner = !!user && !!owner && user.id === owner;
  const isViewer = !!user && !!owner && user.id !== owner;

  // Hide "Open Scripture" for viewers
  if (scriptureBtn) scriptureBtn.style.display = isViewer ? "none" : "";

  // Replace Share button for viewers
  if (shareBtn) {
    if (isViewer) {
      shareBtn.style.display = "inline-flex";
      shareBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg"
          width="16px" height="16px" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round"
          class="icon icon-tabler icons-tabler-outline icon-tabler-copy"
          style="flex:0 0 auto;">
          <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
          <path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666"/>
          <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>
        </svg>
        <span>Make a copy</span>
      `;

      shareBtn.title = "Make a copy";
      shareBtn.setAttribute("aria-haspopup", "false");
      shareBtn.setAttribute("aria-expanded", "false");
    } else if (isOwner) {
      shareBtn.style.display = "inline-flex";
      document.getElementById("share-btn-label").textContent = "Share";
      shareBtn.title = "Share";
      shareBtn.setAttribute("aria-haspopup", "true");
    } else {
      // logged out
      shareBtn.style.display = "none";
    }

    // Intercept clicks in CAPTURE phase so viewers can’t open Share modal
    if (!shareViewerInterceptorInstalled) {
      shareViewerInterceptorInstalled = true;

      shareBtn.addEventListener(
        "click",
        async (e) => {
          const u = lastKnownUser;
          const o = currentOwnerId || u?.id;
          const viewer = !!u && !!o && u.id !== o;
          if (!viewer) return; // owners keep normal share

          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          if (typeof window.makeCopyOfCurrentBoard === "function") {
            await window.makeCopyOfCurrentBoard();
          } else {
            alert("Make copy is not ready yet.");
          }
        },
        true // <-- capture
      );
    }
  }
}


function applyOwnershipMode() {
  const user = lastKnownUser;
  const owner = currentOwnerId || user?.id;
  isReadOnly = !user || !owner || user.id !== owner;

  if (window.BoardAPI?.applyReadOnlyGuards) window.BoardAPI.applyReadOnlyGuards(isReadOnly);

  updateViewerTopButtons(); // ✅ add this
}

// ---------- Main App Initialization ----------
async function main() {
  initializeBoardId(); 

  const { data: { session } } = await sb.auth.getSession();
  const user = session?.user;
  lastKnownUser = user;
  await refreshAuthUI();
  applyOwnershipMode();

  if (!user) {
    showPersistenceBadge("login-required");
    window.BoardAPI.clearBoard();
    writeTitle(DEFAULT_TITLE);
  } else {
    const ownerId = currentOwnerId || user.id;
    await loadBoard(user, ownerId);
  }

  sb.auth.onAuthStateChange(async (event, session) => {
    const oldUser = lastKnownUser;
    const newUser = session?.user || null;
    lastKnownUser = newUser;
    await refreshAuthUI();

    if (event === "SIGNED_OUT") {
      window.location.reload();
    } else if (event === "SIGNED_IN" && oldUser && oldUser.id !== newUser.id) {
       // Only reload if user CHANGED. Prevents loop.
       window.location.reload();
    }
  });

  // Tour (Optional, kept from original)
  try {
    const user = lastKnownUser;
    const userId = user?.id || "anonymous";
    // Tour init logic here if needed...
  } catch (e) {}
}

// ---------- Public API Wire-up ----------
if (window.BoardAPI) {
  window.BoardAPI.triggerAutosave = () => {
    scheduleSave(lastKnownUser);
  };

  // FIX: Hook external save calls to our internal logic
  window.BoardAPI.saveBoard = async (serialData) => {
    // We ignore serialData and grab fresh state to ensure consistency
    saveBoard(lastKnownUser); 
  };
  
  // FIX: Add forceFlushSave for board switching
  window.BoardAPI.forceFlushSave = (reason) => {
      if(lastKnownUser && !isReadOnly) {
          saveBoard(lastKnownUser);
      }
  }

  window.BoardAPI.setBoardVisibility = async (newVisibility) => {
    const user = lastKnownUser;
    const boardId = loadedBoardId || currentBoardId;

    if (!user) throw new Error("NOT_SIGNED_IN");
    if (!boardId) throw new Error("NO_BOARD_ID");
    if (isReadOnly) throw new Error("READ_ONLY");

    const makePublic = newVisibility === "public_view";

    if (makePublic) {
      // Publish = upload a public copy (recommended: DON'T move out of /boards)
      const payload = serializeBoard();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const publicPath = pathForPublic(user.id, boardId);

      const { error } = await sb.storage
        .from(BUCKET)
        .upload(publicPath, blob, {
          upsert: true,
          contentType: "application/json",
          cacheControl: "no-store",
        });

      if (error) throw error;
    } else {
      // Unpublish = remove the public copy
      const publicPath = pathForPublic(user.id, boardId);
      const { error } = await sb.storage.from(BUCKET).remove([publicPath]);
      if (error) throw error;
    }

    window.__boardVisibility = makePublic ? "public_view" : "private";
    return window.__boardVisibility;
  };
}

// ========================================================
// 3. EVENT LISTENER FOR SWITCHING (SPA Behavior)
// ========================================================
window.addEventListener("bibleboard:load", async (e) => {
  const { boardId, ownerId } = e.detail;
  console.log("🔄 Switching to board:", boardId);
  setVisibilityState("private", false);
  // 1. Force Save OLD Board (using old loadedBoardId)
  if (!isReadOnly && lastKnownUser) {
      await saveBoard(lastKnownUser);
  }

  // 2. Unset ID so we don't save to old board while loading
  loadedBoardId = null;
  
  // 3. Update State
  currentBoardId = boardId;
  currentOwnerId = ownerId;
  applyOwnershipMode();

  // 4. Clear Workspace
  const workspace = document.getElementById("workspace");
  const connectionsSvg = document.getElementById("connections");
  if (workspace) {
    workspace.querySelectorAll(".board-item").forEach((el) => el.remove());
    workspace.style.transform = "scale(1) translate(0px, 0px)";
    workspace.dataset.scale = "1";
    workspace.dataset.x = "0";
    workspace.dataset.y = "0";
  }
  if (connectionsSvg) connectionsSvg.innerHTML = "";
  writeTitle(""); 

  // 5. Reset Undo/Redo
  if (window.UndoRedoManager) {
    window.UndoRedoManager.undoStack = [];
    window.UndoRedoManager.redoStack = [];
    window.UndoRedoManager.refreshUndoRedoButtons();
  }

  // 6. Load NEW Board
  await loadBoard(lastKnownUser, currentOwnerId || lastKnownUser.id);
});

main();