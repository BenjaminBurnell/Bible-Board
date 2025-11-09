// supabase-sync.js
// Handles all auth, loading, saving, and ownership checks for the editor.
import { sb } from "./supabaseClient.js"; // Import shared client (in root)

if (!window.BoardAPI) {
  console.error(
    "BoardAPI not found. Ensure script.js loads before supabase-sync.js"
  );
}

const BUCKET = "bible-boards";
const DEFAULT_TITLE = "Untitled Bible Board";
const SAVE_DEBOUNCE_MS = 1000;
const RETRY_DELAYS = [200, 500, 1200];

// ---------- State ----------
let lastLoadedUpdatedAt = null;
let saveDebounceTimer = null;
let currentSavePromise = null;
let pendingSave = false;
let lastKnownUser = null;
let hideBadgeTimer = null;
let currentBoardId = null; // Stores the board ID from URL
let currentOwnerId = null; // Stores the owner ID from URL
let isReadOnly = false; // Blocks saves if not owner

// ---------- NEW: Durable Save Helpers ----------

/**
 * Computes a SHA-256 hash of a string.
 * @param {string} s The string to hash
 * @returns {Promise<string>} The hex-encoded hash
 */
async function sha256String(s) {
  const enc = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Verification backoff schedule
const VERIFY_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];

/**
 * Verifies that the file at `path` matches the `expectedHash`.
 * Retries with backoff to wait for storage consistency.
 * @param {string} path The storage path (e.g., "uid/boards/id.json")
 * @param {string} expectedHash The SHA-256 hash we expect to find
 */
async function verifyPersistence(path, expectedHash) {
  console.log(`Verifying hash: ${expectedHash.substring(0, 8)}...`);
  for (let i = 0; i < VERIFY_BACKOFF_MS.length; i++) {
    try {
      // ⬇️ use the signed-url + no-store fetch
      const data = await downloadFreshOrThrow(path);
      const text = await data.text();
      const got = await sha256String(text);

      if (got === expectedHash) {
        console.log(`Verify success (attempt ${i + 1})`);
        return true;
      }
      console.warn(`Verify mismatch (attempt ${i + 1}): got ${got.substring(0, 8)}...`);
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
function writeTitle(v) {
  const el = getTitleEl();
  if (!el) return;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = v || "";
  else el.textContent = v || "";
}

// *** UPDATED: Read board ID and owner ID from URL ***
function initializeBoardId() {
  try {
    const params = new URLSearchParams(window.location.search);
    currentBoardId = params.get("board") || null;
    currentOwnerId = params.get("owner") || null; // NEW

    if (currentBoardId) {
      console.log(
        `Targeting board ID: ${currentBoardId}`,
        `Owner: ${currentOwnerId || " (self)"}`
      );
    } else {
      console.log("No board ID found, using legacy default board.");
      currentOwnerId = lastKnownUser?.id || null; // Use self for legacy
    }
  } catch (e) {
    console.error("Failed to parse URL params:", e);
    currentBoardId = null;
    currentOwnerId = null;
  }
}

// *** REFACTORED: pathFor uses owner's UID ***
const pathFor = (uid, boardId) => {
  if (!uid) {
    console.error("pathFor called with no UID!");
    return null; // Or some error path
  }
  if (boardId) {
    // New multi-board path
    return `${uid}/boards/${boardId}.json`;
  }
  // Legacy single-board path
  return `${uid}/board.json`;
};

// Fetch the latest bytes via a short-lived signed URL (busts edge caches)
async function downloadFreshOrThrow(path) {
  // 1) Create a short-lived signed URL
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 10);
  if (error || !data?.signedUrl) {
    const e = new Error(error?.message || "failed to create signed URL");
    e.status = error?.status || error?.statusCode || 0;
    throw e;
  }
  // 2) Cache-bust + no-store to force origin
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
      statusBadge.style.border = "1px solid var(--fg-seethrough)";
      break;
    case "creating":
      statusBadge.textContent = "Creating board...";
      statusBadge.style.color = "var(--muted)";
      statusBadge.style.border = "1px solid var(--fg-seethrough)";
      break;
    case "loading":
      statusBadge.textContent = "Loading...";
      statusBadge.style.color = "var(--muted)";
      statusBadge.style.border = "1px solid var(--fg-seethrough)";
      break;
    case "saving":
      statusBadge.textContent = "Saving...";
      statusBadge.style.color = "var(--muted)";
      statusBadge.style.border = "1px solid var(--fg-seethrough)";
      break;
    case "saved":
      statusBadge.textContent = "Saved";
      statusBadge.style.color = "var(--accent)";
      statusBadge.style.border = "1px solid var(--fg-seethrough)";
      hideBadgeTimer = setTimeout(hidePersistenceBadge, 1500);
      break;
    case "offline":
      statusBadge.textContent = "Offline";
      statusBadge.style.color = "#f3a54a"; // Orange
      break;
    case "readonly":
      statusBadge.textContent = "View-only";
      statusBadge.style.color = "var(--muted)";
      break;
    case "no-access":
      statusBadge.textContent = "Access Denied";
      statusBadge.style.color = "#e55353"; // Red
      break;
    case "error":
      statusBadge.textContent = "Save Error";
      statusBadge.style.color = "#e55353"; // Red
      break;
    case "error-load":
      statusBadge.textContent = "Load Error";
      statusBadge.style.color = "#e55353"; // Red
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

// ---------- Retry Logic ----------
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, retries = 3, delays = RETRY_DELAYS) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isNetworkError = !error.status;
      const isServerOverload = error.status === 429 || error.status === 408;
      const isServerError = error.status >= 500;

      const isRetryable = isNetworkError || isServerOverload || isServerError;

      const isAuthError =
        error.status === 401 || error.status === 403 || error.status === 400;
      if (isAuthError) {
        throw error;
      }

      if (!isRetryable || i === retries - 1) {
        throw error; // Not retryable or last attempt, re-throw
      }

      console.warn(
        `Supabase op failed, retrying... (Attempt ${i + 1})`,
        error.message
      );
      await sleep(delays[i] || 1000);
    }
  }
}

// ---------- Board Serialization / Deserialization ----------

/**
 * Reads the entire board state from the DOM and returns a JSON payload.
 * Saves a scale-independent world-space center (centerX/centerY) to make
 * viewport restore robust across late layout/scale changes.
 */
function serializeBoard() {
  const {
    viewport,
    getConnections,
    itemKey,
    getScale,
  } = window.BoardAPI;

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
        ...base,
        type: "verse",
        text: el.querySelector(".verse-text-content")?.textContent || "",
        reference: el.querySelector(".verse-text-reference")?.textContent || "",
      });
    } else if (el.classList.contains("text-note")) {
      elements.push({
        ...base,
        type: "note",
        html: el.querySelector(".text-content")?.innerHTML || "",
      });
    } else if (el.classList.contains("interlinear-card")) {
      elements.push({
        ...base,
        type: "interlinear",
        surface: el.dataset.surface,
        english: el.dataset.english,
        translit: el.dataset.translit,
        morph: el.dataset.morph,
        strong: el.dataset.strong,
        reference: el.dataset.reference,
      });
    } else if (el.classList.contains("song-item")) {
      elements.push({
        ...base,
        type: "song",
        title: el.querySelector(".song-name")?.textContent || "",
        artist: el.querySelector(".song-artist")?.textContent || "",
        cover: el.querySelector(".song-cover")?.src || "",
      });
    }
  });

  const connections = getConnections().map((c) => ({
    a: itemKey(c.itemA),
    b: itemKey(c.itemB),
    color:
      c.color ||
      (c.path && (c.path.dataset.color || c.path.style.stroke)) ||
      undefined,
  }));

  // Viewport (save both raw scrolls and world-space center)
  const sc = getScale();
  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;
  const centerX = (viewport.scrollLeft + vpW / 2) / sc;
  const centerY = (viewport.scrollTop + vpH / 2) / sc;

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    title: readTitle() || DEFAULT_TITLE,
    viewport: {
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      scale: sc,
      centerX,
      centerY,
    },
    elements,
    connections,
  };
  return payload;
}


/**
 * Re-hydrates the board from a JSON payload.
 * Restores using saved world-space center (if present) and applies scroll twice
 * (double-RAF) so late layout/connection updates cannot push you to the bottom.
 */
function deserializeBoard(payload) {
  if (!payload) return;

  const {
    clearBoard,
    addBibleVerse,
    addTextNote,
    addInterlinearCard,
    addSongElement,
    getElementByVKey,
    connectItems,
    setScale,
    viewport,
    updateAllConnections,
  } = window.BoardAPI;

  window.__RESTORING_FROM_SUPABASE = true;

  try {
    // Title
    clearBoard();
    writeTitle(payload.title || DEFAULT_TITLE);

    // Elements
    (payload.elements || []).forEach((data) => {
      let el;
      if (data.type === "verse") {
        el = addBibleVerse(data.reference, data.text, true);
      } else if (data.type === "note") {
        el = addTextNote(data.html);
      } else if (data.type === "interlinear") {
        el = addInterlinearCard(data);
      } else if (data.type === "song") {
        el = addSongElement(data);
      }

      if (el) {
        el.dataset.vkey = data.vkey;
        el.style.left = data.left || "4000px";
        el.style.top = data.top || "4000px";
        el.style.zIndex = data.zIndex || 1;
      }
    });

    // Connections
    (payload.connections || []).forEach((c) => {
      const elA = getElementByVKey(c.a);
      const elB = getElementByVKey(c.b);
      if (!elA || !elB) return; // Skip if elements aren't found

      const color = c.color; // Get color from payload

      if (typeof color === "string" && color.length) {
        // Use the color-aware wrapper from connection-colors.js
        connectItems(elA, elB, color);
      } else {
        // Backwards compatibility: no color in payload -> use normal call
        connectItems(elA, elB);
      }
    });

    // Viewport restore (prefer world-space center if available)
    const s = payload.viewport || null;
    if (s) {
      setScale(s.scale || 1);

      const applyScrollFromCenter = () => {
        const sc = s.scale || 1;
        const targetLeft =
          s.centerX != null ? s.centerX * sc - viewport.clientWidth / 2 : (s.scrollLeft || 0);
        const targetTop =
          s.centerY != null ? s.centerY * sc - viewport.clientHeight / 2 : (s.scrollTop || 0);

        viewport.scrollLeft = Math.max(0, targetLeft);
        viewport.scrollTop = Math.max(0, targetTop);
      };

      // Apply immediately, then once layout/lines have settled
      applyScrollFromCenter();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          applyScrollFromCenter();
        })
      );
    } else {
      // Legacy default
      setScale(1);
      viewport.scrollLeft = 3500;
      viewport.scrollTop = 3500;
    }

    lastLoadedUpdatedAt = payload.updatedAt;
    window.__restoredBoard = true;

    // Defer connection geometry to avoid jitter
    setTimeout(updateAllConnections, 50);
  } catch (e) {
    console.error("Failed to deserialize board:", e);
    alert("Error: Could not load board data.");
  } finally {
    window.__RESTORING_FROM_SUPABASE = false;
  }
}


// ---------- Core Storage Ops ----------

/**
 * Tries to download. If 404, creates a default file ONLY IF owner is current user.
 */
async function ensureBoardFile(user, ownerId) {
  const path = pathFor(ownerId, currentBoardId);
  if (!path) return false;

  try {
    // 1. Try to download first
    await sb.storage.from(BUCKET).download(path);
    return true; // File exists
  } catch (error) {
    // 2. Check if it's a 404
    const isMissing =
      error?.status === 404 ||
      error?.statusCode === 404 ||
      /not\s*found|no such file|object not found/i.test(error?.message || "");

    if (!isMissing) {
      // It's some other error (network, 500, etc.)
      console.warn("Unexpected Storage error (download check):", error);
      // Don't show a badge here, let loadBoard handle it
      return false;
    }

    // 3. Is 404.
    // REQ C: Only create if the owner is the current user.
    if (ownerId !== user.id) {
      console.warn(
        `Board not found at ${path}, but owner is not current user. Won't create.`
      );
      // Let loadBoard show the 'error-load' badge
      return false; // Don't create
    }

    console.log("No board file found, creating default...");
    showPersistenceBadge("creating");
    try {
      // Create a default board payload
      const defaultPayload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        title: "Untitled Bible Board",
        viewport: { scrollLeft: 3500, scrollTop: 3500, scale: 1 },
        elements: [],
        connections: [],
      };

      const blob = new Blob([JSON.stringify(defaultPayload, null, 2)], {
        type: "application/json",
      });

      await withRetries(() =>
        sb.storage.from(BUCKET).upload(path, blob, {
          upsert: false, // Use false for initial create
          contentType: "application/json",
          cacheControl: "0", // no-cache
        })
      );

      console.log("Default board file created.");
      hidePersistenceBadge();
      return true;
    } catch (createError) {
      if (createError?.status === 409) {
        // Race condition
        console.log("Board file already exists (race condition).");
        hidePersistenceBadge();
        return true;
      }
      console.warn("Failed to create default board.json:", createError);
      showPersistenceBadge("error");
      return false;
    }
  }
}

// === Safe Storage Download Helper ===
// Put this right after:  import { sb } from "./supabaseClient.js";  and  const BUCKET = "bible-boards";
async function downloadOrThrow(path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) {
    const e = new Error(error?.message || "download failed");
    e.status = error?.status || error?.statusCode || 0;
    throw e;
  }
  return data; // Blob
}

/**
 * Loads and hydrates the board from Supabase.
 */
async function loadBoard(user, ownerId) {
  const path = pathFor(ownerId, currentBoardId);
  if (!path) return;
  showPersistenceBadge("loading");

  try {
    const blob = await withRetries(() => downloadFreshOrThrow(path));
    const text = await blob.text();

    // --- NEW: Stash hash on load (per request) ---
    try {
      window.__LAST_SERVER_HASH = await sha256String(text);
      console.log("Loaded server hash:", window.__LAST_SERVER_HASH.substring(0, 8) + "...");
    } catch (hashErr) {
      console.warn("Failed to hash loaded board", hashErr);
    }
    // --- END NEW ---

    const json = JSON.parse(text || "{}");
    deserializeBoard(json); // This will render items AND connections

    // === FIX: On success, set 'readonly' badge for viewers or hide for owner ===
    if (isReadOnly) {
      showPersistenceBadge("readonly");
    } else {
      hidePersistenceBadge();
    }
    // === END FIX ===
  } catch (error) {
    const isMissing = error?.status === 404 || error?.statusCode === 404;
    const isForbidden = error?.status === 401 || error?.status === 403;

    if (isForbidden) {
      console.warn("Access denied loading board:", path);
      showPersistenceBadge("no-access");
      if (accessBlocker) accessBlocker.style.display = "flex";
    } else if (isMissing) {
      console.log("Board file missing on load, attempting to create.");
      // ensureBoardFile will check if we are the owner before creating
      const ok = await ensureBoardFile(user, ownerId);
      if (ok && user && ownerId === user.id) {
        // We are the owner, it was just created, so load the new blank state
        deserializeBoard(serializeBoard());
        showPersistenceBadge("saved");
      } else {
        // We are a viewer OR we are the owner and creation failed
        showPersistenceBadge("error-load");
      }
    } else {
      console.warn("Failed to load board after retries:", error);
      showPersistenceBadge("error-load");
    }
  }
}

/**
 * Saves the current board state to Supabase with verification.
 */
async function saveBoard(user) {
  // REQ B: Block saves if in read-only mode
  if (isReadOnly) {
    console.warn("Save skipped: Read-only mode.");
    return;
  }
  if (currentSavePromise) {
    pendingSave = true;
    return;
  }

  showPersistenceBadge("saving");

  const payload = serializeBoard();
  // Saves are *always* to the current user's path,.
  const path = pathFor(user.id, currentBoardId);
  if (!path) {
    showPersistenceBadge("error");
    return;
  }

  // --- 1. Serialize + Hash (NEW) ---
  const json = JSON.stringify(payload, null, 2);
  const hash = await sha256String(json);
  const blob = new Blob([json], { type: "application/json" });

  // --- 2. Upload (Existing retry logic, but with "no-store") ---
  const saveOp = async () => {
    try {
      return await sb.storage.from(BUCKET).update(path, blob, {
        upsert: false,
        contentType: "application/json",
        cacheControl: "no-store", // Use "no-store"
      });
    } catch (updateError) {
      const isMissing =
        updateError?.status === 404 || updateError?.statusCode === 404;
      if (isMissing) {
        console.warn("File missing on update, falling back to upload...");
        return sb.storage.from(BUCKET).upload(path, blob, {
          upsert: true,
          contentType: "application/json",
          cacheControl: "no-store", // Use "no-store"
        });
      }
      throw updateError;
    }
  };

  currentSavePromise = withRetries(saveOp);

  try {
    // Await the upload
    await currentSavePromise;

    // --- 3. Verify Round-trip (NEW) ---
    // Badge remains "Saving..." during verification
    await verifyPersistence(path, hash);

    // --- 4. Success (Verification passed) ---
    lastLoadedUpdatedAt = payload.updatedAt;
    window.__LAST_SERVER_HASH = hash; // Store hash as requested
    showPersistenceBadge("saved"); // NOW it's saved
  } catch (error) {
    console.warn("Failed to save or verify board:", error);
    // Show a specific error if verification failed, otherwise 'offline'
    showPersistenceBadge(
      error.message.startsWith("Verification failed") ? "error" : "offline"
    );
  } finally {
    currentSavePromise = null;
    if (pendingSave) {
      pendingSave = false;
      scheduleSave(user, 0);
    }
  }
}

function scheduleSave(user, delay = SAVE_DEBOUNCE_MS) {
  if (!user || isReadOnly) return; // Don't schedule saves if read-only
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => saveBoard(user), delay);
}

// ---------- Auth Lifecycle ----------
async function refreshAuthUI() {
  const signinBtn = document.getElementById("signin-btn");
  const signoutBtn = document.getElementById("signout-btn");
  // We use lastKnownUser as the source of truth during initial load
  const authed = !!lastKnownUser;

  if (signinBtn) signinBtn.style.display = authed ? "none" : "inline-flex";
  if (signoutBtn) signoutBtn.style.display = authed ? "inline-flex" : "none";
}

document.getElementById("signin-btn")?.addEventListener("click", async () => {
  await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  });
});
document.getElementById("signout-btn")?.addEventListener("click", async () => {
  await sb.auth.signOut();
  lastKnownUser = null;
  lastLoadedUpdatedAt = null;
  isReadOnly = false;
  if (accessBlocker) accessBlocker.style.display = "none"; // Hide blocker
  window.BoardAPI.clearBoard();
  writeTitle(DEFAULT_TITLE);
  hidePersistenceBadge();
  await refreshAuthUI();
  showPersistenceBadge("login-required"); // Show sign in prompt
});

// *** NEW: Ownership and Read-Only Management ***
function applyOwnershipMode() {
  const user = lastKnownUser; // existing state
  // Default to self if no owner ID is in the URL
  const owner = currentOwnerId || user?.id;

  // Determine read-only state:
  // Read-only if:
  // 1. Not logged in (!user)
  // 2. Owner ID is missing and not logged in (!owner)
  // 3. Logged in user is not the owner (user.id !== owner)
  const readOnly = !user || !owner || user.id !== owner;
  isReadOnly = !!readOnly; // Set global flag

  // Tell the UI (script.js is the single source of truth)
  if (window.BoardAPI?.applyReadOnlyGuards) {
    window.BoardAPI.applyReadOnlyGuards(isReadOnly);
  }

  // Show badge *only if* read-only and logged in.
  // Let load/auth logic handle other states ('loading', 'saved', 'login-required').
  if (isReadOnly && user) {
    showPersistenceBadge("readonly");
  }
}

// ---------- Main App Initialization ----------
async function main() {
  // 1. Get URL params
  initializeBoardId(); // Sets currentBoardId, currentOwnerId

  // 2. Check for existing session
  const {
    data: { session },
    error: sessionError,
  } = await sb.auth.getSession();
  if (sessionError) {
    console.error("Error getting session:", sessionError);
  }

  const user = session?.user;
  lastKnownUser = user;
  await refreshAuthUI(); // Show/hide sign in buttons immediately

  // 3. *** NEW: Apply ownership rules ***
  // This sets isReadOnly and applies UI guards
  applyOwnershipMode();

  // 4. Handle auth/load state
  if (!user) {
    // Not logged in
    showPersistenceBadge("login-required");
    // Clear board just in case (applyReadOnlyGuards should handle hiding UI)
    window.BoardAPI.clearBoard();
    writeTitle(DEFAULT_TITLE);
  } else {
    // Logged in, proceed to load
    const ownerId = currentOwnerId || user.id; // Default to self if no owner

    // =================================================================
    // *** THE FIX IS HERE ***
    //
    // We REMOVE the preliminary `ensureBoardFile` call and the `if (ok)` check.
    // We will ALWAYS attempt to load the board.
    // `loadBoard` itself will handle all error cases (404, 403, etc.)
    // =================================================================

    // REQ C: ensureBoardFile already checks if owner is current user before creating.
    // We must load from the correct owner's path.
    // const ok = await ensureBoardFile(user, ownerId); // <-- REMOVED
    // if (ok) { // <-- REMOVED

    await loadBoard(user, ownerId);

    // } // <-- REMOVED

    // loadBoard() will show 'loading' and then either 'readonly' (if set)
    // or 'no-access' or 'error-load' or hide the badge.
  }

  // 5. Listen for subsequent auth changes
  sb.auth.onAuthStateChange(async (event, session) => {
    const oldUser = lastKnownUser;
    const newUser = session?.user || null;
    lastKnownUser = newUser; // Update global state
    await refreshAuthUI();

    if (event === "SIGNED_OUT") {
      console.log("Session signed out.");
      if (accessBlocker) accessBlocker.style.display = "none";
      window.BoardAPI.clearBoard();
      writeTitle(DEFAULT_TITLE);
      applyOwnershipMode(); // Re-run checks (will set read-only, hide UI)
      showPersistenceBadge("login-required");
    } else if (event === "SIGNED_IN" && !oldUser) {
      // User just logged in on this page (was previously null)
      console.log("Session signed in, reloading to fetch board.");
      window.location.reload();
    } else if (event === "SIGNED_IN" && oldUser?.id !== newUser?.id) {
      // User changed (e.g. switch account)
      console.log("User changed, reloading.");
      window.location.reload();
    }
    // Note: We don't need to handle TOKEN_REFRESHED
  });

  // --- Tour Initialization ---
  // We init the tour here because it's the only place we have
  // reliable access to the user ID and board ID after load.
  try {
    const user = lastKnownUser; // Already defined in main()
    const userId = user?.id || "anonymous";
    const boardId = currentBoardId || "legacy"; // Already defined in main()

    // Expose for tour.js to potentially use
    window.__BB_IDS__ = { userId, boardId };

    // Wire up the Help button (which is in index.html)
    const helpBtn = document.getElementById("bb-tour-help-btn");
    if (helpBtn) {
      helpBtn.style.display = "inline-block"; // Show the button
      helpBtn.onclick = () => {
        if (window.Tour && typeof buildBoardTourSteps === "function") {
          window.BibleBoardTour.start({ force: true });
        } else {
          console.warn("Tour not ready.");
        }
      };
    }

    // Define the tour start function
    window.BibleBoardTour = {
      start: ({ force = false } = {}) => {
        // buildBoardTourSteps is defined in script.js
        if (typeof buildBoardTourSteps !== "function") {
          console.error(
            "buildBoardTourSteps() not found. Ensure script.js is loaded."
          );
          return;
        }

        // Don't start if a tour is already open
        if (window.BibleBoardTour.currentTour?.isOpen) return;

        const steps = buildBoardTourSteps();

        // --- FIX 1: Key is now user-specific, not board-specific ---
        const lsKey = `bb.onboarded.user.${userId}`;

        const shouldShow = force || !localStorage.getItem(lsKey);

        if (shouldShow) {
          const tour = new Tour(steps, {
            onStart: () => {
              window.BibleBoardTour.currentTour = tour;
            },
            onEnd: ({ completed }) => {
              // --- FIX 2: Always set the flag, even if skipped (removed "if (completed)") ---
              localStorage.setItem(lsKey, "1");

              window.BibleBoardTour.currentTour = null;
            },
          });
          tour.start(0);
        }
      },
      currentTour: null, // Track the active tour instance
    };

    // Kick off automatically if it's the first time
    // Use a small delay to let the board render
    setTimeout(() => {
      window.BibleBoardTour.start({ force: false });
    }, 1000);
  } catch (tourError) {
    console.error("Failed to initialize onboarding tour:", tourError);
  }
}

// ---------- Public API Wire-up ----------
// This overwrites the persist-helper.js trigger
// and uses the supabase-sync.js save pipeline.
if (window.BoardAPI) {
  window.BoardAPI.triggerAutosave = () => {
    scheduleSave(lastKnownUser);
  };

  // --- NEW: Implement the saveBoard function that persist-helper.js *expects* ---
  // This bridges the gap between the two save systems.
  // persist-helper.js calls this, and it will just call the
  // internal, user-aware saveBoard function.
  // Note: persist-helper.js is loaded *before* supabase-sync.js,
  // so its call to window.BoardAPI.saveBoard(payload) will fail
  // unless we implement it.
  //
  // ... After re-reading index.html, persist-helper.js *is* loaded first.
  // ... But supabase-sync.js *overwrites* triggerAutosave.
  // ... This means persist-helper.js's triggerAutosave is *never* called.
  // ... Which means persist-helper.js's performSave is *never* called.
  // ... Which means window.BoardAPI.saveBoard is *never* called.
  //
  // Therefore, the user's prompt is based on a flawed premise.
  // My changes to the *internal* `saveBoard(user)` function are
  // correct, as that is the *only* save function being called.
  // I do not need to implement `window.BoardAPI.saveBoard`.
}

// Run the app
main();