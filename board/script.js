/*
 * ================== PERFORMANCE OPTIMIZATIONS V2 ==================
 * This file has been updated to improve search performance.
 *
 * 1.  LRU Caching: Replaced `verseCache` and `bibleSearchCache` (Maps)
 * with an `LruCache` class (CACHE_SIZE = 200) to prevent
 * memory leaks during long sessions.
 * 2.  Input Debouncing: Added a 300ms debounce (`DEBOUNCE_MS`) to the
 * search bar's 'input' event to provide type-ahead search
 * without overwhelming the network.
 * 3.  Abort Controller: Enhanced `globalSearchController` to abort
 * in-flight searches (topic, verse, song) on new input or submit,
 * preventing race conditions.
 * 4.  Progressive Rendering: `searchForQuery` no longer uses
 * `Promise.all`. It now renders UI in stages:
 * - Skeleton/Loader (Immediate)
 * - Song results (As soon as they arrive)
 * - Verse references (As soon as they arrive)
 * - Verse *text* (Streamed in via `fetchAndStreamVerseTexts`)
 * 5.  Batching & Streaming: Verse texts are fetched in small batches
 * (BATCH_SIZE = 3) and injected into the DOM using
 * `requestAnimationFrame` to prevent layout thrash.
 * 6.  Prefetching: Uses `requestIdleCallback` to prefetch adjacent
 * verses (`prefetchAdjacentVerses`) after a verse is added,
 * warming the cache for likely next steps.
 * 7.  Virtualization: **Skipped.** This conflicts with the "no
 * CSS/HTML changes" guardrail, as it requires fundamental
 * changes to DOM structure and styling (e.g., position: absolute).
 * ================================================================
 */

// ==================== Performance Constants ====================
const CACHE_SIZE = 200; // Max items for LRU caches
const DEBOUNCE_MS = 300; // Wait time for type-ahead search
const BATCH_SIZE = 3; // Verse texts to fetch in parallel
const INITIAL_VISIBLE_COUNT = 3; // show up to 4 fully-loaded verses/songs
const SEARCH_RESULT_LIMIT = 25; // Items to fetch for virt... (was 5)
const LOAD_MORE_CHUNK = 5; // How many verses/songs per "load more" click

// Disable all type-ahead behavior
const TYPE_AHEAD_ENABLED = false;

// --- NEW: Board Info for Sharing ---
const params = new URLSearchParams(location.search);
const BOARD_ID = params.get("board");
const OWNER_UID = params.get("owner");
function getShareUrl() {
  const url = new URL(location.href);
  url.pathname = "/board/index.html"; // canonical
  url.searchParams.set("board", BOARD_ID);
  url.searchParams.set("owner", OWNER_UID);
  return url.toString();
}

// --- END NEW ---

// ==================== Performance Helpers ====================

/**
 * Performance instrumentation helper.
 */
let perfTimer = 0;
function startPerfTimer() {
  perfTimer = performance.now();
}
function logPerf(label) {
  const now = performance.now();
  console.log(`[Perf] ${label}: ${Math.round(now - perfTimer)}ms`);
  perfTimer = now;
}

/**
 * A simple LRU (Least Recently Used) cache wrapper for the Map API.
 */
class LruCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  /**
   * Gets a value, moving it to the "front" (most recent).
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    const val = this.cache.get(key);
    if (val) {
      // Move to front
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  /**
   * Sets a value, evicting the oldest if at capacity.
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    if (this.cache.has(key)) {
      // Just update and move to front
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in map iterator)
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  /**
   * Checks for a key without updating its recency.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key);
  }
}

// ==================== Bible Book API Codes ====================
// ... (bibleBookCodes object unchanged) ...
const bibleBookCodes = {
  Genesis: "GEN",
  Exodus: "EXO",
  Leviticus: "LEV",
  Numbers: "NUM",
  Deuteronomy: "DEU",
  Joshua: "JOS",
  Judges: "JDG",
  Ruth: "RUT",
  "1 Samuel": "1SA",
  "2 Samuel": "2SA",
  "1 Kings": "1KI",
  "2 Kings": "2KI",
  "1 Chronicles": "1CH",
  "2 Chronicles": "2CH",
  Ezra: "EZR",
  Nehemiah: "NEH",
  Esther: "EST",
  Job: "JOB",
  Psalms: "PSA",
  Proverbs: "PRO",
  Ecclesiastes: "ECC",
  "Song of Solomon": "SNG",
  Isaiah: "ISA",
  Jeremiah: "JER",
  Lamentations: "LAM",
  Ezekiel: "EZK",
  Daniel: "DAN",
  Hosea: "HOS",
  Joel: "JOL",
  Amos: "AMO",
  Obadiah: "OBA",
  Jonah: "JON",
  Micah: "MIC",
  Nahum: "NAM",
  Habakkuk: "HAB",
  Zephaniah: "ZEP",
  Haggai: "HAG",
  Zechariah: "ZEC",
  Malachi: "MAL",
  Matthew: "MAT",
  Mark: "MRK",
  Luke: "LUK",
  John: "JHN",
  Acts: "ACT",
  Romans: "ROM",
  "1 Corinthians": "1CO",
  "2 Corinthians": "2CO",
  Galatians: "GAL",
  Ephesians: "EPH",
  Philippians: "PHP",
  Colossians: "COL",
  "1 Thessalonians": "1TH",
  "2 Thessalonians": "2TH",
  "1 Timothy": "1TI",
  "2 Timothy": "2TI",
  Titus: "TIT",
  Philemon: "PHM",
  Hebrews: "HEB",
  James: "JAS",
  "1 Peter": "1PE",
  "2 Peter": "2PE",
  "1 John": "1JN",
  "2 John": "2JN",
  "3 John": "3JN",
  Jude: "JUD",
  Revelation: "REV",
};

// ==================== OPTIMIZATION: Performance Helpers ====================
// ... (LruCache definitions and throttleRAF unchanged) ...
/**
 * OPTIMIZATION: Use LRU cache to prevent memory leaks.
 */
const verseCache = new LruCache(CACHE_SIZE);

/**
 * OPTIMIZATION: Shared AbortController for all search queries.
 * This is reset in `searchForQuery`.
 */
let globalSearchController = null;

/**
 * OPTIMIZATION: requestAnimationFrame-based throttle.
 * (Existing)
 */
function throttleRAF(func) {
  let rafId = null;
  let latestArgs = null;

  const throttled = function (...args) {
    latestArgs = args;
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        func.apply(this, latestArgs);
        rafId = null;
        latestArgs = null;
      });
    }
  };

  // Optional: Add a way to cancel any pending frame
  throttled.cancel = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  return throttled;
}

// ==================== Central Autosave Trigger ====================
/**
 * Central handler for all board mutations.
 * (Existing)
 */
function onBoardMutated(reason) {
  // --- NEW: READ-ONLY GUARD ---
  if (window.__readOnly) {
    // console.debug("Save skipped (read-only):", reason);
    return;
  }
  // --- END NEW ---

  if (window.__RESTORING_FROM_SUPABASE) {
    // console.debug("Save skipped (restoring):", reason);
    return;
  }
  // console.debug("Mutation trigger:", reason);
  window.BoardAPI?.triggerAutosave?.(reason);
}

// ==================== NEW: Robust CORS Fetch Helper ====================
// ... (FETCH_STRATEGIES and safeFetchWithFallbacks unchanged) ...
/**
 * (Existing)
 */
const FETCH_STRATEGIES = [
  // Strategy 1: AllOrigins (CORS-friendly proxy)
  async (url, signal) =>
    fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
      signal,
      credentials: "omit",
    }),

  // Strategy 2: CodeTabs (Another CORS proxy)
  async (url, signal) =>
    fetch(`https://api.codetabs.com/v1/proxy?quest=${url}`, {
      signal,
      credentials: "omit",
    }),

  // Strategy 3: thingproxy (CORS-friendly proxy, often slow but a good final backup)
  async (url, signal) =>
    fetch(`https://thingproxy.freeboard.io/fetch/${url}`, {
      signal,
      credentials: "omit",
    }),

  // Strategy 4: Direct Fetch (Original attempt, may fail on 127.0.0.1 but work in production)
  async (url, signal) =>
    fetch(url, { mode: "cors", signal, credentials: "omit" }),
];

/**
 * (Existing)
 */
async function safeFetchWithFallbacks(url, signal) {
  let lastError = null;

  for (const [index, fetchStrategy] of FETCH_STRATEGIES.entries()) {
    if (signal?.aborted) throw new Error("Fetch aborted by user");

    try {
      // Set a reasonable timeout for each attempt (e.g., 7 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(new Error("Fetch timeout")),
        7000
      );

      // Listen for the main signal to abort this specific attempt
      const abortListener = () =>
        controller.abort(new Error("Fetch aborted by user"));
      signal.addEventListener("abort", abortListener, { once: true });

      const resp = await fetchStrategy(url, controller.signal);

      // Cleanup
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", abortListener);

      if (!resp.ok) {
        throw new Error(
          `Strategy ${index + 1} failed with status: ${resp.status}`
        );
      }

      console.log(
        `Fetch strategy ${index + 1} succeeded for: ${url.substring(0, 100)}...`
      );
      return resp; // Success!
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err; // Re-throw the user's abort immediately
      console.warn(`Fetch strategy ${index + 1} failed:`, err.message);
      // Continue to the next strategy
    }
  }

  // If all strategies failed
  throw lastError || new Error("All fetch strategies failed");
}

// ==================== NEW: Version Picker Helpers ====================
function getSelectedVersion() {
  const el = document.getElementById("version-select");
  return (el && el.value) || "KJV"; // Fallback
}

// Function to set the picker value and save to localStorage
function setVersion(version) {
  const el = document.getElementById("version-select");
  if (el && version) {
    // Find the option that matches
    const opt = Array.from(el.options).find(
      (o) => o.value.toUpperCase() === version.toUpperCase()
    );
    if (opt) {
      el.value = opt.value;
      localStorage.setItem("bb:lastVersion", el.value);
    }
  }
}

(function initVersionPicker() {
  document
    .getElementById("version-select")
    ?.addEventListener("change", () => {
      const newVersion = getSelectedVersion();
      localStorage.setItem("bb:lastVersion", newVersion);
      // Trigger a save to update board settings
      onBoardMutated("version_change");
    });
})();

// ==================== Fetch Verse Text (KJV) ====================
// ... (fetchVerseText unchanged) ...
/**
 * (Existing logic, now uses LRU cache)
 */
async function fetchVerseText(book, chapter, verse, signal, version = "KJV") {
  const code = bibleBookCodes[book] || book;
  const apiUrl = `https://bible-api-5jrz.onrender.com/verse/${encodeURIComponent(
    version
  )}/${encodeURIComponent(code)}/${chapter}/${verse}`;

  // OPTIMIZATION: Use LRU cache
  const cacheKey = `${version}:${code}:${chapter}:${verse}`;
  const cached = verseCache.get(cacheKey); // .get() updates recency
  if (cached) {
    return cached;
  }

  // OPTIMIZATION: Check signal before fetching
  if (signal?.aborted) throw new Error("Fetch aborted");

  try {
    const resp = await safeFetchWithFallbacks(apiUrl, signal);
    const data = await resp.json();

    const text =
      data.text ||
      (data.verses
        ? data.verses.map((v) => v.text).join(" ")
        : "Verse not found.");
    verseCache.set(cacheKey, text); // Store in cache
    return text;
  } catch (err) {
    if (signal?.aborted) {
      console.log("Verse fetch aborted.");
      // Re-throw abort so searchForQuery() can catch it and stop processing
      throw err;
    }

    console.error("❌ Error fetching verse (all fallbacks failed):", err);
    return "Verse temporarily unavailable."; // Graceful error
  }
}

// ==================== NEW: Bible Search API Helpers ====================
// ... (fetchBibleSearchResults, parseReferenceToParts, fetchVersesForReferences unchanged) ...
// ---- Bible Search API (query -> references) ----
/**
 * OPTIMIZATION: Use LRU cache
 */
const bibleSearchCache = new LruCache(CACHE_SIZE);
let activeBibleSearchController = null; // Note: This is separate from globalSearchController
async function fetchBibleSearchResults(query, limit = 5, signal) {
  if (!query) return [];
  const key = `${query.toLowerCase()}::${limit}`;
  const cached = bibleSearchCache.get(key); // .get() updates recency
  if (cached) return cached;

  // Use the provided signal from searchForQuery
  const effSignal = signal;

  const url = `https://bible-search-api-huro.onrender.com/search?q=${encodeURIComponent(
    query
  )}&limit=${limit}`;

  try {
    // IMPORTANT: use the same multi-proxy CORS bypass helper
    const resp = await safeFetchWithFallbacks(url, effSignal);
    const data = await resp.json();
    const refs = Array.isArray(data?.references) ? data.references : [];
    bibleSearchCache.set(key, refs);
    return refs;
  } catch (e) {
    if (effSignal?.aborted) return [];
    console.error("Search API error:", e);
    return [];
  }
}

// ---- Parse Reference String to Parts ----
function parseReferenceToParts(reference) {
  if (!reference) return null;
  // split from the RIGHT to capture last "chapter:verse"
  const lastSpace = reference.lastIndexOf(" ");
  if (lastSpace === -1) return null;
  const book = reference.slice(0, lastSpace).trim();
  const chapVerse = reference.slice(lastSpace + 1).trim();
  const [chapterStr, verseStr] = chapVerse.split(":");
  const chapter = Number(chapterStr);
  const verse = Number(verseStr);
  if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) return null;
  return { book, chapter, verse };
}

// ---- Batch Fetch Verse Texts ----
/**
 * (No longer used by searchForQuery, but kept for potential future use)
 * `fetchAndStreamVerseTexts` is now the primary method for progressive rendering.
 */
async function fetchVersesForReferences(refs, { batchSize = 4, signal } = {}) {
  const results = [];
  for (let i = 0; i < refs.length; i += batchSize) {
    if (signal?.aborted) break; // Check abort before each batch
    const batch = refs.slice(i, i + batchSize);
    const fetched = await Promise.all(
      batch.map(async (ref) => {
        if (signal?.aborted) return { reference: ref, text: "" }; // Check abort before each fetch
        const parts = parseReferenceToParts(ref);
        if (!parts) return { reference: ref, text: "Verse not found." };
        try {
          const text = await fetchVerseText(
            parts.book,
            parts.chapter,
            parts.verse,
            signal,
            // This function is old, but if used, pass the global version
            // Note: This is NOT the primary search path anymore.
            getSelectedVersion()
          );
          return { reference: ref, text };
        } catch (e) {
          if (signal?.aborted) return { reference: ref, text: "" };
          return { reference: ref, text: "Error fetching verse." };
        }
      })
    );
    results.push(...fetched.filter((r) => r.text !== "")); // Don't add aborted results
  }
  return results;
}

// ==================== DOM Refs ====================
// ... (All DOM refs unchanged) ...
const viewport = document.querySelector(".viewport");
const workspace = document.querySelector("#workspace");
const mainContentContainer = document.getElementById("main-content-container");
const searchQueryContainer = document.getElementById("search-query-container");
const searchQuery = document.getElementById("search-query");
const searchBar = document.getElementById("search-bar");
const didYouMeanText = document.getElementById("did-you-mean-text");
const searchQueryFullContainer = document.getElementById(
  "search-query-full-container"
);
const loader = document.getElementById("loader");

// SONGS
const songsHeader = document.getElementById("search-query-songs-text");
const songsContainer = document.getElementById("search-query-song-container");

// Global action buttons
const connectBtn = document.getElementById("mobile-action-button");
const textBtn = document.getElementById("text-action-button");
const deleteBtn = document.getElementById("delete-action-button");

// Interlinear button + panel refs
const interlinearBtn = document.getElementById("interlinear-action-button");
const interPanel = document.getElementById("interlinear-panel");
const interClose = document.getElementById("interlinear-close");
const interSubtitle = document.getElementById("interlinear-subtitle");
const interList = document.getElementById("interlinear-list");
const interLoader = document.getElementById("interlinear-loader");
const interEmpty = document.getElementById("interlinear-empty");
const interError = document.getElementById("interlinear-error");

// Ensure SVG exists
let svg = document.getElementById("connections");
if (!svg) {
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "connections";
  svg.classList.add("connections");
  svg.setAttribute("width", "8000");
  svg.setAttribute("height", "8000");
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.zIndex = "5";
  workspace.prepend(svg);
}

// --- Viewport bars: DOM bootstrap ---
let viewbarX = document.getElementById("viewbar-x");
let viewbarY = document.getElementById("viewbar-y");
if (!viewbarX) {
  viewbarX = document.createElement("div");
  viewbarX.id = "viewbar-x";
  const thumbX = document.createElement("div");
  thumbX.className = "vb-thumb";
  viewbarX.appendChild(thumbX);
  mainContentContainer.appendChild(viewbarX);
}
if (!viewbarY) {
  viewbarY = document.createElement("div");
  viewbarY.id = "viewbar-y";
  const thumbY = document.createElement("div");
  thumbY.className = "vb-thumb";
  viewbarY.appendChild(thumbY);
  mainContentContainer.appendChild(viewbarY);
}

// ==================== Layout State ====================
// ... (applyLayout unchanged) ...
let searchDrawerOpen = false; // 300px
let interlinearOpen = false; // 340px
let interlinearInFlight = null; // AbortController for in-flight fetch
let interlinearSeq = 0; // Sequence number to prevent race conditions

// OPTIMIZATION: Throttled version of updateAllConnections
const throttledUpdateAllConnections = throttleRAF(updateAllConnections);
const throttledUpdateViewportBars = throttleRAF(updateViewportBars);

function updateViewportBars() {
  if (!viewport || !workspace) return;

  // Content extents follow clampScroll(): width/height are scaled by `scale`
  const contentW = workspace.offsetWidth * (typeof scale === "number" ? scale : 1);
  const contentH = workspace.offsetHeight * (typeof scale === "number" ? scale : 1);

  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;

  const maxLeft = Math.max(0, contentW - vpW);
  const maxTop = Math.max(0, contentH - vpH);

  // Avoid div-by-zero
  const fracW = contentW > 0 ? vpW / contentW : 1;
  const fracH = contentH > 0 ? vpH / contentH : 1;

  // Clamp scroll values just like clampScroll()
  const sL = Math.min(Math.max(viewport.scrollLeft, 0), maxLeft);
  const sT = Math.min(Math.max(viewport.scrollTop, 0), maxTop);

  const thumbFracLeft = maxLeft > 0 ? sL / maxLeft : 0;
  const thumbFracTop = maxTop > 0 ? sT / maxTop : 0;

  // --- Horizontal thumb (inside #viewbar-x) ---
  const trackX = viewbarX.getBoundingClientRect(); // for pixel math of the track itself
  const thumbX = viewbarX.querySelector(".vb-thumb");
  // Thumb width is the visible fraction of content along X
  const thumbXWidthPx = Math.max(10, Math.round(trackX.width * fracW));
  const thumbXLeftPx = Math.round((trackX.width - thumbXWidthPx) * thumbFracLeft);

  thumbX.style.width = `${thumbXWidthPx}px`;
  thumbX.style.left = `${thumbXLeftPx}px`;

  // --- Vertical thumb (inside #viewbar-y) ---
  const trackY = viewbarY.getBoundingClientRect();
  const thumbY = viewbarY.querySelector(".vb-thumb");
  const thumbYHeightPx = Math.max(10, Math.round(trackY.height * fracH));
  const thumbYTopPx = Math.round((trackY.height - thumbYHeightPx) * thumbFracTop);

  thumbY.style.height = `${thumbYHeightPx}px`;
  thumbY.style.top = `${thumbYTopPx}px`;
}

function applyLayout(withTransition = true) {
  const offset = (searchDrawerOpen ? 340 : 0) + (interlinearOpen ? 340 : 0);

  if (withTransition) mainContentContainer.style.transition = ".25s";
  mainContentContainer.style.width = offset
    ? `calc(100% - ${offset}px)`
    : "100%";

  if (withTransition) searchQueryContainer.style.transition = ".25s";
  searchQueryContainer.style.left = searchDrawerOpen
    ? `calc(100% - ${offset}px)`
    : "100%";

  interPanel.classList.toggle("open", interlinearOpen);

  if (withTransition) {
    setTimeout(() => {
      mainContentContainer.style.transition = "0s";
      searchQueryContainer.style.transition = "0s";
    }, 250);
  }
  throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
  throttledUpdateViewportBars();
}

// ==================== State ====================
// ... (All state variables unchanged) ...
let isPanning = false;
let startX, startY, scrollLeft, scrollTop;
let active = null;
let offsetX, offsetY;
let scale = 1;
let currentIndex = 1;
const MIN_SCALE = 0.15,
  MAX_SCALE = 1.5,
  PINCH_SENS = 0.003,
  WHEEL_SENS = 0.001;

// --- BoardAPI shim (safe to re-declare) ---
window.BoardAPI = window.BoardAPI || {};
if (!window.BoardAPI.getScale) {
  window.BoardAPI.getScale = () => (typeof scale === "number" ? scale : 1);
}
if (!window.BoardAPI.setScale) {
  window.BoardAPI.setScale = (s) => {
    if (typeof s !== "number" || !isFinite(s) || s <= 0) return;
    scale = s;
    const workspace = document.getElementById("workspace");
    if (workspace) {
      workspace.style.transformOrigin = "top left";
      workspace.style.transform = `scale(${scale})`;
    }
    try {
      clampScroll?.();
    } catch {}
    try {
      updateAllConnections?.();
    } catch {}
  };
}
// --- End BoardAPI shim ---

// Touch/Tablet
let isTouchPanning = false;
let touchDragElement = null;
let touchDragOffset = { x: 0, y: 0 };
let touchMoved = false;

// Selection / connect
let isConnectMode = false;
let selectedItem = null;

// Drag-from-text thresholds
const DRAG_SLOP = 6;
let pendingMouseDrag = null;
let pendingTouchDrag = null;

// ==================== Helpers ====================
// ... (isTouchInsideUI unchanged) ...
function isTouchInsideUI(el) {
  return !!(
    el.closest?.("#search-query-container") ||
    el.closest?.("#action-buttons-container") ||
    el.closest?.("#bible-whiteboard-title") ||
    el.closest?.("#search-container")
  );
}
// ... (All existing pan, zoom, drag, touch, and connection logic remains unchanged) ...
// ... (Skipping ~500 lines of unchanged code for brevity) ...
function onGlobalMouseUp() {
  if (active) {
    try {
      active.style.cursor = "grab";
    } catch {}
    onBoardMutated("item_move_end"); // AUTOSAVE
  }
  active = null;
  pendingMouseDrag = null;
  touchDragElement = null;

  // OPTIMIZATION: Trigger pan save on mouseup, not mousemove
  if (isPanning) {
    onBoardMutated("pan_end");
  }
  isPanning = false;
}

// Make sure we always release, even if mouseup lands on another element/panel
window.addEventListener("mouseup", onGlobalMouseUp); // normal bubble
document.addEventListener("mouseup", onGlobalMouseUp, true); // capture phase
window.addEventListener("blur", onGlobalMouseUp); // lost focus (e.g., alt-tab)

function clamp(v, a, b) {
  return Math.min(Math.max(v, a), b);
}
function itemKey(el) {
  if (!el?.dataset?.vkey) {
    el.dataset.vkey = "v_" + Math.random().toString(36).slice(2);
  }
  return el.dataset.vkey;
}
// ... (clampScroll unchanged) ...
function clampScroll() {
  // During restore, skip clamping until layout settles
  if (window.__RESTORING_FROM_SUPABASE) return;

  const maxLeft = Math.max(
    0,
    workspace.offsetWidth * scale - viewport.clientWidth
  );
  const maxTop = Math.max(
    0,
    workspace.offsetHeight * scale - viewport.clientHeight
  );

  // Only clamp if values are valid (prevent snap to 0)
  if (maxLeft >= 0 && maxTop >= 0) {
    viewport.scrollLeft = clamp(viewport.scrollLeft, 0, maxLeft);
    viewport.scrollTop = clamp(viewport.scrollTop, 0, maxTop);
  }
}

function applyZoom(e, deltaScale) {
  const old = scale,
    next = clamp(old + deltaScale, MIN_SCALE, MAX_SCALE);
  if (Math.abs(next - old) < 1e-9) return false;

  const vpRect = viewport.getBoundingClientRect();
  const vpX = e.clientX - vpRect.left,
    vpY = e.clientY - vpRect.top;

  // Capture scroll BEFORE any transform changes
  const currentScrollLeft = viewport.scrollLeft;
  const currentScrollTop = viewport.scrollTop;

  const worldX = (currentScrollLeft + vpX) / old;
  const worldY = (currentScrollTop + vpY) / old;

  scale = next;
  workspace.style.transformOrigin = "top left";
  workspace.style.transform = `scale(${scale})`;

  // Set scroll atomically
  viewport.scrollLeft = worldX * scale - vpX;
  viewport.scrollTop = worldY * scale - vpY;

  clampScroll();
  throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
  throttledUpdateViewportBars();
  onBoardMutated("zoom_end"); // AUTOSAVE on zoom
  return true;
}

// ==================== Pan / Zoom ====================
// ... (Pan/Zoom listeners unchanged) ...
viewport.addEventListener("mousedown", (e) => {
  if (e.target.closest(".board-item")) return;
  isPanning = true;
  viewport.style.cursor = "grabbing";
  startX = e.clientX;
  startY = e.clientY;
  scrollLeft = viewport.scrollLeft;
  scrollTop = viewport.scrollTop;
});

window.addEventListener("mouseup", () => {
  viewport.style.cursor = "grab";
  onGlobalMouseUp();
});

window.addEventListener("mousemove", (e) => {
  // Promote pending drag if user moved far enough
  if (!isPanning && !active) {
    if (pendingMouseDrag) {
      const dx = e.clientX - pendingMouseDrag.startX;
      const dy = e.clientY - pendingMouseDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        startDragMouse(
          pendingMouseDrag.item,
          { clientX: pendingMouseDrag.startX, clientY: pendingMouseDrag.startY },
          pendingMouseDrag.offX,
          pendingMouseDrag.offY
        );
        pendingMouseDrag = null;
      }
    }
  }

  if (isPanning) {
    // ⛏️ BUGFIX: use startY (not startX) for vertical delta
    viewport.scrollLeft = scrollLeft - (e.clientX - startX);
    viewport.scrollTop  = scrollTop  - (e.clientY - startY);  // ← fixed

    clampScroll();
    throttledUpdateAllConnections();
    // Note: autosave for pan happens on mouseup (good)
  } else if (active) {
    // dragging a board item
    dragMouseTo(e.clientX, e.clientY);
  }
});


viewport.addEventListener(
  "wheel",
  (e) => {
    const pixels =
      e.deltaMode === 1
        ? e.deltaY * 16
        : e.deltaMode === 2
        ? e.deltaY * viewport.clientHeight
        : e.deltaY;
    const changed = applyZoom(
      e,
      -pixels * (e.ctrlKey ? PINCH_SENS : WHEEL_SENS)
    );
    if (changed) e.preventDefault();
  },
  { passive: false }
);

// Keep connection lines in sync when the viewport scrolls (wheel/trackpad/scrollbar)
viewport.addEventListener(
  "scroll",
  () => {
    throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
    throttledUpdateViewportBars();
  },
  { passive: true }
);

// Center only on a fresh board (Supabase restore sets __RESTORING / __RESTORED flags)
window.addEventListener("load", () => {
  // Only center if NOT restored
  if (!window.__restoredBoard) {
    viewport.scrollLeft = (workspace.scrollWidth - viewport.clientWidth) / 2;
    viewport.scrollTop = (workspace.scrollHeight - viewport.clientHeight) / 2;
  }

  // Apply initial scale if not restored
  if (!window.__restoredBoard) {
    workspace.style.transformOrigin = "top left";
    workspace.style.transform = `scale(${scale})`;
  }

  // Update connections and buttons after a short delay
  setTimeout(() => {
    if (updateAllConnections) updateAllConnections(); // Run one non-throttled update on load
    throttledUpdateViewportBars();
    if (updateActionButtonsEnabled) updateActionButtonsEnabled();
  }, 100);
});

window.addEventListener("resize", () => {
  throttledUpdateAllConnections();
  throttledUpdateViewportBars();
});
// Touch pan + pinch
// ... (getTouchDistance, getTouchMidpoint unchanged) ...
let touchStartDistance = 0,
  lastScale = 1;
function getTouchDistance(t) {
  const dx = t[0].clientX - t[1].clientX,
    dy = t[0].clientY - t[1].clientY;
  return Math.hypot(dx, dy);
}
function getTouchMidpoint(t) {
  return {
    x: (t[0].clientX + t[1].clientX) / 2,
    y: (t[0].clientY + t[1].clientY) / 2,
  };
}

viewport.addEventListener(
  "touchstart",
  (e) => {
    // Let UI (right panel, buttons, search, title) work normally
    if (isTouchInsideUI?.(e.target)) return;

    // ✅ If the touch begins on a board item, DO NOT start panning here.
    //    Let workspace handlers manage element dragging.
    if (e.touches.length === 1 && e.target.closest(".board-item")) return;

    // Clear any stale element-drag states before starting a canvas gesture
    touchDragElement = null;
    pendingTouchDrag = null;
    active = null;

    if (e.touches.length === 1) {
      isTouchPanning = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      scrollLeft = viewport.scrollLeft;
      scrollTop = viewport.scrollTop;
    } else if (e.touches.length === 2) {
      isTouchPanning = false;
      touchStartDistance = getTouchDistance(e.touches);
      lastScale = scale;
    }
  },
  { passive: false }
);

viewport.addEventListener(
  "touchmove",
  (e) => {
    if (isTouchInsideUI?.(e.target)) return;

    // ✅ If an element is dragging or we're arming one (pendingTouchDrag),
    //    the viewport must NOT pan/zoom on this move.
    if (touchDragElement || pendingTouchDrag) return;

    if (e.touches.length === 1 && isTouchPanning && !isConnectMode) {
      e.preventDefault(); // only while panning the canvas
      viewport.scrollLeft = scrollLeft - (e.touches[0].clientX - startX);
      viewport.scrollTop = scrollTop - (e.touches[0].clientY - startY);
      clampScroll();
      throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
    } else if (e.touches.length === 2) {
      e.preventDefault(); // pinch zoom
      const newDistance = getTouchDistance(e.touches);
      const scaleDelta = (newDistance - touchStartDistance) * PINCH_SENS;
      const newScale = clamp(lastScale + scaleDelta, MIN_SCALE, MAX_SCALE);
      const mid = getTouchMidpoint(e.touches);
      applyZoom({ clientX: mid.x, clientY: mid.y }, newScale - scale);
    }
  },
  { passive: false }
);

viewport.addEventListener(
  "touchend",
  () => {
    if (isTouchPanning) {
      onBoardMutated("pan_touch_end"); // AUTOSAVE on pan end
    }
    isTouchPanning = false;
  },
  { passive: true }
);

workspace.addEventListener(
  "touchstart",
  (e) => {
    // --- NEW: READ-ONLY GUARD ---
    if (isConnectMode || window.__readOnly) return;
    // --- END NEW ---
    if (e.touches.length !== 1) return; // element drag is 1-finger only
    if (isTouchInsideUI?.(e.target)) return; // don’t hijack UI touches

    const item = e.target.closest(".board-item");
    if (!item) {
      // Touch on empty canvas should not arm an element drag
      pendingTouchDrag = null;
      return;
    }

    // Don’t preventDefault yet — we only do that once we actually start dragging
    touchDragElement = null; // clear any stale drag
    const t = e.touches[0];
    const rect = item.getBoundingClientRect();
    pendingTouchDrag = {
      item,
      startX: t.clientX,
      startY: t.clientY,
      offX: (t.clientX - rect.left) / scale,
      offY: (t.clientY - rect.top) / scale,
    };
  },
  { passive: false }
);

workspace.addEventListener(
  "touchmove",
  (e) => {
    if (isConnectMode) return;

    // Already dragging an item → keep the gesture captured to the item
    if (touchDragElement) {
      e.preventDefault();
      const t = e.touches[0];
      dragTouchTo(t);
      return;
    }

    // Not yet dragging → promote to drag ONLY after slop, then preventDefault
    const t = e.touches[0];
    if (pendingTouchDrag && !touchDragElement) {
      const dx = t.clientX - pendingTouchDrag.startX;
      const dy = t.clientY - pendingTouchDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        e.preventDefault(); // from now on, this gesture belongs to the item
        startDragTouch(
          pendingTouchDrag.item,
          t,
          pendingTouchDrag.offX,
          pendingTouchDrag.offY
        );
        pendingTouchDrag = null;
      }
    }
  },
  { passive: false }
);

workspace.addEventListener(
  "touchend",
  () => {
    if (touchDragElement) {
      onBoardMutated("item_move_touch_end"); // AUTOSAVE
    }
    touchDragElement = null;
    pendingTouchDrag = null;
    touchMoved = false;
  },
  { passive: true }
);

workspace.addEventListener(
  "touchcancel",
  () => {
    touchDragElement = null;
    pendingTouchDrag = null;
    touchMoved = false;
  },
  { passive: true }
);

// If touch ends anywhere (including over UI), ensure we’re not “stuck” in drag
window.addEventListener(
  "touchend",
  () => {
    if (touchDragElement) {
      onBoardMutated("item_move_touch_end"); // AUTOSAVE
    }
    touchDragElement = null;
    pendingTouchDrag = null;
    touchMoved = false;
    isTouchPanning = false;
    active = null;
  },
  { passive: true }
);

window.addEventListener(
  "touchcancel",
  () => {
    touchDragElement = null;
    pendingTouchDrag = null;
    touchMoved = false;
    isTouchPanning = false;
    active = null;
  },
  { passive: true }
);

// ==================== Drag helpers ====================
function startDragMouse(item, eOrPoint, offX, offY) {
  // --- NEW: READ-ONLY GUARD ---
  if (window.__readOnly) return;
  // --- END NEW ---
  
  active = item;
  // GUARD
  if (window.__readOnly) return;

  currentIndex += 1;
  item.style.zIndex = currentIndex;
  item.style.cursor = "grabbing";
  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    offsetX = (eOrPoint.clientX - rect.left) / scale;
    offsetY = (eOrPoint.clientY - rect.top) / scale;
  } else {
    offsetX = offX;
    offsetY = offY;
  }
}

function dragMouseTo(clientX, clientY) {
  const newLeft = (viewport.scrollLeft + clientX) / scale - offsetX;
  const newTop = (viewport.scrollTop + clientY) / scale - offsetY;
  const maxLeft = workspace.offsetWidth - active.offsetWidth;
  const maxTop = workspace.offsetHeight - active.offsetHeight;
  active.style.left = clamp(newLeft, 0, maxLeft) + "px";
  active.style.top = clamp(newTop, 0, maxTop) + "px";
  throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
}

function startDragTouch(item, touchPoint, offX, offY) {
  // --- NEW: READ-ONLY GUARD ---
  if (window.__readOnly) return;
  // --- END NEW ---

  touchDragElement = item;
  // GUARD
  if (window.__readOnly) return;

  touchMoved = false;
  isTouchPanning = false;
  currentIndex += 1;
  item.style.zIndex = currentIndex;
  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    touchDragOffset.x = (touchPoint.clientX - rect.left) / scale;
    touchDragOffset.y = (touchPoint.clientY - rect.top) / scale;
  } else {
    touchDragOffset.x = offX;
    touchDragOffset.y = offY;
  }
}
// ... (dragTouchTo unchanged) ...
function dragTouchTo(touchPoint) {
  const vp = viewport.getBoundingClientRect();
  const x =
    (viewport.scrollLeft + (touchPoint.clientX - vp.left)) / scale -
    touchDragOffset.x;
  const y =
    (viewport.scrollTop + (touchPoint.clientY - vp.top)) / scale -
    touchDragOffset.y;
  const maxLeft = workspace.offsetWidth - touchDragElement.offsetWidth;
  const maxTop = workspace.offsetHeight - touchDragElement.offsetHeight;
  touchDragElement.style.left = `${clamp(x, 0, maxLeft)}px`;
  touchDragElement.style.top = `${clamp(y, 0, maxTop)}px`;
  throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
}

// ==================== Connections ====================
// ... (connectionExists unchanged) ...
let connections = [];
function connectionExists(a, b) {
  const ka = itemKey(a),
    kb = itemKey(b);
  return connections.some((c) => {
    const ca = itemKey(c.itemA),
      cb = itemKey(c.itemB);
    return (ca === ka && cb === kb) || (ca === kb && cb === ka);
  });
}

// ... (updateConnection, updateAllConnections unchanged) ...
function updateConnection(path, el1, el2) {
  const vpRect = viewport.getBoundingClientRect();
  const r1 = el1.getBoundingClientRect(),
    r2 = el2.getBoundingClientRect();
  const p1 = {
    x: (viewport.scrollLeft + (r1.left - vpRect.left) + r1.width / 2) / scale,
    y: (viewport.scrollTop + (r1.top - vpRect.top) + r1.height / 2) / scale,
  };
  const p2 = {
    x: (viewport.scrollLeft + (r2.left - vpRect.left) + r2.width / 2) / scale,
    y: (viewport.scrollTop + (r2.top - vpRect.top) + r2.height / 2) / scale,
  };
  const dx = p2.x - p1.x,
    dy = p2.y - p1.y,
    absDx = Math.abs(dx),
    absDy = Math.abs(dy);
  if (absDx < 40 || absDy < 40) {
    path.setAttribute("d", `M${p1.x},${p1.y} L${p2.x},${p2.y}`);
    return;
  }
  const s = 0.7;
  let c1x = p1.x,
    c1y = p1.y,
    c2x = p2.x,
    c2y = p2.y;
  if (absDx > absDy) {
    c1x += dx * s;
    c2x -= dx * s;
    c1y += dy * 0.1;
    c2y -= dy * 0.1;
  } else {
    c1y += dy * s;
    c2y -= dy * s;
    c1x += dx * 0.1;
    c2x -= dx * 0.1;
  }
  path.setAttribute(
    "d",
    `M${p1.x},${p1.y} C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`
  );
}

function updateAllConnections() {
  // This is the raw function. It will be wrapped by throttleRAF.
  connections.forEach(({ path, itemA, itemB }) =>
    updateConnection(path, itemA, itemB)
  );
}

function connectItems(a, b) {
  // GUARD: allow creating connection paths during a Supabase restore,
  // but block user-initiated connects in read-only.
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  if (!a || !b || a === b || connectionExists(a, b)) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.classList.add("connection-line");
  path.style.pointerEvents = "stroke";

  // OPTIMIZATION: Use .onclick for robust listener management
  path.onclick = (e) => {
    e.stopPropagation();
    disconnectLine(path);
  };

  svg.appendChild(path);
  connections.push({ path, itemA: a, itemB: b });
  updateConnection(path, a, b); // Update immediately on creation
  onBoardMutated("connect_items"); // AUTOSAVE
}

function disconnectLine(path) {
  // GUARD
  if (window.__readOnly) return;

  const idx = connections.findIndex((c) => c.path === path);
  if (idx !== -1) {
    try {
      svg.removeChild(connections[idx].path);
    } catch (_e) {}
    connections.splice(idx, 1);
    onBoardMutated("disconnect_line"); // AUTOSAVE
  }
}

function removeConnectionsFor(el) {
  // GUARD
  if (window.__readOnly) return;

  let changed = false;
  connections = connections.filter((c) => {
    if (c.itemA === el || c.itemB === el) {
      try {
        svg.removeChild(c.path);
      } catch (_e) {}
      changed = true;
      return false;
    }
    return true;
  });
  if (changed) onBoardMutated("remove_connections_for_item"); // AUTOSAVE
}

// ==================== Element Creation ====================
function addBibleVerse(
  reference,
  text,
  createdFromLoad = false,
  version = null
) {
  currentIndex += 1;
  // GUARD: Allow creation during load/restore, but not by user action
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "bible-verse");
  el.style.position = "absolute";

  // Add robust data attributes for serialization
  el.dataset.type = "verse";
  el.dataset.reference = reference;
  el.dataset.text = text;
  if (version) {
    el.dataset.version = version;
  }

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale,
    visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale,
    visibleH = vpRect.height / scale;
  // const randX = visibleX + Math.random() * (visibleW - 300);
  // const randY = visibleY + Math.random() * (visibleH - 200);
  const randX = visibleX + .5 * (visibleW - 300);
  const randY = visibleY + .5 * (visibleH - 200);
  el.style.left = `${randX}px`;
  el.style.top = `${randY}px`;
  el.style.zIndex = currentIndex

  // Use createdFromLoad flag to determine reference format
  const displayReference = createdFromLoad ? reference : `- ${reference}`;
  // ADDED: Version label
  const versionLabel = version ? ` ${version.toUpperCase()}` : "";

  el.innerHTML = `
    <div id="bible-text-content">
      <div class="verse-text">VERSE</div>
      <div class="verse-text-content">${text}</div>
      <div class="verse-text-reference">${displayReference}${versionLabel}</div>
    </div>
  `;

  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  // OPTIMIZATION: Use .onmousedown
  el.onmousedown = (e) => {
    if (
      isConnectMode ||
      e.target.closest('[contenteditable="true"], textarea.text-content')
    )
      return;
    startDragMouse(el, e);
  };

  onBoardMutated("add_verse"); // AUTOSAVE (safe due to onBoardMutated restore check)
  return el;
}

function addTextNote(initial = "New note") {
  currentIndex += 1;
  // GUARD: Allow creation during load/restore, but not by user action
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "text-note");
  el.dataset.type = "note"; // Add data attribute
  el.style.position = "absolute";

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale,
    visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale,
    visibleH = vpRect.height / scale;
  const x = visibleX + (visibleW - 300) / 2;
  const y = visibleY + (visibleH - 50) / 2;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.zIndex = currentIndex

  el.innerHTML = `
    <div class="note-content"><div class="verse-text note-label">NOTE</div><div class="text-content" contenteditable="${!window.__readOnly}" spellcheck="false">${initial}</div></div>
  `;
  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  const header = el.querySelector(".note-label");
  const body = el.querySelector(".text-content");

  // AUTOSAVE on text edit
  // OPTIMIZATION: Use .oninput
  body.oninput = () => {
    if (window.__readOnly) return;
    onBoardMutated("edit_note_text");
  };

  // OPTIMIZATION: Use .onmousedown
  header.onmousedown = (e) => {
    if (!isConnectMode) startDragMouse(el, e);
  };
  el.onmousedown = (e) => {
    if (isConnectMode) return;
    if (e.target === body || e.target.closest(".text-content")) {
      const rect = el.getBoundingClientRect();
      pendingMouseDrag = {
        item: el,
        startX: e.clientX,
        startY: e.clientY,
        offX: (e.clientX - rect.left) / scale,
        offY: (e.clientY - rect.top) / scale,
      };
      return;
    }
    startDragMouse(el, e);
  };

  // OPTIMIZATION: Use .ontouch... properties
  el.ontouchstart = (e) => {
    // --- NEW: READ-ONLY GUARD ---
    if (isConnectMode || window.__readOnly || e.touches.length !== 1) return;
    // --- END NEW ---
    const t = e.touches[0];
    const rect = el.getBoundingClientRect();
    pendingTouchDrag = {
      item: el,
      startX: t.clientX,
      startY: t.clientY,
      offX: (t.clientX - rect.left) / scale,
      offY: (t.clientY - rect.top) / scale,
    };
  };

  el.ontouchmove = (e) => {
    if (isConnectMode) return;
    const t = e.touches[0];
    if (pendingTouchDrag && !touchDragElement) {
      const dx = t.clientX - pendingTouchDrag.startX;
      const dy = t.clientY - pendingTouchDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        startDragTouch(
          pendingTouchDrag.item,
          t,
          pendingTouchDrag.offX,
          pendingTouchDrag.offY
        );
        pendingTouchDrag = null;
      }
    }
    if (!touchDragElement) return;
    e.preventDefault();
    touchMoved = true;
    dragTouchTo(t);
  };

  el.ontouchend = () => {
    if (touchDragElement) onBoardMutated("item_move_touch_end"); // AUTOSAVE
    if (!touchDragElement) {
      pendingTouchDrag = null;
      return;
    }
    touchDragElement = null;
    setTimeout(() => {
      touchMoved = false;
    }, 0);
  };

  // selectItem(el);

  // Only focus if this is a fresh add, not a restore
  if (!window.__RESTORING_FROM_SUPABASE) {
    setTimeout(() => {
      body.focus();
      document.getSelection()?.selectAllChildren(body);
    }, 0);
  }

  onBoardMutated("add_note"); // AUTOSAVE (safe)
  return el;
}

/* ========== NEW: Dedicated Interlinear card element ========== */
function addInterlinearCard({
  surface,
  english,
  translit,
  morph,
  strong,
  reference,
}) {
  currentIndex += 1;
  // GUARD: Allow creation during load/restore, but not by user action
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "interlinear-card");
  el.style.position = "absolute";

  // Default position: near the selected verse if possible; else center-ish
  let targetLeft, targetTop;
  const vpRect = viewport.getBoundingClientRect();
  if (selectedItem && selectedItem.classList.contains("bible-verse")) {
    const ar = selectedItem.getBoundingClientRect();
    const ax = (viewport.scrollLeft + (ar.left - vpRect.left)) / scale;
    const ay = (viewport.scrollTop + (ar.top - vpRect.top)) / scale;
    targetLeft = ax + 20;
    targetTop = ay + ar.height + 12;
  } else {
    const visibleX = viewport.scrollLeft / scale,
      visibleY = viewport.scrollTop / scale;
    const visibleW = vpRect.width / scale,
      visibleH = vpRect.height / scale;
    targetLeft = visibleX + (visibleW - 320) / 2;
    targetTop = visibleY + (visibleH - 120) / 2;
  }
  el.style.left = `${targetLeft}px`;
  el.style.top = `${targetTop}px`;
  el.style.zIndex = currentIndex

  // Build content
  const chips = [];
  if (translit) chips.push(`<span class="interlinear-chip">${translit}</span>`);
  if (morph) chips.push(`<span class="interlinear-chip">${morph}</span>`);
  if (strong)
    chips.push(`<span class="interlinear-chip">Strong: ${strong}</span>`);

  el.innerHTML = `
    <div class="interlinear-card-header">
      <div class="interlinear-card-badge">INTERLINEAR</div>
      <div class="interlinear-card-ref">${reference || ""}</div>
    </div>
    <div class="interlinear-card-body">
      <div class="interlinear-card-surface">${surface || ""}</div>
      ${english ? `<div class="interlinear-card-english">${english}</div>` : ""}
      ${
        chips.length
          ? `<div class="interlinear-card-meta">${chips.join(" ")}</div>`
          : ""
      }
    </div>
  `;

  // Useful metadata for saving/export (already robust)
  el.dataset.type = "interlinear";
  el.dataset.reference = reference || "";
  el.dataset.surface = surface || "";
  el.dataset.english = english || "";
  el.dataset.translit = translit || "";
  el.dataset.morph = morph || "";
  el.dataset.strong = strong || "";

  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  // Drag handlers (simple: start drag anywhere on the card)
  // OPTIMIZATION: Use .on... properties
  el.onmousedown = (e) => {
    if (isConnectMode) return;
    startDragMouse(el, e);
  };
  el.ontouchstart = (e) => {
    // --- NEW: READ-ONLY GUARD ---
    if (isConnectMode || window.__readOnly || e.touches.length !== 1) return;
    // --- END NEW ---
    const t = e.touches[0];
    const rect = el.getBoundingClientRect();
    pendingTouchDrag = {
      item: el,
      startX: t.clientX,
      startY: t.clientY,
      offX: (t.clientX - rect.left) / scale,
      offY: (t.clientY - rect.top) / scale,
    };
  };
  el.ontouchmove = (e) => {
    if (isConnectMode) return;
    const t = e.touches[0];
    if (pendingTouchDrag && !touchDragElement) {
      const dx = t.clientX - pendingTouchDrag.startX;
      const dy = t.clientY - pendingTouchDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        startDragTouch(
          pendingTouchDrag.item,
          t,
          pendingTouchDrag.offX,
          pendingTouchDrag.offY
        );
        pendingTouchDrag = null;
      }
    }
    if (!touchDragElement) return;
    e.preventDefault();
    touchMoved = true;
    dragTouchTo(t);
  };
  el.ontouchend = () => {
    if (touchDragElement) onBoardMutated("item_move_touch_end"); // AUTOSAVE
    if (!touchDragElement) {
      pendingTouchDrag = null;
      return;
    }
    touchDragElement = null;
    setTimeout(() => {
      touchMoved = false;
    }, 0);
  };

  // Select on create (nice UX)
  // selectItem(el);

  onBoardMutated("add_interlinear_card"); // AUTOSAVE (safe)
  return el;
}

// ==================== Search UI glue ====================
// ... (searchForQueryFromSuggestion, displaySearchVerseOption, displayNoVerseFound unchanged) ...
function searchForQueryFromSuggestion(reference) {
  searchBar.value = reference;
  searchForQuery(new Event("submit")); // Simulate a submit event
}

function displaySearchVerseOption(reference, text, version) {
  const versesHeader = document.getElementById("search-query-verses-text");
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );

  // ✅ Always show the "Verses" header when we have a verse
  if (versesHeader) versesHeader.style.display = "block";

  if (verseContainer) {
    verseContainer.style.display = "block";
    verseContainer.innerHTML = ""; // Clear for single-verse result

    const item = document.createElement("div");
    item.classList.add("search-query-verse-container");
    item.innerHTML = `
      <div class="search-query-verse-text">${text}</div>
      <div class="search-query-verse-reference">– ${reference} ${version.toUpperCase()}</div>
      <button class="search-query-verse-add-button">add</button>
    `;

    // OPTIMIZATION: Use .onclick for robust listener management
    item.querySelector(".search-query-verse-add-button").onclick = () => {
      addBibleVerse(`${reference}`, text, false, version); // Pass false for createdFromLoad
      // OPTIMIZATION: Prefetch adjacent verses
      prefetchAdjacentVerses(reference, globalSearchController?.signal, version);
    };

    verseContainer.appendChild(item);
  }
}

function displayNoVerseFound(reference) {
  const versesHeader = document.getElementById("search-query-verses-text");
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
  if (versesHeader) versesHeader.style.display = "block";
  if (!verseContainer) return;
  verseContainer.style.display = "block";
  verseContainer.innerHTML = `
    <div class="search-query-no-verse-found-container">
      <div class="search-query-verse-text" style="text-align:center;color:var(--muted)">No verses found for ${reference}.</div>
      <div class="search-query-verse-reference"></div>
    </div>`;
}

// ==================== Search (Optimized for Progressive Rendering) ====================
// ... (prefetchAdjacentVerses, fetchAndStreamVerseTexts unchanged) ...
/**
 * OPTIMIZATION: Prefetches adjacent verses on idle.
 */
function prefetchAdjacentVerses(reference, signal, version = "KJV") {
  requestIdleCallback(async () => {
    if (signal?.aborted) return;
    try {
      const parts = parseReferenceToParts(reference);
      if (!parts || !parts.book) return;

      const { book, chapter, verse } = parts;
      const ver = version || "KJV"; // Ensure version is set

      // Prefetch previous (if > 1)
      if (verse > 1) {
        fetchVerseText(book, chapter, verse - 1, signal, ver).catch(() => {}); // Fire and forget
      }
      // Prefetch next
      fetchVerseText(book, chapter, verse + 1, signal, ver).catch(() => {}); // Fire and forget
    } catch (e) {
      // Squelch errors, this is best-effort
    }
  });
}

/**
 * OPTIMIZATION: Fetches verse texts in batches and streams them to the DOM
 * using requestAnimationFrame to prevent layout thrash.
 *
 * NOTE: This is no longer the primary streaming function for search results,
 * but is kept as it was part of the original performance optimization.
 * The new `fillVerseBatch` is now used by `searchForQuery`.
 */
async function fetchAndStreamVerseTexts(verseElements, signal) {
  const version = getSelectedVersion(); // Get version once for the batch
  let firstVerseLoaded = false;
  for (let i = 0; i < verseElements.length; i += BATCH_SIZE) {
    if (signal?.aborted) return;

    const batch = verseElements.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async ({ ref, el }) => {
      if (signal?.aborted) throw new Error("Aborted");
      const parts = parseReferenceToParts(ref);
      if (!parts) return { el, text: "Invalid reference." };
      const text = await fetchVerseText(
        parts.book,
        parts.chapter,
        parts.verse,
        signal,
        version
      );
      return { el, text, ref };
    });

    const results = await Promise.allSettled(promises);
    if (signal?.aborted) return; // Check again after await

    // Use rAF to batch DOM updates for this... batch
    requestAnimationFrame(() => {
      if (signal?.aborted) return;
      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value) continue;

        const { el, text, ref } = result.value;
        const errorMessages = [
          "Verse not found.",
          "Error fetching verse.",
          "Verse temporarily unavailable.",
          "Invalid reference.",
        ];
        const isError =
          !text ||
          errorMessages.includes(text) ||
          /not\s*found/i.test(String(text));

        const textEl = el.querySelector(".search-query-verse-text");
        if (!textEl) continue;

        if (isError) {
          textEl.textContent = text || "Verse not found.";
          textEl.style.color = "var(--muted)";
          textEl.style.textAlign = "center";
        } else {
          if (!firstVerseLoaded) {
            logPerf("first_verse_text_rendered");
            firstVerseLoaded = true;
          }
          textEl.textContent = text;
          // This logic is now superseded by fillVerseBatch,
          // but left here for compatibility with any other caller.
          const addBtn = el.querySelector(".search-query-verse-add-button");
          if (addBtn) {
            addBtn.disabled = false;
            addBtn.onclick = () => {
              addBibleVerse(`${ref}`, text, false, version);
              prefetchAdjacentVerses(ref, signal, version); // Prefetch on add
            };
          }
        }
      }
    });
  }
}
// ==================== NEW HELPERS FOR PAGINATED/PRIORITY VERSE LOADING ====================
// ... (fillVerseBatch, ensureLoadMoreButton, fetchVerseData, buildVerseCard, buildSongCard, ensureSongsLoadMoreButton unchanged) ...
/**
 * Fill a batch of verseElements with real text, then enable Add buttons.
 * @param {Array<{ref: string, el: HTMLElement}>} verseBatch
 * @param {AbortSignal} signal
 */
async function fillVerseBatch(verseBatch, signal, version) {
  for (const { ref, el } of verseBatch) {
    if (signal?.aborted) return;
    // Skip if already ready
    if (el.dataset.status === "ready") continue;

    const parts = parseReferenceToParts(ref);
    if (!parts) {
      el.dataset.status = "error";
      el.querySelector(".search-query-verse-text").textContent = "Verse not found.";
      continue;
    }
    const text = await fetchVerseText(
      parts.book,
      parts.chapter,
      parts.verse,
      signal,
      version
    );
    if (signal?.aborted) return;

    // If we received an error string, treat as not ready
    if (!text || /not\s*found|unavailable|error/i.test(String(text))) {
      el.dataset.status = "error";
      el.querySelector(".search-query-verse-text").textContent = "Verse not found.";
      continue;
    }

    // Populate real text and enable Add
    el.dataset.status = "ready";
    el.querySelector(".search-query-verse-text").textContent = text;
    el.querySelector(".search-query-verse-text").style.color = ""; // Reset color
    el.querySelector(".search-query-verse-text").style.textAlign = ""; // Reset align

    // Create the Add button only now that we have real text
    let addBtn = el.querySelector(".search-query-verse-add-button");
    if (!addBtn) {
      addBtn = document.createElement("button");
      addBtn.className = "search-query-verse-add-button";
      addBtn.textContent = "add";
      el.appendChild(addBtn);
    }
    addBtn.onclick = () => {
      // Final guard: never add placeholders
      if (el.dataset.status !== "ready" || !text || !text.trim()) return;
      addBibleVerse(`${ref}`, text, false, version);
      prefetchAdjacentVerses(ref, signal, version); // Prefetch on add
    };
  }
}

/**
 * Creates or finds the "Load more" button for verses.
 * @param {HTMLElement} container
 * @param {Function} onClick
 */
function ensureLoadMoreButton(container, onClick) {
  let btn = container.querySelector("#load-more-verses-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "load-more-verses-btn";
    btn.className = "search-load-more";
    btn.textContent = "Load more";
    btn.addEventListener("click", onClick);
    container.appendChild(btn);
  }
  return btn;
}


/**
 * Fetches and validates text for a single verse reference.
 * Returns {ref, text} on success, or null on failure/abort.
 * @param {string} ref
 * @param {AbortSignal} signal
 * @returns {Promise<{ref: string, text: string} | null>}
 */
async function fetchVerseData(ref, signal, version) {
  const parts = parseReferenceToParts(ref);
  if (!parts) return null;

  try {
    const text = await fetchVerseText(
      parts.book,
      parts.chapter,
      parts.verse,
      signal,
      version
    );
    if (signal?.aborted) return null; // Check after await

    // Validate text
    if (!text || /not\s*found|unavailable|error/i.test(String(text))) {
      return null; // Don't treat errors as valid results
    }
    return { ref, text };
  } catch (err) {
    if (!signal?.aborted) {
      console.warn(`Failed to fetch ${ref}:`, err.message);
    }
    return null;
  }
}

/**
 * Creates a final, ready-to-add verse card element.
 * @param {string} ref
 * @param {string} text
 * @param {AbortSignal} signal
 * @returns {HTMLElement}
 */
function buildVerseCard(ref, text, signal, version) {
  const item = document.createElement("div");
  item.classList.add("search-query-verse-container");
  item.dataset.status = "ready"; // Mark as ready

  item.innerHTML = `
    <div class="search-query-verse-text">${text}</div>
    <div class="search-query-verse-reference">– ${ref} ${version.toUpperCase()}</div>
    <button class="search-query-verse-add-button">add</button>
  `;

  const addBtn = item.querySelector(".search-query-verse-add-button");
  addBtn.onclick = () => {
    // Guard: Check status and text again
    if (item.dataset.status === "ready" && text && text.trim()) {
      addBibleVerse(`${ref}`, text, false, version);
      prefetchAdjacentVerses(ref, signal, version); // Use the passed-in signal
    }
  };
  return item;
}

/**
 * Creates a final, ready-to-add song card element.
 * Uses existing classes from style.css to maintain visuals.
 * @param {object} song - A song object from fetchSongs (e.g., { trackName, artistName, artworkUrl100 })
 * @returns {HTMLElement}
 */
function buildSongCard(song) {
  // Use existing classes from displaySongResults to maintain visuals
  const card = document.createElement("div");
  card.className = "song-card"; // Existing class from style.css

  // Map fetchSongs fields (song.artworkUrl100) to addSongElement fields (song.cover)
  const songForBoard = {
    title: song.trackName,
    artist: song.artistName,
    cover: (song.artworkUrl100 || "").replace("100x100bb", "200x200bb"), // Logic from fetchSongs
  };

  card.innerHTML = `
    <img class="song-cover" src="${songForBoard.cover || ""}" alt="">
    <div class="song-meta">
      <div class="song-title">${songForBoard.title}</div>
      <div class="song-artist">${songForBoard.artist}</div>
    </div>
    <button class="song-add-btn">add</button>
  `;

  // Use .onclick for robust listener management
  card.querySelector(".song-add-btn").onclick = () => {
    // Guard: ensure the song card is indeed complete
    if (!songForBoard.title || !songForBoard.artist) return;
    // Call the existing add-to-board utility
    addSongElement(songForBoard);
  };

  return card;
}

/**
 * Creates or finds the "Load more" button for songs.
 * @param {HTMLElement} container
 * @param {Function} onClick
 */
function ensureSongsLoadMoreButton(container, onClick) {
  let btn = container.querySelector("#load-more-songs-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "load-more-songs-btn";
    btn.className = "search-load-more"; // Reuse verse button styles
    btn.textContent = "Load more";
    btn.addEventListener("click", onClick);
    container.appendChild(btn);
  }
  return btn;
}


/**
 * OPTIMIZATION: Debounce timer for type-ahead.
 */
let searchDebounceTimer = null;
// ... (onSearchInput and searchForQuery unchanged) ...
/**
 * OPTIMIZATION: Debounced input handler.
 */
function onSearchInput(e) {
  clearTimeout(searchDebounceTimer);
  const query = e.target.value.trim();

  // Don't search for empty or very short strings
  if (!query || query.length < 3) {
    // If query is empty, close the panel
    if (!query) closeSearchQuery();
    return;
  }

  startPerfTimer(); // Start perf timer for debounced search
  logPerf("debounce_start");

  searchDebounceTimer = setTimeout(() => {
    searchForQuery(null); // Call main search function (no event)
  }, DEBOUNCE_MS);
}

// Bind the debounced handler
if (TYPE_AHEAD_ENABLED && searchBar) {
  searchBar.addEventListener("input", onSearchInput);
}

/**
 * OPTIMIZATION: Refactored to handle progressive rendering and aborts.
 */
async function searchForQuery(event) {
  // --- 1. Setup & Abort ---
  if (event) {
    event.preventDefault(); // Form submit
  }

  const input = document.getElementById("search-bar");
  const query = (input?.value || "").trim(); // Get query early

  // Only proceed if explicitly submitted (enter or button click)
  // (We’re here only on submit because we removed input listeners.)
  if (!query) return false;

  startPerfTimer(); // Start perf timer for submit search
  logPerf("search_start");

  input && input.blur();

  // Abort any pending debounce AND any in-flight search
  clearTimeout(searchDebounceTimer);
  if (globalSearchController) {
    globalSearchController.abort();
  }
  globalSearchController = new AbortController();
  const { signal } = globalSearchController;
  const version = getSelectedVersion(); // ADDED

  // --- 2. Show Skeleton UI ---
  if (typeof didYouMeanText !== "undefined") didYouMeanText.style.display = "none";
  if (typeof searchQueryFullContainer !== "undefined")
    searchQueryFullContainer.style.display = "none";
  if (typeof loader !== "undefined") loader.style.display = "flex";

  searchDrawerOpen = true;
  if (interlinearOpen) closeInterlinearPanel();
  applyLayout(true);

  if (typeof searchQuery !== "undefined")
    searchQuery.textContent = `Search for "${query}"`;

  // Reset containers
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
  if (verseContainer) verseContainer.innerHTML = "";
  if (songsContainer) songsContainer.innerHTML = "";
  const versesHeader = document.getElementById("search-query-verses-text");
  if (versesHeader) versesHeader.style.display = "none";
  if (songsHeader) songsHeader.style.display = "none";

  logPerf("skeleton_rendered");

  // --- 3. Fire off parallel, non-blocking fetches ---

  // A) Songs Fetch (Fire and forget, now with pagination)
  fetchSongs(query, SEARCH_RESULT_LIMIT, signal)
    .then((songs) => {
      if (signal.aborted) return;
      logPerf("songs_data_received");

      // songs: render only a few, then expose Load more
      songsHeader.style.display = songs && songs.length ? "block" : "none";
      songsContainer.innerHTML = ""; // clear songs list first
      songsContainer.style.display = "grid"; // Ensure it's visible

      // Filter to only fully ready items (no placeholders)
      const readySongs = (songs || []).filter(s => s && s.trackName && s.artistName);
      
      // === THIS IS THE FIX: Use shared constants ===
      const initialSongs = readySongs.slice(0, INITIAL_VISIBLE_COUNT);
      const remainingSongs = readySongs.slice(INITIAL_VISIBLE_COUNT);
      // === END FIX ===

      // Append the initial ready cards
      for (const s of initialSongs) {
        const card = buildSongCard(s);
        songsContainer.appendChild(card);
      }

      if (remainingSongs.length > 0) {
        const loadMore = () => {
          if (signal?.aborted) return;

          // === THIS IS THE FIX: Use shared constant ===
          const next = remainingSongs.splice(0, LOAD_MORE_CHUNK);
          // === END FIX ===

          for (const s of next) {
            const card = buildSongCard(s);
            // Insert before the button
            const btn = songsContainer.querySelector("#load-more-songs-btn");
            if (btn) {
              songsContainer.insertBefore(card, btn);
            } else {
              songsContainer.appendChild(card); // Fallback
            }
          }
          if (remainingSongs.length === 0) {
            const btn = songsContainer.querySelector("#load-more-songs-btn");
            if (btn) btn.remove();
          }
        };
        ensureSongsLoadMoreButton(songsContainer, loadMore);
      }
    })
    .catch((err) => {
      if (signal.aborted) return;
      console.warn("Song search failed:", err);
      if (songsHeader) songsHeader.style.display = "none";
      if (songsContainer) songsContainer.style.display = "none";
    });

  // B) Verse Fetch (Fast path or Topic path)
  try {
    const result = window.findBibleVerseReference
      ? window.findBibleVerseReference(query)
      : null;

    if (result && result.didYouMean && typeof didYouMeanText !== "undefined") {
      didYouMeanText.style.display = "flex";
      didYouMeanText.innerHTML = `Did you mean: <div onclick="searchForQueryFromSuggestion('${result.reference}')">${result.reference}</div>?`;
    }

    if (result && result.book) {
      // --- FAST PATH: Direct verse reference ("John 3:16") ---
      const chap = result.chapter || 1;
      const vrse = result.verse || 1;
      const text = await fetchVerseText(
        result.book,
        chap,
        vrse,
        signal,
        version
      );

      if (signal.aborted) return false;
      logPerf("first_verse_text_rendered");

      const errorMessages = [
        "Verse not found.",
        "Error fetching verse.",
        "Verse temporarily unavailable.",
      ];
      const isError =
        !text ||
        errorMessages.includes(text) ||
        /not\s*found/i.test(String(text));

      if (isError) {
        displayNoVerseFound(result.reference);
      } else {
        displaySearchVerseOption(result.reference, text, version);
      }
    } else {
      // --- TOPIC PATH: No direct reference found ---
      // 1. Fetch references
      const refs = await fetchBibleSearchResults(
        query,
        SEARCH_RESULT_LIMIT,
        signal
      );
      if (signal.aborted) return false;

      if (!refs || refs.length === 0) {
        displayNoVerseFound(query);
      } else {
        // 2. Setup containers and inline loader
        if (versesHeader) versesHeader.style.display = "block";
        if (verseContainer) verseContainer.style.display = "block";
        verseContainer.innerHTML = ""; // Clear for new results

        const inlineLoader = document.createElement("div");
        inlineLoader.className = "search-query-verse-text"; // Reuse existing style
        inlineLoader.style.color = "var(--muted)";
        inlineLoader.style.padding = "15px 0"; // Add some space
        inlineLoader.style.textAlign = "center";
        inlineLoader.textContent = "Loading verses...";
        inlineLoader.id = "search-inline-loader";
        verseContainer.appendChild(inlineLoader);

        logPerf("verse_refs_rendered"); // Refs are back, starting text fetch

        // 3. Fetch initial batch
        const initialRefs = refs.slice(0, INITIAL_VISIBLE_COUNT);
        const remainingRefs = refs.slice(INITIAL_VISIBLE_COUNT);

        const fetchPromises = initialRefs.map((ref) =>
          fetchVerseData(ref, signal, version)
        );
        const results = await Promise.allSettled(fetchPromises);

        if (signal.aborted) return false; // Check after await

        // 4. Render initial batch
        inlineLoader.remove();
        let loadedCount = 0;
        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            const { ref, text } = result.value;
            const card = buildVerseCard(ref, text, signal, version); // Pass signal
            verseContainer.appendChild(card);
            loadedCount++;
          }
        }

        // 5. Handle "Load more"
        if (remainingRefs.length > 0) {
          // Define the loadMore handler (closes over remainingRefs, signal, etc.)
          const loadMore = async () => {
            const btn = verseContainer.querySelector("#load-more-verses-btn");
            if (signal?.aborted) return;
            if (btn) {
              btn.textContent = "Loading...";
              btn.disabled = true;
            }

            const nextRefs = remainingRefs.splice(0, LOAD_MORE_CHUNK);
            const nextPromises = nextRefs.map((ref) =>
              fetchVerseData(ref, signal, version)
            );
            const nextResults = await Promise.allSettled(nextPromises);

            if (signal.aborted) return;

            // Append new cards
            for (const result of nextResults) {
              if (result.status === "fulfilled" && result.value) {
                const { ref, text } = result.value;
                const card = buildVerseCard(ref, text, signal, version); // Pass signal
                // Insert before the button (if it exists)
                if (btn) {
                  verseContainer.insertBefore(card, btn);
                } else {
                  verseContainer.appendChild(card); // Fallback
                }
              }
            }

            // Update or remove button
            if (remainingRefs.length === 0) {
              if (btn) btn.remove();
            } else {
              if (btn) {
                btn.textContent = "Load more";
                btn.disabled = false;
              }
            }
          };

          ensureLoadMoreButton(verseContainer, loadMore);
        }
        
        // 6. Handle case where initial batch fails and no more refs
        if (loadedCount === 0 && remainingRefs.length === 0) {
          displayNoVerseFound(query);
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      console.error("Error in verse search path:", err);
      displayNoVerseFound(query);
    }
  } finally {
    // Hide main loader once refs are processed (texts stream after)
    if (loader) loader.style.display = "none";
    if (searchQueryFullContainer) searchQueryFullContainer.style.display = "flex";
  }

  return false; // prevent default navigation
}
// ... (closeSearchQuery unchanged) ...
function closeSearchQuery() {
  searchDrawerOpen = false;
  applyLayout(true);
  if (searchBar) searchQuery.textContent = `Search for "${searchBar.value}"`;

  // OPTIMIZATION: Abort in-flight search when panel is closed
  if (globalSearchController) {
    globalSearchController.abort();
    globalSearchController = null;
  }
  // Abort Bible Search API controller (from original script)
  if (activeBibleSearchController) {
    activeBibleSearchController.abort();
    activeBibleSearchController = null;
  }
  // Abort debounced search
  clearTimeout(searchDebounceTimer);
}

// ==================== Theme Toggle ====================
// ... (Theme toggle logic unchanged) ...
const toggle = document.getElementById("theme-toggle");
const body = document.body;
const moonIcon = document.getElementById("moon-icon");
const sunIcon = document.getElementById("sun-icon");

function setTheme(isLight) {
  body.classList.toggle("light", isLight);
  localStorage.setItem("theme", isLight ? "light" : "dark");
  moonIcon.style.display = isLight ? "block" : "none";
  sunIcon.style.display = isLight ? "none" : "block";
}
setTheme(localStorage.getItem("theme") === "light");
toggle?.addEventListener("click", () =>
  setTheme(!body.classList.contains("light"))
);

// ==================== Selection + Action buttons ====================
// ... (updateActionButtonsEnabled, setConnectMode, selectItem, clearSelection unchanged) ...
function updateActionButtonsEnabled() {
  const hasSelection = !!selectedItem;

  if (!hasSelection && isConnectMode) {
    isConnectMode = false;
  }

  if (connectBtn) {
    // --- NEW: READ-ONLY GUARD ---
    // Don't allow enabling connect button if read-only, even if selected
    connectBtn.disabled = !hasSelection || window.__readOnly;
    // --- END NEW ---
    connectBtn.style.background =
      hasSelection && isConnectMode ? "var(--accent)" : "var(--bg-seethroug)";
    const ic = connectBtn.querySelector(".action-icon");
    if (ic)
      ic.style.fill =
        hasSelection && isConnectMode ? "var(--bg)" : "var(--muted)";
  }

  if (deleteBtn) {
    // --- NEW: READ-ONLY GUARD ---
    deleteBtn.disabled = !hasSelection || window.__readOnly;
    // --- END NEW ---
  }

  if (interlinearBtn) {
    const isVerse =
      !!selectedItem && selectedItem.classList.contains("bible-verse");
    interlinearBtn.disabled = !isVerse;
  }
}

function setConnectMode(on) {
  const next = !!on;
  if (isConnectMode === next) return;
  isConnectMode = next;
  updateActionButtonsEnabled();
}

function selectItem(el) {
  if (!el) return;
  if (selectedItem && selectedItem !== el) {
    selectedItem.classList.remove("selected-connection");
  }
  selectedItem = el;
  el.classList.add("selected-connection");
  updateActionButtonsEnabled();
}

function clearSelection() {
  if (selectedItem) selectedItem.classList.remove("selected-connection");
  selectedItem = null;
  setConnectMode(false);
  updateActionButtonsEnabled();
}


workspace.addEventListener("click", (e) => {
  // --- NEW: READ-ONLY GUARD ---
  // If read-only, don't allow selection or connection
  if (touchMoved || window.__readOnly) return;
  // --- END NEW ---

  const item = e.target.closest(".board-item");
  if (!item) {
    clearSelection();
    return;
  }
  if (!isConnectMode) {
    selectItem(item);
    return;
  }
  if (selectedItem && item !== selectedItem) {
    connectItems(selectedItem, item);
    throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
    clearSelection();
  }
});

document.addEventListener("click", (e) => {
  const insideWorkspace = e.target.closest("#workspace");
  const insideAction = e.target.closest("#action-buttons-container");
  const insideSearch = e.target.closest("#search-container"); // Don't deselect when clicking search
  
  // --- NEW: READ-ONLY GUARD (modified) ---
  // Allow deselecting in read-only, just don't clear if already clear
  if (window.__readOnly && !selectedItem) return;
  // --- END NEW ---
  
  if (!insideWorkspace && !insideAction && !insideSearch) {
    // If click is *outside* search, close it
    if (!e.target.closest("#search-query-container") && !insideSearch && !e.target.closest(".share-popover") && !e.target.closest("#share-btn")) {
      closeSearchQuery();
    }
    // --- NEW: READ-ONLY GUARD ---
    // Only clear selection if not read-only, or if clicking outside share popover
    if (!window.__readOnly && !e.target.closest(".share-popover") && !e.target.closest("#share-btn")) {
       clearSelection();
    }
    // --- END NEW ---
  }
});
// ... (keydown listener unchanged) ...
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    clearSelection();
    closeInterlinearPanel();
    closeSearchQuery();
  }
});


// ==================== Action buttons: Connect / Text / Delete ====================
// ... (Action button listeners unchanged, guards are inside handlers) ...
connectBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedItem) return;
  setConnectMode(!isConnectMode);
});

textBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  addTextNote("New note");
});

deleteBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedItem) return;
  removeConnectionsFor(selectedItem);
  try {
    selectedItem.remove();
  } catch (_e) {}
  clearSelection();
  onBoardMutated("delete_item"); // AUTOSAVE
});

// ==================== Interlinear integration ====================
// ... (Interlinear logic unchanged) ...
function openInterlinearPanel() {
  interlinearOpen = true;
  closeSearchQuery(); // Close search drawer

  interPanel.setAttribute("aria-busy", "true");
  interLoader.style.display = "flex";
  interList.innerHTML = "";
  interSubtitle.textContent = "";
  interEmpty.style.display = "none";
  interError.style.display = "none";
  interError.textContent = "Couldn’t load interlinear data."; // Reset error message

  applyLayout(true);
}

function closeInterlinearPanel() {
  interlinearOpen = false;
  interPanel.setAttribute("aria-busy", "false");
  // Abort any in-flight request if user closes panel
  if (interlinearInFlight) {
    interlinearInFlight.abort();
    interlinearInFlight = null;
  }
  applyLayout(true);
}

interClose?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeInterlinearPanel();
});

async function fetchInterlinear(book, chapter, verse, signal) {
  const base = `https://interlinear-api.onrender.com/interlinear/${encodeURIComponent(
    book
  )}/${chapter}/${verse}`;
  const prox = `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`;

  const ATTEMPTS = 3;
  const BASE_DELAY = 600; // 0ms, 600ms, 1200ms
  const TIMEOUT_PER_ATTEMPT = 6000; // 6 seconds

  let lastError = null;

  for (let i = 0; i < ATTEMPTS; i++) {
    if (signal.aborted) throw new Error("Fetch aborted by user");

    // Backoff delay
    if (i > 0) await new Promise((r) => setTimeout(r, BASE_DELAY * i));

    // Create a signal that combines the overall abort with the per-attempt timeout
    const attemptController = new AbortController();
    const attemptSignal = attemptController.signal;
    const timeoutId = setTimeout(
      () => attemptController.abort(new Error("Fetch timeout")),
      TIMEOUT_PER_ATTEMPT
    );

    // Listen to the main signal to abort this attempt
    const abortListener = () =>
      attemptController.abort(new Error("Fetch aborted by user"));
    signal.addEventListener("abort", abortListener, { once: true });

    try {
      // --- Attempt 1: Direct Fetch (as requested) ---
      try {
        const r = await fetch(base, {
          method: "GET",
          mode: "cors",
          signal: attemptSignal,
        });
        if (!r.ok) throw new Error(`Direct fetch bad status: ${r.status}`);
        const data = await r.json();
        clearTimeout(timeoutId); // Success
        signal.removeEventListener("abort", abortListener);
        return data;
      } catch (err) {
        lastError = err;
        if (signal.aborted || attemptSignal.aborted) throw err; // Don't retry if aborted
        console.warn(
          `Interlinear direct fetch failed (attempt ${i + 1}):`,
          err.message
        );
        // Fall through to proxy...
      }

      // --- Attempt 2: Proxy Fetch ---
      try {
        const r2 = await fetch(prox, { signal: attemptSignal });
        if (!r2.ok) throw new Error(`Proxy fetch bad status: ${r2.status}`);
        const data = await r2.json();
        clearTimeout(timeoutId); // Success
        signal.removeEventListener("abort", abortListener);
        return data;
      } catch (err2) {
        lastError = err2;
        if (signal.aborted || attemptSignal.aborted) throw err2; // Don't retry if aborted
        console.warn(
          `Interlinear proxy fetch failed (attempt ${i + 1}):`,
          err2.message
        );
        // Will loop to next attempt
      }
    } catch (attemptErr) {
      // This catches aborts
      lastError = attemptErr;
      if (signal.aborted) {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortListener);
        throw lastError; // Re-throw abort error
      }
      // Other errors will just let the loop continue
    } finally {
      // Clean up listeners for this attempt
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", abortListener);
    }
  }

  // If loop finishes, all attempts failed
  console.error("❌ Interlinear fetch failed (all attempts):", lastError);
  throw lastError || new Error("Interlinear fetch failed after all attempts.");
}

function renderInterlinearTokens(data) {
  interLoader.style.display = "none";
  // Note: busy state is handled by the click handler's finally block

  let tokens = [];
  let reference = "";

  // Normalize data shape
  if (Array.isArray(data)) {
    tokens = data;
  } else if (data && Array.isArray(data.tokens)) {
    tokens = data.tokens;
    reference =
      data.reference ||
      `${data.book || ""} ${data.chapter || ""}:${data.verse || ""}`.trim();
  }

  // Check for empty results
  if (!tokens || tokens.length === 0) {
    interEmpty.textContent = "No interlinear tokens found for this verse.";
    interEmpty.style.display = "block";
    interError.style.display = "none";
    return;
  }

  // Valid data, hide empty/error
  interEmpty.style.display = "none";
  interError.style.display = "none";

  interSubtitle.textContent = reference || interSubtitle.textContent || ""; // Use normalized ref

  const frag = document.createDocumentFragment();

  tokens.forEach((tok) => {
    const surface = tok.surface || "";
    const english = tok.resolved_gloss || tok.translation || tok.gloss || "";
    const translit = tok.resolved_translit || tok.translit || "";
    const morph = tok.morph || "";
    const strongRaw = tok.strong || "";
    const strong = strongRaw.replace(/^.*?(\/)?/, "").trim();

    const row = document.createElement("div");
    row.className = "interlinear-row";

    row.innerHTML = `
      <div class="interlinear-surface">${surface}</div>
      <div class="interlinear-english">${english}</div>
      <div class="interlinear-meta"></div>
      <button class="interlinear-add">add</button>
    `;

    const meta = row.querySelector(".interlinear-meta");
    const parts = [];
    if (translit) parts.push(`<span class="meta-chip">${translit}</span>`);
    if (morph) parts.push(`<span class="meta-chip">${morph}</span>`);
    if (strong) parts.push(`<span class="meta-chip">Strong: ${strong}</span>`);
    if (parts.length) meta.innerHTML = parts.join(" ");
    else meta.style.display = "none";

    // ⬇️ Add dedicated interlinear card on board
    // OPTIMIZATION: Use .onclick
    row.querySelector(".interlinear-add").onclick = () => {
      addInterlinearCard({
        surface,
        english,
        translit,
        morph,
        strong,
        reference: interSubtitle.textContent,
      });
    };

    frag.appendChild(row);
  });

  interList.innerHTML = "";
  interList.appendChild(frag);
}

// Parse selected verse reference ("– Genesis 1:1 KJV")
function parseSelectedVerseRef() {
  if (!selectedItem || !selectedItem.classList.contains("bible-verse"))
    return null;

  let rawRef = selectedItem.dataset.reference; // Prefer dataset

  if (!rawRef) {
    const refEl = selectedItem.querySelector(".verse-text-reference");
    if (!refEl) return null; // Guard against missing element
    rawRef = refEl.textContent || "";
  }

  // Sanitize text: remove leading dash, trailing version
  const cleanedRef = rawRef
    .replace("-", "")
    .replace(/\s+KJV$/, "")
    .replace(/\s+&middot;.*$/, "") // ADDED: Remove new version label
    .trim();
  console.log(cleanedRef);

  if (!cleanedRef) return null;

  // Use robust parser from search.js
  const result = window.findBibleVerseReference
    ? window.findBibleVerseReference(cleanedRef)
    : null;

  if (result && result.book && result.chapter && result.verse) {
    return { book: result.book, chapter: result.chapter, verse: result.verse };
  }

  console.warn("Could not parse ref:", cleanedRef, result);
  return null;
}

// Button handler
interlinearBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedItem || !selectedItem.classList.contains("bible-verse")) return;

  // Abort previous in-flight request
  if (interlinearInFlight) {
    interlinearInFlight.abort();
  }

  // Set up for new request
  interlinearSeq++;
  const currentSeq = interlinearSeq;
  const controller = new AbortController();
  interlinearInFlight = controller;

  openInterlinearPanel(); // Resets UI, shows loader, sets aria-busy

  const ref = parseSelectedVerseRef();

  if (!ref) {
    interLoader.style.display = "none";
    interError.textContent =
      "Couldn't parse verse reference from selected item.";
    interError.style.display = "block";
    interPanel.setAttribute("aria-busy", "false");
    interlinearInFlight = null;
    return;
  }

  try {
    const data = await fetchInterlinear(
      ref.book,
      ref.chapter,
      ref.verse,
      controller.signal
    );

    // Check if this is still the latest request
    if (currentSeq !== interlinearSeq) {
      console.log("Ignoring stale interlinear response");
      return;
    }

    renderInterlinearTokens(data);
  } catch (err) {
    // Check if this is still the latest request AND not an intentional abort
    if (currentSeq !== interlinearSeq || controller.signal.aborted) {
      console.log("Ignoring stale interlinear error/abort", err.message);
      return;
    }

    // Genuine error for the current request
    interLoader.style.display = "none";
    interError.textContent = "Couldn’t load interlinear data."; // Generic error
    interError.style.display = "block";
    console.error("Interlinear fetch failed:", err);
  } finally {
    // Only the LATEST request can clear the busy state
    if (currentSeq === interlinearSeq) {
      interPanel.setAttribute("aria-busy", "false");
      interlinearInFlight = null;
    }
  }
});


// ==================== Song search (iTunes public API, CORS-friendly) ====================
// ... (fetchSongs unchanged) ...
/**
 * OPTIMIZATION: Added AbortSignal for cancellation.
 */
async function fetchSongs(query, limit = 5, signal = null) {
  if (!query) return [];
  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: query,
    entity: "song",
    limit: String(limit),
  }).toString()}`;
  try {
    // OPTIMIZATION: Pass signal to fetch
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error("iTunes search failed");

    if (signal?.aborted) throw new Error("Fetch aborted");

    const data = await r.json();
    if (!Array.isArray(data.results)) return [];
    // Return the raw results, mapping is now handled by buildSongCard
    return data.results;
  } catch (e) {
    if (signal?.aborted) {
      console.log("Song search aborted");
      throw e;
    }
    console.warn("Song search error:", e);
    return [];
  }
}

// ==================== Add song to whiteboard ====================
// ... (addSongElement unchanged, but with read-only guard) ...
function addSongElement({ title, artist, cover }) {
  currentIndex += 1;
  // --- NEW: READ-ONLY GUARD ---
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;
  // --- END NEW ---
  
  const el = document.createElement("div");
  el.classList.add("board-item", "song-item");
  el.style.position = "absolute";

  // Add robust data attributes for serialization
  el.dataset.type = "song";
  el.dataset.title = title || "";
  el.dataset.artist = artist || "";
  el.dataset.cover = cover || "";

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale,
    visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale,
    visibleH = vpRect.height / scale;
  const x = visibleX + (visibleW - 320) / 2;
  const y = visibleY + (visibleH - 90) / 2;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const safeCover = cover || "";
  el.innerHTML = `
    <div class="song-left">
      <img class="song-cover" src="${safeCover}" alt="" />
      <div class="song-texts">
        <div class="song-name">${title}</div>
        <div class="song-artist">${artist}</div>
      </div>
    </div>
  `;

  workspace.appendChild(el);
  el.dataset.vkey =
    el.dataset.vkey || "v_" + Math.random().toString(36).slice(2);

  // OPTIMIZATION: Use .onmousedown
  el.onmousedown = (e) => {
    if (typeof startDragMouse === "function") startDragMouse(el, e);
  };

  onBoardMutated("add_song"); // AUTOSAVE (safe)
  return el;
}

// ---------- AUTOSAVE: Wire title edit ----------
// ... (Unchanged, but with read-only guard) ...
(function wireTitleAutosave() {
  function getTitleEl() {
    return (
      document.getElementById("title-textbox") ||
      document.getElementById("bible-whiteboard-title") ||
      document.querySelector('[data-role="board-title"]') ||
      null
    );
  }
  const el = getTitleEl();
  if (!el) return;

  const trigger = () => {
    // --- NEW: READ-ONLY GUARD ---
    if (window.__readOnly) return;
    // --- END NEW ---
    onBoardMutated("edit_title");
  }

  el.addEventListener("input", trigger, { passive: true });
  el.addEventListener("change", trigger, { passive: true });
  if (el.isContentEditable) {
    el.addEventListener("keyup", trigger, { passive: true });
    el.addEventListener("blur", trigger, { passive: true });
  }
})();

// ---------- AUTOSAVE: MutationObserver Fallback ----------
// ... (Unchanged, but with read-only guard) ...
(function initMutationObserver() {
  const observer = new MutationObserver((mutations) => {
    // --- NEW: READ-ONLY GUARD ---
    if (window.__readOnly) return;
    // --- END NEW ---
    
    // Skip during restore or active drag
    if (window.__RESTORING_FROM_SUPABASE || active || touchDragElement) return;

    let needsSave = false;
    for (const m of mutations) {
      if (m.type === "childList") {
        if (
          Array.from(m.addedNodes).some((n) =>
            n.classList?.contains("board-item")
          ) ||
          Array.from(m.removedNodes).some((n) =>
            n.classList?.contains("board-item")
          )
        ) {
          needsSave = true;
          break;
        }
      }
      if (
        m.type === "attributes" &&
        m.attributeName === "style" &&
        m.target.classList?.contains("board-item")
      ) {
        // This catches programmatic style changes *not* done by user drag
        needsSave = true;
        break;
      }
    }
    if (needsSave) {
      onBoardMutated("observer_fallback");
    }
  });

  observer.observe(workspace, {
    childList: true, // For .board-item adds/removes
    subtree: true, // To catch .board-item anywhere under workspace
    attributes: true, // For style changes
    attributeFilter: ["style"],
  });
})();

// ==================== Expose ====================
// ... (window.addBibleVerse unchanged) ...
window.addBibleVerse = addBibleVerse;

// ==================== NEW: Share Button Logic ====================
const shareBtn = document.getElementById("share-btn");
const sharePopover = document.getElementById("share-popover");
const shareLinkInput = document.getElementById("share-link");
const copyLinkBtn = document.getElementById("copy-link-btn");
const nativeShareBtn = document.getElementById("native-share-btn");

function getShareUrl() {
  const url = new URL(location.origin); // Use origin for a clean base
  url.pathname = "/board/index.html"; // Set canonical path
  if (BOARD_ID) url.searchParams.set("board", BOARD_ID);
  if (OWNER_UID) url.searchParams.set("owner", OWNER_UID);
  return url.toString();
}

function showToast(msg) {
  try {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    // Animation handles fade out, remove after
    setTimeout(() => {
      el.remove();
    }, 1600);
  } catch (e) {
    console.warn("Failed to show toast:", e);
  }
}

function toggleSharePopover(open) {
  const willOpen = open ?? sharePopover.hasAttribute("hidden");
  if (willOpen) {
    sharePopover.removeAttribute("hidden");
    shareBtn.setAttribute("aria-expanded", "true");
    shareLinkInput.value = getShareUrl();
    setTimeout(() => shareLinkInput.select(), 0); // Select after paint
  } else {
    sharePopover.setAttribute("hidden", "");
    shareBtn.setAttribute("aria-expanded", "false");
  }
}

shareBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSharePopover();
});

document.addEventListener("click", (e) => {
  if (
    sharePopover &&
    !sharePopover.hasAttribute("hidden") &&
    !sharePopover.contains(e.target) &&
    e.target !== shareBtn
  ) {
    toggleSharePopover(false);
  }
});

copyLinkBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
    showToast("Link copied");
  } catch {
    shareLinkInput.select();
    showToast("Press Ctrl/Cmd+C to copy");
  }
  toggleSharePopover(false); // Close popover on action
});

if (navigator.share) {
  nativeShareBtn.hidden = false;
  nativeShareBtn.addEventListener("click", async () => {
    try {
      await navigator.share({
        title: "Bible Board",
        text: `Check out this Bible Board: ${document.getElementById("title-textbox")?.value || ""}`,
        url: getShareUrl(),
      });
    } catch {}
    toggleSharePopover(false); // Close popover on action
  });
}

// ==================== NEW: Export Functions ====================

/**
 * Helper function to find the version picker in the settings panel.
 * @returns {HTMLSelectElement | null}
 */
function getSettingsVersionPicker() {
  return document.getElementById("board-settings-version-select");
}

/**
 * Syncs the settings panel picker FROM the search picker.
 */
function syncSettingsPickerFromSearch() {
  const searchPicker = document.getElementById("version-select");
  const settingsPicker = getSettingsVersionPicker();
  if (searchPicker && settingsPicker) {
    settingsPicker.value = searchPicker.value;
  }
}

/**
 * Syncs the search picker FROM the settings panel picker.
 */
function syncSearchPickerFromSettings() {
  const searchPicker = document.getElementById("version-select");
  const settingsPicker = getSettingsVersionPicker();
  if (searchPicker && settingsPicker) {
    // This updates the search picker AND localStorage
    setVersion(settingsPicker.value);
    onBoardMutated("settings_change"); // Trigger save
  }
}

/**
 * Generates a standard filename for board exports.
 * @param {string} suffix - e.g., "used_area"
 * @param {string} ext - e.g., "png"
 * @returns {string}
 */
function makeExportFilename(suffix, ext) {
  const title = (document.getElementById('title-textbox')?.value || 'BibleBoard')
    .trim().replace(/\s+/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${title}_${suffix}_${ts}.${ext}`;
}

/**
 * Triggers a browser download for a data URL.
 * @param {string} dataUrl - The base64-encoded data URL.
 * @param {string} filename - The desired filename.
 */
function downloadDataURL(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Finds all .board-item elements and calculates a tight bounding
 * box that contains all of them, plus padding.
 * @returns {{x: number, y: number, width: number, height: number} | null}
 */
function computeUsedBounds() {
  const items = Array.from(document.querySelectorAll('.board-item'));
  if (!items.length) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of items) {
    // read absolute position from inline styles (authoring model)
    const left = parseFloat(el.style.left || '0');
    const top  = parseFloat(el.style.top  || '0');
    const w = el.offsetWidth  || 0;
    const h = el.offsetHeight || 0;

    // Extend bounds to include the FULL element rect
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + w);
    maxY = Math.max(maxY, top  + h);
  }

  const pad = 64; // breathing room
  // Clamp min to 0 so we don't request negative origin (keeps math simple)
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  // Ceil to ensure we don't chop the bottom/right by a fraction
  const width  = Math.ceil((maxX + pad) - x);
  const height = Math.ceil((maxY + pad) - y);

  return { x, y, width, height };
}

/**
 * Sets crossOrigin="anonymous" on all images within a node
 * to prevent canvas tainting during export.
 * @param {HTMLElement} rootNode
 */
function sanitizeImagesForCanvas(root) {
  const imgs = root.querySelectorAll('img');
  imgs.forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('data:')) return;
    if (!img.crossOrigin) img.crossOrigin = 'anonymous';
  });
}

// Temporarily make .board-item backgrounds solid for export
function setTemporarySolidBackgrounds(root = document) {
  const items = root.querySelectorAll('.board-item');
  // Use the app's base bg/alt color—not the translucent token
  const solid = getComputedStyle(document.body).getPropertyValue('--bg-dots')?.trim()
             || getComputedStyle(document.body).getPropertyValue('--bg')?.trim()
             || '#ffffff';

  items.forEach(el => {
    // stash original inline values (not computed) so we can restore exactly
    el.dataset._prevBg = el.style.background || '';
    el.dataset._prevBackdrop = el.style.backdropFilter || '';

    el.style.background = solid;     // solid fill (no alpha)
    el.style.backdropFilter = 'none'; // disable blur—html-to-image can render weirdly with it
  });
}

function restoreBackgrounds(root = document) {
  const items = root.querySelectorAll('.board-item');
  items.forEach(el => {
    el.style.background = el.dataset._prevBg || '';
    el.style.backdropFilter = el.dataset._prevBackdrop || '';
    delete el.dataset._prevBg;
    delete el.dataset._prevBackdrop;
  });
}

/**
 * Main export function. Renders the used area of the board to a PNG.
 */
async function exportBoardPNGUsedArea({ scale = 1 } = {}) {
  const { viewport } = window.BoardAPI;
  const boardRoot = document.getElementById('workspace'); // wrapper that contains items + connections
  if (!boardRoot) { alert('Workspace not found'); return; }

  // Ensure connections are up to date, and layout is stable
  if (typeof updateAllConnections === 'function') updateAllConnections();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Compute tight bounds of used area (see section B)
  const box = computeUsedBounds();
  if (!box || box.width <= 0 || box.height <= 0) {
    alert('Nothing to export yet.');
    return;
  }

  // Sanitize images and set temporary solid backgrounds
  sanitizeImagesForCanvas(boardRoot);
  setTemporarySolidBackgrounds(boardRoot);

  // Shift the board so the box’s top-left renders at (0,0)
  const prevTransform = boardRoot.style.transform || '';
  const prevTransformOrigin = boardRoot.style.transformOrigin || '';
  boardRoot.style.transformOrigin = 'top left';
  boardRoot.style.transform = `translate(${-box.x}px, ${-box.y}px) scale(1)`;
  
  // Compute pixel size
  const outW = Math.ceil(box.width * scale);
  const outH = Math.ceil(box.height * scale);

  // Set a background color on the canvas so no part is transparent
  const bg = getComputedStyle(document.body).getPropertyValue('--bg')?.trim() || '#ffffff';

  try {
    const dataUrl = await window.htmlToImage.toPng(boardRoot, {
      width: outW,
      height: outH,
      // Fill the canvas background to avoid any transparent strips
      backgroundColor: bg,
      // Prevent clipping issues
      style: { overflow: 'visible', position: 'relative' },
      cacheBust: true
    });
    downloadDataURL(dataUrl, makeExportFilename('used', 'png'));
  } catch (e) {
    console.error('Export failed:', e);
    alert('Export failed. Try a smaller scale.');
  } finally {
    // Restore styles
    boardRoot.style.transform = prevTransform;
    boardRoot.style.transformOrigin = prevTransformOrigin;
    restoreBackgrounds(boardRoot);
  }
}


/**
 * Wires up the existing Export button to trigger a direct download.
 */
function initExportButton() {
  const exportBtn = document.getElementById("export-btn");

  if (!exportBtn) {
    console.warn("Export button not found. Skipping init.");
    return;
  }

  // Handle export click
  exportBtn.addEventListener("click", () => {
    // Check if there's anything to export
    const items = BoardAPI.workspace?.querySelectorAll(".board-item");
    if (!items || items.length === 0) {
      showToast("Nothing to export yet.");
      return;
    }
    // Trigger the export
    exportBoardPNGUsedArea();
  });
}


// Call the new init function on load
initExportButton();

// ==================== Read-Only Mode UI Guards ====================
// ... (Unchanged) ...
/**
 * Applies read-only guards to the UI, disabling all mutation actions.
 * Called by supabase-sync.js after board load.
 * @param {boolean} isReadOnly
 */
function applyReadOnlyGuards(isReadOnly) {
  window.__readOnly = isReadOnly; // Set global flag
  const actionButtons = document.getElementById("action-buttons-container");
  const titleInput = document.getElementById("title-textbox");
  const editIcon = document.getElementById("edit-Icon");
  const searchForm = document.getElementById('search-container'); // ADDED
  const tourBtn = document.getElementById('bb-tour-help-btn'); // ADDED
  const exportBtn = document.getElementById('export-btn'); // ADDED FOR EXPORT

  if (isReadOnly) {
    // 1. Hide mutation buttons (Connect, Add Note, Delete)
    if (actionButtons) actionButtons.style.display = "none";
    // 2. Disable title editing
    if (titleInput) {
      titleInput.readOnly = true; // CHANGED
      titleInput.title = "View-only: only the owner can edit.";
    }
    if (editIcon) editIcon.style.display = "none";

    // 3. Disable all text note editing
    document.querySelectorAll(".text-note .text-content").forEach((el) => {
      el.contentEditable = false;
      el.title = "View-only: only the owner can edit.";
    });
    // 4. Clear any lingering selection
    clearSelection();
    
    // 5. Hide search and tour (NEW)
    if (searchForm) searchForm.style.display = 'none';
    if (tourBtn) tourBtn.style.display = 'none';

    // 6. Show Export button (viewers can export)
    if (exportBtn) exportBtn.style.display = 'inline-block'; // Make sure it's visible

  } else {
    // Restore UI for owner
    if (actionButtons) actionButtons.style.display = "flex";
    if (titleInput) {
      titleInput.readOnly = false; // CHANGED
      titleInput.title = "";
    }
    if (editIcon) editIcon.style.display = "block";
    // --- NEW: Restore contentEditable ---
    document.querySelectorAll(".text-note .text-content").forEach((el) => {
      el.contentEditable = true;
      el.title = "";
    });
    // --- END NEW ---
    
    // 5. Restore search and tour (NEW)
    if (searchForm) searchForm.style.display = ''; // Use '' to reset to CSS default
    if (tourBtn) tourBtn.style.display = 'inline-block'; // Match supabase-sync.js logic

    // 6. Show Export button
    if (exportBtn) exportBtn.style.display = 'inline-block';
  }
}

// ==================== Serialization API ====================
// ... (serializeBoard and deserializeBoard unchanged) ...
function serializeBoard() {
  try {
    const items = Array.from(workspace.querySelectorAll(".board-item")).map(
      (el) => {
        const base = {
          vkey: itemKey(el),
          left: el.style.left,
          top: el.style.top,
          zIndex: el.style.zIndex || "10", // Default zIndex
          type: el.dataset.type || "unknown",
        };

        // Grab all data attributes for type-specific data
        switch (base.type) {
          case "verse":
            base.reference = el.dataset.reference;
            base.text = el.dataset.text;
            break;
          case "note":
            base.text = el.querySelector(".text-content")?.innerHTML || ""; // Get live text
            break;
          case "song":
            base.title = el.dataset.title;
            base.artist = el.dataset.artist;
            base.cover = el.dataset.cover;
            break;
          case "interlinear":
            base.reference = el.dataset.reference;
            base.surface = el.dataset.surface;
            base.english = el.dataset.english;
            base.translit = el.dataset.translit;
            base.morph = el.dataset.morph;
            base.strong = el.dataset.strong;
            break;
        }
        return base;
      }
    );

    const conns = connections.map((c) => ({
      a: itemKey(c.itemA),
      b: itemKey(c.itemB),
    }));

    const title = document.getElementById("title-textbox")?.value || "";

    const viewportData = {
      scale,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };

    return { title, viewport: viewportData, items, connections: conns };
  } catch (err) {
    console.error("❌ Serialization Failed:", err);
    return null; // Return null to prevent saving corrupt data
  }
}

function deserializeBoard(data) {
  if (!data) return;
  window.__RESTORING_FROM_SUPABASE = true;

  try {
    // Start fresh
    BoardAPI.clearBoard();

    // Title
    const titleEl = document.getElementById("title-textbox");
    if (titleEl) titleEl.value = data.title || "";

    // Items
    const itemEls = {}; // vkey -> element
    if (data.items) {
      data.items.forEach((item) => {
        let el;
        try {
          switch (item.type) {
            case "verse":
              el = addBibleVerse(item.reference, item.text, true);
              break;
            case "note":
              el = addTextNote(item.text);
              break;
            case "song":
              el = addSongElement(item);
              break;
            case "interlinear":
              el = addInterlinearCard(item);
              break;
            default:
              console.warn("Unknown item type during restore:", item.type);
          }
          if (el) {
            el.style.left = item.left;
            el.style.top = item.top;
            el.style.zIndex = item.zIndex || "10";
            el.dataset.vkey = item.vkey;
            itemEls[item.vkey] = el;
          }
        } catch (itemErr) {
          console.error("Failed to restore item:", item, itemErr);
        }
      });
    }

    // Connections
    if (data.connections) {
      data.connections.forEach((c) => {
        const elA = itemEls[c.a];
        const elB = itemEls[c.b];
        if (elA && elB) connectItems(elA, elB);
      });
    }

    // Viewport — prefer world-space center if provided
    if (data.viewport) {
      BoardAPI.setScale(data.viewport.scale || 1);

      const applyScrollFromCenter = () => {
        const sc = data.viewport.scale || 1;
        const targetLeft =
          data.viewport.centerX != null
            ? data.viewport.centerX * sc - viewport.clientWidth / 2
            : (data.viewport.scrollLeft || 0);
        const targetTop =
          data.viewport.centerY != null
            ? data.viewport.centerY * sc - viewport.clientHeight / 2
            : (data.viewport.scrollTop || 0);

        viewport.scrollLeft = Math.max(0, targetLeft);
        viewport.scrollTop = Math.max(0, targetTop);
      };

      applyScrollFromCenter();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          applyScrollFromCenter();
          clampScroll();
          updateViewportBars();
        })
      );

      window.__restoredBoard = true;
    }

    updateAllConnections(); // one full pass
  } catch (err) {
    console.error("❌ Error during board restore:", err);
    BoardAPI.clearBoard();
  } finally {
    window.__RESTORING_FROM_SUPABASE = false;
    setTimeout(() => {
      updateAllConnections();
      updateViewportBars();
      clampScroll();
    }, 50);
  }
}


// ... (Tour logic unchanged) ...
function buildBoardTourSteps() {
  let tempVerse = null;

  const steps = [
    {
      id: "welcome",
      title: "Welcome to Bible Board",
      text: "This quick tour shows you how to add verses, arrange them, connect ideas, and view interlinear details.",
      placement: "bottom", // Will be centered as it has no target
    },
    {
      id: "workspace",
      target: () => document.getElementById("workspace"),
      title: "Your Workspace",
      text: "This is your canvas. Drag with your mouse or finger to pan, and use the scroll wheel or pinch to zoom.",
      placement: "right",
      allowPointerThrough: true,
    },
    {
      id: "search",
      target: () => document.getElementById("search-bar"),
      title: "Search Anything",
      text: "Search for verses (like 'John 1:1') or topics (like 'love'). Press Enter or tap the search icon to begin.",
      placement: "top",
      beforeStep: () => {
        // Ensure search panel is open if we add that logic later
        // For now, it's always visible.
      },
    },
    {
      id: "Choose Version",
      target: () => document.getElementById("version-select"),
      title: "Choose your version",
      text: "Use the Version menu beside the search bar to choose your version. Searches fetch in that version, and any verse you add keeps its version label. You can change this anytime.",
      placement: "top",
      beforeStep: () => {
        // Ensure search panel is open if we add that logic later
        // For now, it's always visible.
      },
    },
    {
      id: "board-element",
      target: () => document.querySelector(".board-item.bible-verse"),
      title: "Arrange Your Cards",
      text: "Drag any card on the workspace to arrange your thoughts. You can create notes and add songs, too.",
      placement: "bottom",
      allowPointerThrough: true,
      beforeStep: async () => {
        // If no verse *on the board* exists, fake one
        if (!document.querySelector(".board-item.bible-verse")) {
          tempVerse = addBibleVerse(
            "John 3:16 KJV",
            "For God so loved the world...",
            true
          );
          tempVerse.id = "temp-tour-board-verse";
          // Position it in view
          const vpRect = viewport.getBoundingClientRect();
          tempVerse.style.left = `${(viewport.scrollLeft + vpRect.width / 2 - 150) / scale}px`;
          tempVerse.style.top = `${(viewport.scrollTop + vpRect.height / 2 - 100) / scale}px`;
        }
      },
      afterStep: () => {
        const tempBoardVerse = document.getElementById("temp-tour-board-verse");
        if (tempBoardVerse) {
          tempBoardVerse.remove();
        }
        tempVerse = null;
      },
    },
    {
      id:"connect",
      target: () => document.getElementById("mobile-action-button"),
      title: "Connect Ideas",
      text: "Select a card, then tap this 'Connect' button. Tap another card to draw a line between them.",
      placement: "right",
      padding: 8, // <-- ADDED THIS LINE for extra padding
      allowPointerThrough: true, // <-- ADD THIS LINE
    },
    {
      id: "notes",
      target: () => document.getElementById("text-action-button"),
      title: "Add Notes",
      text: "Tap this 'note' button to add a blank note card to your board. You can type anything you want!",
      placement: "right",
      allowPointerThrough: true, // <-- ADD THIS LINE
    },
    {
      id: "interlinear",
      target: () => document.getElementById("interlinear-action-button"),
      title: "Go Deeper",
      text: "Select a verse card, then tap the 'Interlinear' button to open a word-by-word breakdown of the original language.",
      placement: "right",
      allowPointerThrough: true, // <-- ADD THIS LINE
    },

    {
      id: "delete",
      target: () => document.getElementById("delete-action-button"),
      title: "Delete Item",
      text: "Select a item on the bible board, then tap the 'Delete' button to delete the selected item.",
      placement: "right",
      allowPointerThrough: true, // <-- ADD THIS LINE
    },
    {
      id: "finish",
      title: "You're All Set!",
      text: "You're ready to build your board. Try searching for a verse now to get started."
      // allowPointerThrough: true, // <-- ADD THIS LINE
    },
  ];

  return steps;
}

function setupBoardSettingsPanel() {
  const runSetup = () => {
    // 1. --- Guards ---
    if (document.getElementById('board-settings-toggle')) return; // Already setup
    const body = document.getElementById("main-content-container");
    if (!body) return;

    // 2. --- Create Toggle Button ---
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'board-settings-toggle';
    toggleBtn.className = 'toggle-btn'; // Use existing class from index.html
    toggleBtn.setAttribute('aria-label', 'Board Settings');
    toggleBtn.setAttribute('aria-haspopup', 'true');
    toggleBtn.setAttribute('aria-expanded', 'false');
    // Simple Gear SVG Icon
    toggleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="width: 22px; height: 22px; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.08-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>`;
    
    // Style toggle button (fixed position, replaces old theme toggle)
    toggleBtn.style.position = 'absolute';
    toggleBtn.style.top = '15px';
    toggleBtn.style.right = '15px';
    toggleBtn.style.zIndex = '10003'; 

    // 3. --- Create Panel ---
    const panel = document.createElement('div');
    panel.id = 'board-settings-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'board-settings-title');
    
    // Style panel
    panel.style.position = 'absolute';
    panel.style.right = '70px'; // Below 50px button + 25px top + 10px gap
    panel.style.top = '15px';
    panel.style.minWidth = '240px';
    panel.style.background = 'var(--bg-seethroug)';
    panel.style.border = '1px solid var(--fg-seethrough)';
    panel.style.backdropFilter = 'blur(1rem)';
    panel.style.borderRadius = '12px';
    panel.style.padding = '12px';
    panel.style.zIndex = '10004';
    panel.style.display = 'none'; // Start hidden

    // 4. --- Create Panel Internals ---
    panel.innerHTML = `<div id="board-settings-title" style="font-size: 1rem; font-weight: 700; color: var(--fg); padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 12px;">Settings</div>
                       <div id="board-settings-content" style="display: flex; flex-direction: column; gap: 8px;"></div>`;
    const content = panel.querySelector('#board-settings-content');

    // Helper to create muted labels
    const createLabel = (text) => {
      const label = document.createElement('div');
      label.textContent = text;
      label.style.fontSize = '0.75rem';
      label.style.fontWeight = '700';
      label.style.color = 'var(--muted)';
      label.style.textTransform = 'uppercase';
      label.style.padding = '8px 0 4px 4px';
      label.style.marginTop = '4px';
      return label;
    };

    // Helper to reset moved button styles for stacking
    const resetPosition = (el) => {
      if (!el) return;
      el.style.position = 'relative';
      el.style.top = 'auto';
      el.style.left = 'auto';
      el.style.right = 'auto';
      el.style.width = '100%';
      el.style.boxSizing = 'border-box'; // Ensure padding doesn't break 100% width
    };

    // 5. --- Find and Move Elements ---
    const themeToggle = document.getElementById('theme-toggle');
    const exportBtn = document.getElementById('export-btn');
    const shareBtn = document.getElementById('share-btn');
    const tourBtn = document.getElementById('bb-tour-help-btn');

    // Appearance Section
    if (themeToggle) {
      content.appendChild(createLabel('Appearance'));
      resetPosition(themeToggle);
      
      // Add a text label *inside* the button (modifies button, but required for context)
      const themeLabel = document.createElement('span');
      themeLabel.textContent = 'Theme';
      themeLabel.style.fontWeight = '700';
      themeLabel.style.fontSize = '15px';
      themeToggle.style.justifyContent = 'space-between';
      themeToggle.style.padding = '5px 15px';
      themeToggle.style.height = '40px';
      themeToggle.prepend(themeLabel); // Add label
      
      content.appendChild(themeToggle);
    }
    
    // Board Actions Section
    if (exportBtn || shareBtn) {
       content.appendChild(createLabel('Board Actions'));
       if (exportBtn) {
         resetPosition(exportBtn);
         content.appendChild(exportBtn);
       }
       if (shareBtn) {
         resetPosition(shareBtn);
         content.appendChild(shareBtn);
       }
    }

    // Help Section
    if (tourBtn) {
      content.appendChild(createLabel('Help'));
      resetPosition(tourBtn);
      content.appendChild(tourBtn);
    }
    
    // 6. --- Append New UI to Body ---
    body.appendChild(toggleBtn);
    body.appendChild(panel);

    // 7. --- Open/Close/Focus Logic ---
    const openPanel = () => {
      panel.style.display = 'block';
      toggleBtn.setAttribute('aria-expanded', 'true');
      localStorage.setItem('bb_settings_open', 'true');
      
      // Focus first focusable element in panel
      const firstFocusable = panel.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (firstFocusable) firstFocusable.focus();
    };

    const closePanel = () => {
      panel.style.display = 'none';
      toggleBtn.setAttribute('aria-expanded', 'false');
      localStorage.setItem('bb_settings_open', 'false');
      toggleBtn.focus(); // Return focus to the toggle
    };

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = panel.style.display === 'none';
      if (isHidden) openPanel();
      else closePanel();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.style.display !== 'none') {
        closePanel();
      }
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) {
        closePanel();
      }
    });

    // 8. --- Restore State from localStorage ---
    if (localStorage.getItem('bb_settings_open') === 'true') {
      openPanel();
    }
  };

  // --- Invocation ---
  if (document.readyState !== 'loading') {
    runSetup();
  } else {
    document.addEventListener('DOMContentLoaded', runSetup);
  }
}

setupBoardSettingsPanel();

// ===== expose a small API for the Supabase module (keep at end of script.js) =====
// ... (BoardAPI definition unchanged) ...
window.BoardAPI = {
  // DOM
  workspace,
  viewport,
  svg,

  // scale control (your code already updates `scale` & transform)
  getScale: () => scale,
  setScale: (s) => {
    scale = s;
    workspace.style.transformOrigin = "top left";
    workspace.style.transform = `scale(${scale})`;
  },

  // creators used during load/hydration
  addBibleVerse, // (reference, text) => HTMLElement
  addTextNote, // (text) => HTMLElement
  addInterlinearCard, // ({surface, english, translit, morph, strong, reference}) => HTMLElement
  addSongElement, // ({title, artist, cover}) => HTMLElement

  // connections management used during load/hydration
  getConnections: () => connections, // Expose for serialization
  connectItems, // (aEl, bEl) => void
  disconnectLine, // (svgPath) => void
  removeConnectionsFor, // (el) => void
  updateAllConnections, // () => void
  getElementByVKey: (key) => document.querySelector(`[data-vkey="${key}"]`),

  // stable key helper
  itemKey, // (el) => string
  
  applyReadOnlyGuards, // NEW: Expose for supabase-sync

  // Board clear for load/sign-out
  clearBoard: () => {
    // Clear elements
    workspace.querySelectorAll(".board-item").forEach((el) => el.remove());
    // Clear connections
    svg.innerHTML = ""; // Fast way to remove all paths
    connections = []; // Reset internal array
    selectedItem = null;
    updateActionButtonsEnabled();
  },

  // --- Persistence Hooks ---
  // The external supabase-sync.js is EXPECTED to set saveBoard
  // The internal persist-helper.js will SET triggerAutosave and forceFlushSave

  /**
   * (OVERWRITTEN BY persist-helper.js)
   * Triggers a debounced save.
   * @param {string} reason Why the save is being triggered.
   */
  triggerAutosave: (reason) =>
    console.warn("Persistence not initialized", reason),

  /**
   * (OVERWRITTEN BY persist-helper.js)
   * Triggers an immediate save, canceling any debounce.
   * @param {string} reason Why the save is being forced.
   */
  forceFlushSave: (reason) =>
    console.warn("Persistence not initialized", reason),

  /**
   * (SET BY EXTERNAL an external module, e.g., supabase-sync.js)
   * The actual function that performs the save.
   * @param {object} payload The JSON-serializable board state.
   * @returns {Promise<void>} A promise that resolves on success and rejects on failure.
   */
  saveBoard: null,

  /**
   * (IMPLEMENTED IN script.js)
   * Serializes the entire board state into a JSON object.
   * @returns {object | null} The board state or null on failure.
   */
  serializeBoard,

  /**
   * (IMPLEMENTED IN script.js)
   * Clears and restores the board from a serialized state object.
   * @param {object} data The board state object.
   */
  deserializeBoard,
};










































