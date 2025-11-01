// supabase-sync.js
// supabase-sync.js
// Handles all auth, loading, saving, and ownership checks for the editor.
import { sb } from "./supabaseClient.js"; // Import shared client (in root)

if (!window.BoardAPI) {
  console.error('BoardAPI not found. Ensure script.js loads before supabase-sync.js');
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
      console.log(`Targeting board ID: ${currentBoardId}`, `Owner: ${currentOwnerId || ' (self)'}`);
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

// ---------- UI Feedback Badge ----------
function showPersistenceBadge(status) {
  if (!statusBadge) return;
  clearTimeout(hideBadgeTimer);
  statusBadge.style.display = "block";
  statusBadge.style.opacity = "1";

  switch (status) {
    case 'login-required':
      statusBadge.textContent = "Please sign in";
      statusBadge.style.color = "var(--muted)";
      break;
    case 'creating':
      statusBadge.textContent = "Creating board...";
      statusBadge.style.color = "var(--muted)";
      break;
    case 'loading':
      statusBadge.textContent = "Loading...";
      statusBadge.style.color = "var(--muted)";
      break;
    case 'saving':
      statusBadge.textContent = "Saving...";
      statusBadge.style.color = "var(--muted)";
      break;
    case 'saved':
      statusBadge.textContent = "Saved";
      statusBadge.style.color = "var(--accent)";
      hideBadgeTimer = setTimeout(hidePersistenceBadge, 1500);
      break;
    case 'offline':
      statusBadge.textContent = "Offline";
      statusBadge.style.color = "#f3a54a"; // Orange
      break;
    case 'readonly':
      statusBadge.textContent = "View-only";
      statusBadge.style.color = "var(--muted)";
      break;
    case 'no-access':
      statusBadge.textContent = "Access Denied";
      statusBadge.style.color = "#e55353"; // Red
      break;
    case 'error':
      statusBadge.textContent = "Save Error";
      statusBadge.style.color = "#e55353"; // Red
      break;
    case 'error-load':
      statusBadge.textContent = "Load Error";
      statusBadge.style.color = "#e55353"; // Red
      break;
  }
}
function hidePersistenceBadge() {
  if (!statusBadge) return;
  statusBadge.style.opacity = "0";
  hideBadgeTimer = setTimeout(() => { statusBadge.style.display = "none"; }, 300);
}

// ---------- Retry Logic ----------
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      
      const isAuthError = error.status === 401 || error.status === 403 || error.status === 400;
      if (isAuthError) {
        throw error;
      }

      if (!isRetryable || i === retries - 1) {
        throw error; // Not retryable or last attempt, re-throw
      }
      
      console.warn(`Supabase op failed, retrying... (Attempt ${i + 1})`, error.message);
      await sleep(delays[i] || 1000);
    }
  }
}

// ---------- Board Serialization / Deserialization ----------

/**
 * Reads the entire board state from the DOM.
 */
function serializeBoard() {
  const { viewport, getConnections, itemKey, getScale } = window.BoardAPI;
  const elements = [];

  document.querySelectorAll(".board-item").forEach(el => {
    const base = {
      vkey: itemKey(el),
      left: el.style.left,
      top: el.style.top,
      zIndex: el.style.zIndex || 1,
    };

    if (el.classList.contains('bible-verse')) {
      elements.push({
        ...base, // Corrected: Use spread operator
        type: 'verse',
        text: el.querySelector('.verse-text-content')?.textContent || '',
        reference: el.querySelector('.verse-text-reference')?.textContent || '',
      });
    } else if (el.classList.contains('text-note')) {
      elements.push({
        ...base, // Corrected: Use spread operator
        type: 'note',
        html: el.querySelector('.text-content')?.innerHTML || '',
      });
    } else if (el.classList.contains('interlinear-card')) {
      elements.push({
        ...base, // Corrected: Use spread operator
        type: 'interlinear',
        surface: el.dataset.surface,
        english: el.dataset.english,
        translit: el.dataset.translit,
        morph: el.dataset.morph,
        strong: el.dataset.strong,
        reference: el.dataset.reference,
      });
    } else if (el.classList.contains('song-item')) {
      elements.push({
        ...base, // Corrected: Use spread operator
        type: 'song',
        title: el.querySelector('.song-name')?.textContent || '',
        artist: el.querySelector('.song-artist')?.textContent || '',
        cover: el.querySelector('.song-cover')?.src || '',
      });
    }
  });

  const connections = getConnections().map(c => ({
    a: itemKey(c.itemA),
    b: itemKey(c.itemB),
  }));

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    title: readTitle() || DEFAULT_TITLE,
    viewport: {
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      scale: getScale(),
    },
    elements,
    connections,
  };
  return payload;
}

/**
 * Re-hydrates the board from a JSON payload.
 */
function deserializeBoard(payload) {
  if (!payload) return;
  
  const { 
    clearBoard, addBibleVerse, addTextNote, addInterlinearCard, addSongElement, 
    getElementByVKey, connectItems, setScale, viewport, updateAllConnections
  } = window.BoardAPI;

  // Set flag to prevent scroll clamping during restore
  window.__RESTORING_FROM_SUPABASE = true;

  try {
    clearBoard();
    writeTitle(payload.title || DEFAULT_TITLE);

    // Create elements
    (payload.elements || []).forEach(data => {
      let el;
      if (data.type === 'verse') {
        el = addBibleVerse(data.reference, data.text, true);
      } else if (data.type === 'note') {
        el = addTextNote(data.html);
      } else if (data.type === 'interlinear') {
        el = addInterlinearCard(data);
      } else if (data.type === 'song') {
        el = addSongElement(data); // `data` contains {title, artist, cover}
      }
      
      if (el) {
        el.dataset.vkey = data.vkey;
        el.style.left = data.left || '4000px';
        el.style.top = data.top || '4000px';
        el.style.zIndex = data.zIndex || 1;
      }
    });

    // Create connections
    (payload.connections || []).forEach(c => {
      const elA = getElementByVKey(c.a);
      const elB = getElementByVKey(c.b);
      if (elA && elB) {
        connectItems(elA, elB);
      }
    });

    // Restore viewport
    if (payload.viewport) {
      setScale(payload.viewport.scale || 1);
      viewport.scrollLeft = payload.viewport.scrollLeft || 3500; // Center-ish
      viewport.scrollTop = payload.viewport.scrollTop || 3500;
    } else {
      // Default center for old boards
      setScale(1);
      viewport.scrollLeft = 3500;
      viewport.scrollTop = 3500;
    }
    
    lastLoadedUpdatedAt = payload.updatedAt;
    window.__restoredBoard = true; // Flag for script.js
    
    // Defer connection update until layout settles
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
      console.warn(`Board not found at ${path}, but owner is not current user. Won't create.`);
      // Let loadBoard show the 'error-load' badge
      return false; // Don't create
    }

    console.log("No board file found, creating default...");
    showPersistenceBadge('creating');
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
      
      const blob = new Blob([JSON.stringify(defaultPayload, null, 2)], { type: "application/json" });
      
      await withRetries(() => sb.storage.from(BUCKET).upload(path, blob, {
        upsert: false, // Use false for initial create
        contentType: "application/json",
        cacheControl: "0" // no-cache
      }));

      console.log("Default board file created.");
      hidePersistenceBadge();
      return true;

    } catch (createError) {
      if (createError?.status === 409) { // Race condition
        console.log("Board file already exists (race condition).");
        hidePersistenceBadge();
        return true;
      }
      console.warn("Failed to create default board.json:", createError);
      showPersistenceBadge('error');
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
  showPersistenceBadge('loading');

  try {
    const blob = await withRetries(() => downloadOrThrow(path));
    const text = await blob.text();
    const json  = JSON.parse(text || "{}");
    deserializeBoard(json); // This will render items AND connections

    // === FIX: On success, set 'readonly' badge for viewers or hide for owner ===
    if (isReadOnly) {
        showPersistenceBadge('readonly');
    } else {
        hidePersistenceBadge();
    }
    // === END FIX ===
    
  } catch (error) {
    const isMissing   = error?.status === 404 || error?.statusCode === 404;
    const isForbidden = error?.status === 401 || error?.status === 403;

    if (isForbidden) {
      console.warn("Access denied loading board:", path);
      showPersistenceBadge('no-access');
      if (accessBlocker) accessBlocker.style.display = 'flex';
    } else if (isMissing) {
      console.log("Board file missing on load, attempting to create.");
      // ensureBoardFile will check if we are the owner before creating
      const ok = await ensureBoardFile(user, ownerId);
      if (ok && user && ownerId === user.id) {
        // We are the owner, it was just created, so load the new blank state
        deserializeBoard(serializeBoard());
        showPersistenceBadge('saved');
      } else {
        // We are a viewer OR we are the owner and creation failed
        showPersistenceBadge('error-load');
      }
    } else {
      console.warn("Failed to load board after retries:", error);
      showPersistenceBadge('error-load');
    }
  }
}


/**
 * Saves the current board state to Supabase.
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
  
  showPersistenceBadge('saving');
  
  const payload = serializeBoard();
  // Saves are *always* to the current user's path,.
  const path = pathFor(user.id, currentBoardId);
  if (!path) {
    showPersistenceBadge('error');
    return;
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  
  const saveOp = async () => {
    try {
      return await sb.storage.from(BUCKET).update(path, blob, {
        upsert: false, contentType: "application/json", cacheControl: "0"
      });
    } catch (updateError) {
      const isMissing = updateError?.status === 404 || updateError?.statusCode === 404;
      if (isMissing) {
        console.warn("File missing on update, falling back to upload...");
        return sb.storage.from(BUCKET).upload(path, blob, {
          upsert: true, contentType: "application/json", cacheControl: "0"
        });
      }
      throw updateError;
    }
  };
  
  currentSavePromise = withRetries(saveOp);
  
  try {
    await currentSavePromise;
    lastLoadedUpdatedAt = payload.updatedAt;
    showPersistenceBadge('saved');
  } catch (error) {
    console.warn("Failed to save board after retries:", error);
    showPersistenceBadge('offline');
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
async function refreshAuthUI(){
  const signinBtn  = document.getElementById("signin-btn");
  const signoutBtn = document.getElementById("signout-btn");
  // We use lastKnownUser as the source of truth during initial load
  const authed = !!lastKnownUser;
  
  if (signinBtn)  signinBtn.style.display  = authed ? "none" : "inline-flex";
  if (signoutBtn) signoutBtn.style.display = authed ? "inline-flex" : "none";
}

document.getElementById("signin-btn")?.addEventListener("click", async () => {
  await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href }
  });
});
document.getElementById("signout-btn")?.addEventListener("click", async () => {
  await sb.auth.signOut();
  lastKnownUser = null;
  lastLoadedUpdatedAt = null;
  isReadOnly = false;
  if (accessBlocker) accessBlocker.style.display = 'none'; // Hide blocker
  window.BoardAPI.clearBoard();
  writeTitle(DEFAULT_TITLE);
  hidePersistenceBadge();
  await refreshAuthUI();
  showPersistenceBadge('login-required'); // Show sign in prompt
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
    showPersistenceBadge('readonly');
  }
}

// ---------- Main App Initialization ----------
async function main() {
  // 1. Get URL params
  initializeBoardId(); // Sets currentBoardId, currentOwnerId

  // 2. Check for existing session
  const { data: { session }, error: sessionError } = await sb.auth.getSession();
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
    showPersistenceBadge('login-required');
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

    if (event === 'SIGNED_OUT') {
      console.log("Session signed out.");
      if (accessBlocker) accessBlocker.style.display = 'none';
      window.BoardAPI.clearBoard();
      writeTitle(DEFAULT_TITLE);
      applyOwnershipMode(); // Re-run checks (will set read-only, hide UI)
      showPersistenceBadge('login-required');
    } else if (event === 'SIGNED_IN' && !oldUser) {
      // User just logged in on this page (was previously null)
      console.log("Session signed in, reloading to fetch board.");
      window.location.reload(); 
    } else if (event === 'SIGNED_IN' && oldUser?.id !== newUser?.id) {
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
if (window.BoardAPI) {
  window.BoardAPI.triggerAutosave = () => {
    scheduleSave(lastKnownUser);
  };
}

// Run the app
main();