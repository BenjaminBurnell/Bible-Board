/*
 * ================== PERFORMANCE OPTIMIZATIONS V3 (USER REQUEST) ==================
 * This file has been updated to implement type-ahead prefetching
 * and a smart "Bible-to-Songs" fallback.
 *
 * 1.  Type-ahead Prefetching:
 * - `TYPE_AHEAD_ENABLED` is set to `true`.
 * - `onSearchInput` now calls `prefetchSearchForQuery` instead of `searchForQuery`.
 * - A new `typeAheadController` is used to manage prefetch aborts.
 * - `prefetchSearchForQuery` silently calls `fetchChapterText` or `fetchSongs`
 * to warm the caches without updating any UI.
 *
 * 2.  Caching:
 * - A new `chapterCache` (LRU) is added to store full chapter data.
 * - A new `songsCache` (LRU) is added to store song search results.
 * - `fetchChapterText` is modified to use `chapterCache`.
 * - `fetchSongs` is modified to use `songsCache`.
 *
 * 3.  Smart Fallback:
 * - `searchForQuery` in "bible" mode now has a `try/catch` block.
 * - If `findBibleVerseReference` fails to parse *or* `fetchChapterText` fails
 * (e.g., "John 99"), it's considered a "no match".
 * - A "no match" triggers `runSongsFallback`, which calls `setSearchMode("songs")`
 * and runs the song search logic on the same query.
 * - Song rendering logic is refactored into `renderSongResults` to be
 * re-usable by both the normal songs path and the fallback.
 * ==============================================================================
 */

// ==================== Performance Constants ====================
const CACHE_SIZE = 200; // Max items for LRU caches
const CHAPTER_CACHE_SIZE = 50; // Chapters are larger, use a smaller cache
const DEBOUNCE_MS = 300; // Wait time for type-ahead search
const BATCH_SIZE = 5; // Verse texts to fetch in parallel
const INITIAL_VISIBLE_COUNT = 5; // show up to 3 fully-loaded verses/songs
const SEARCH_RESULT_LIMIT = 100; // Items to fetch for virt... (was 5)
const LOAD_MORE_CHUNK = 5; // How many verses/songs per "load more" click

// Disable all type-ahead behavior
const TYPE_AHEAD_ENABLED = true; // <-- MODIFIED: Enabled as requested

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

// --- Z-ORDER HELPERS ---
// Ensure newest or interacted items rise above others.
// Uses existing `currentIndex` that already drives initial z-index.
function bringToFront(el) {
  if (!el || window.__readOnly) return;
  currentIndex += 1;
  el.style.zIndex = currentIndex;
}

// Delegate: bump z-index on ANY pointerdown inside a .board-item,
// even if the click is on an editable child and we don't start a drag.
document.addEventListener('pointerdown', (ev) => {
  const card = ev.target && ev.target.closest && ev.target.closest('.board-item');
  if (!card) return;
  bringToFront(card);
}, { capture: true });


/**
 * Performance instrumentation helper.
 */
let perfTimer = 0;
function startPerfTimer() {
  perfTimer = performance.now();
}
function logPerf(label) {
  const now = performance.now();
  // console.log(`[Perf] ${label}: ${Math.round(now - perfTimer)}ms`);
  perfTimer = now;
}

/**
 * A simple LRU (Least Recently Used) cache wrapper for the Map API.
 */
class LruCache {
  constructor(maxSize, storageKey = null) {
    this.maxSize = maxSize;
    this.storageKey = storageKey;
    this.cache = new Map();
    
    // Load from storage on init
    if (this.storageKey) {
      try {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          const entries = JSON.parse(stored);
          this.cache = new Map(entries);
        }
      } catch (e) { console.warn("Cache load failed", e); }
    }
  }

  _persist() {
    if (!this.storageKey) return;
    try {
      // Save as array of entries
      localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.cache.entries())));
    } catch (e) { 
      // Storage full? Clear it.
      console.warn("Cache save failed", e); 
      this.cache.clear(); 
    }
  }

  get(key) {
    const val = this.cache.get(key);
    if (val) {
      this.cache.delete(key);
      this.cache.set(key, val);
      this._persist(); // Update order
    }
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
    this._persist();
  }
  
  has(key) { return this.cache.has(key); }
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
 * NEW: LRU Cache for full chapters.
 */
const chapterCache = new LruCache(CHAPTER_CACHE_SIZE);
/**
 * NEW: LRU Cache for song search results.
 */
const songsCache = new LruCache(CACHE_SIZE);
const bibleSearchCache = new LruCache(CACHE_SIZE);

/**
 * OPTIMIZATION: Shared AbortController for all search queries.
 * This is reset in `searchForQuery`.
 */
let globalSearchController = null;
/**
 * NEW: Separate AbortController for background type-ahead prefetching.
 */
let typeAheadController = null;

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
  // Strategy 1: Direct Fetch (Fastest, works if API supports CORS)
  async (url, signal) =>
    fetch(url, { mode: "cors", signal, credentials: "omit" }),

  // Strategy 2: AllOrigins (Fallback)
  async (url, signal) =>
    fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
      signal,
      credentials: "omit",
    }),

  // Strategy 3: CodeTabs
  async (url, signal) =>
    fetch(`https://api.codetabs.com/v1/proxy?quest=${url}`, {
      signal,
      credentials: "omit",
    }),
    
  // Strategy 4: ThingProxy
  async (url, signal) =>
    fetch(`https://thingproxy.freeboard.io/fetch/${url}`, {
      signal,
      credentials: "omit",
    }),
];
/**
 * (Existing)
 */
async function safeFetchWithFallbacks(url, signal) {
  let lastError = null;

  for (const [index, fetchStrategy] of FETCH_STRATEGIES.entries()) {
    if (signal?.aborted) throw new Error("Fetch aborted by user");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(new Error("Fetch timeout")),
        7000
      );

      // Only hook the abort listener if a signal was provided
      let abortListener = null;
      if (signal) {
        abortListener = () =>
          controller.abort(new Error("Fetch aborted by user"));
        signal.addEventListener("abort", abortListener, { once: true });
      }

      const resp = await fetchStrategy(url, controller.signal);

      // Cleanup
      clearTimeout(timeoutId);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }

      if (!resp.ok) {
        throw new Error(
          `Strategy ${index + 1} failed with status: ${resp.status}`
        );
      }

      // console.log(
      //   `Fetch strategy ${index + 1} succeeded for: ${url.substring(0, 100)}...`
      // );
      return resp;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      console.warn(`Fetch strategy ${index + 1} failed:`, err.message);
    }
  }

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
  document.getElementById("version-select")?.addEventListener("change", () => {
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
  const apiUrl = `https://full-bible-api.onrender.com/verse/${encodeURIComponent(
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
      // console.log("Verse fetch aborted.");
      // Re-throw abort so searchForQuery() can catch it and stop processing
      throw err;
    }

    // console.error("❌ Error fetching verse (all fallbacks failed):", err);
    return "Verse temporarily unavailable."; // Graceful error
  }
}

// ==================== NEW: Bible Search API Helpers ====================
let activeBibleSearchController = null;
/**
 * OPTIMIZATION: Use LRU cache
 * MODIFIED: Now includes the Bible 'version' in the API call and cache key.
 */
async function fetchBibleSearchResults(query, limit = 5, signal, version = "KJV") { // ADDED version
  if (!query) return [];

  // MODIFIED: Added version to cache key
  const key = `${version.toLowerCase()}:${query.toLowerCase()}::${limit}`;
  const cached = bibleSearchCache.get(key); // .get() updates recency
  if (cached) return cached;

  // Use the provided signal from searchForQuery
  const effSignal = signal;

  // MODIFIED: Added version parameter to the URL
  const url = `https://full-bible-api.onrender.com/search?q=${encodeURIComponent(
    query
  )}&version=${encodeURIComponent(version)}&limit=${limit}`;

  try {
    // IMPORTANT: use the same multi-proxy CORS bypass helper
    const resp = await safeFetchWithFallbacks(url, effSignal);
    const data = await resp.json();
    const refs = Array.isArray(data?.references) ? data.references : [];
    bibleSearchCache.set(key, refs);
    return refs;
  } catch (e) {
    if (effSignal?.aborted) return [];
    // console.error("Search API error:", e);
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
  if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse))
    return null;
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
const floatingAddBtn = document.getElementById("floating-add-to-board-btn");

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
let currentSearchMode = "bible";
let interlinearInFlight = null; // AbortController for in-flight fetch
let interlinearSeq = 0; // Sequence number to prevent race conditions

// --- NEW: Verse Multi-Select Queue State ---
const pendingVerseAdds = new Map();

// NEW: Song queue (parallel to verse queue)
window.pendingSongAdds = window.pendingSongAdds || new Map();

// NEW: Interlinear queue (parallel to others)
window.pendingInterlinearAdds = window.pendingInterlinearAdds || new Map();

// OPTIMIZATION: Throttled version of updateAllConnections
const throttledUpdateAllConnections = throttleRAF(updateAllConnections);
const throttledUpdateViewportBars = throttleRAF(updateViewportBars);

function updateViewportBars() {
  if (!viewport || !workspace) return;

  // Content extents follow clampScroll(): width/height are scaled by `scale`
  const contentW =
    workspace.offsetWidth * (typeof scale === "number" ? scale : 1);
  const contentH =
    workspace.offsetHeight * (typeof scale === "number" ? scale : 1);

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
  const thumbXLeftPx = Math.round(
    (trackX.width - thumbXWidthPx) * thumbFracLeft
  );

  thumbX.style.width = `${thumbXWidthPx}px`;
  thumbX.style.left = `${thumbXLeftPx}px`;

  // --- Vertical thumb (inside #viewbar-y) ---
  const trackY = viewbarY.getBoundingClientRect();
  const thumbY = viewbarY.querySelector(".vb-thumb");
  const thumbYHeightPx = Math.max(10, Math.round(trackY.height * fracH));
  const thumbYTopPx = Math.round(
    (trackY.height - thumbYHeightPx) * thumbFracTop
  );

  thumbY.style.height = `${thumbYHeightPx}px`;
  thumbY.style.top = `${thumbYTopPx}px`;
}

function applyLayout(withTransition = true) {
  // const offset = (searchDrawerOpen ? 340 : 0) + (interlinearOpen ? 340 : 0);

  // if (withTransition) mainContentContainer.style.transition = ".25s";
  // mainContentContainer.style.width = offset
  //   ? `calc(100% - ${offset}px)`
  //   : "100%";

  if (withTransition) searchQueryContainer.style.transition = ".25s";

  searchQueryContainer.style.zIndex = searchDrawerOpen
    ? `10005`
    : "-1";

  setTimeout(function() {
    searchQueryContainer.style.top = searchDrawerOpen
      ? `0px`
      : "20px";

    searchQueryContainer.style.opacity = searchDrawerOpen
      ? `1`
      : "0";
  })

  interPanel.classList.toggle("open", interlinearOpen);

  if (withTransition) {
    setTimeout(() => {
      mainContentContainer.style.transition = "0s";
      searchQueryContainer.style.transition = "0s";
    }, 500);
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
/**
 * NEW: Displays the "Did you mean" suggestion in the UI.
 * @param {object} result The suggestion object from findBibleVerseReference
 */
function showDidYouMeanSuggestion(result) {
  if (!didYouMeanText || !result || !result.reference) {
    if (didYouMeanText) didYouMeanText.style.display = 'none';
    return;
  }

  // Use the structure from style.css (div is already styled as a link)
  didYouMeanText.innerHTML = `Did you mean <div>${result.reference}</div>?`;
  didYouMeanText.style.display = 'flex'; // Make it visible

  const link = didYouMeanText.querySelector('div');
  if (link) {
    // Use .onclick to ensure only one handler is attached
    link.onclick = (e) => {
      e.preventDefault();
      if (searchBar) {
        searchBar.value = result.reference; // Set input to suggestion
      }
      didYouMeanText.style.display = 'none'; // Hide suggestion
      searchForQuery(null); // Re-run search with the correct query
    };
  }
}
/**
 * NEW: Fetches an entire chapter from the API.
 * MODIFIED: Now uses `chapterCache`.
 */
async function fetchChapterText(book, chapter, signal, version = "KJV") {
  const code = bibleBookCodes[book] || book;
  const apiUrl = `https://full-bible-api.onrender.com/chapter/${encodeURIComponent(
    version
  )}/${encodeURIComponent(code)}/${chapter}`;
  
  // --- NEW: Check cache first ---
  const cacheKey = `${version}:${code}:${chapter}`;
  const cached = chapterCache.get(cacheKey);
  if (cached) {
    console.log(`[Cache] HIT: ${cacheKey}`);
    return cached;
  }
  console.log(`[Cache] MISS: ${cacheKey}`);
  // --- END NEW ---

  // OPTIMIZATION: Check signal before fetching
  if (signal?.aborted) throw new Error("Fetch aborted");

  try {
    // We can use the existing multi-proxy fetch helper
    const resp = await safeFetchWithFallbacks(apiUrl, signal);
    const data = await resp.json();

    if (!data || !Array.isArray(data.verses)) {
      throw new Error("Invalid chapter data received.");
    }
    
    // --- NEW: Store in cache on success ---
    if (data.verses.length > 0) {
      chapterCache.set(cacheKey, data.verses);
    }
    // --- END NEW ---
    
    return data.verses; // e.g., [{ verse: 1, text: "..." }, ...]
  } catch (err) {
    if (signal?.aborted) {
      // console.log("Chapter fetch aborted.");
      throw err; // Re-throw abort
    }
    // console.error("❌ Error fetching chapter (all fallbacks failed):", err);
    throw err; // Re-throw for searchForQuery to catch
  }
}

/**
 * NEW: Renders a list of verses into the search panel.
 * MODIFIED: Accepts book/version, adds data-attributes and add button.
 */
function renderChapter(container, verses, targetVerse, refString, book, version) {
  if (!container || !verses || verses.length === 0) {
    container.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">No matching verses found.</div>`;
    return;
  }

  const verseList = document.createElement("div");
  verseList.className = "verse-list-container";

  // Get chapter number from refString (e.g., "John 3" -> "3")
  const chapterNum = refString.match(/\d+$/)?.[0] || "";
  let html = "";

  for (const verse of verses) {
    const isTarget = verse.verse == targetVerse; // Use == for number/string comparison
    const fullRef = `${book} ${chapterNum}:${verse.verse}`;
    const text = verse.text.replace(/"/g, "&quot;"); // Escape quotes for data-text

    // Check if this verse is already in the pending queue
    const key = `${fullRef}::${version}`;
    const isSelected = pendingVerseAdds.has(key);
    const selectedClass = isSelected ? 'selected-for-add' : '';
    const btnSelectedClass = isSelected ? 'selected' : '';

    html += `
      <div class="verse ${isTarget ? 'highlighted' : ''} ${selectedClass}" 
           data-verse="${verse.verse}" 
           data-ref="${fullRef}" 
           data-version="${version}" 
           data-text="${text}">
        <span class="verse-number">${verse.verse}</span>
        <span class="verse-text">${verse.text}</span>
        <button class="search-query-verse-add-button ${btnSelectedClass}" 
                aria-label="Add verse ${fullRef}">
        </button>
      </div>
    `;
  }

  verseList.innerHTML = html;
  container.innerHTML = ""; // Clear loader/previous
  container.appendChild(verseList);
}

/**
 * NEW: Renders a list of individual verse data (from text search)
 * using the same style as the chapter view.
 */
function renderVerseList(container, versesData, version) {
  if (!container || !versesData || versesData.length === 0) {
    container.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">No matching verses found.</div>`;
    return;
  }

  const verseList = document.createElement("div");
  verseList.className = "verse-list-container"; // Use same class as chapter view

  let html = "";

  for (const verseData of versesData) {
    const fullRef = verseData.ref;
    const text = verseData.text.replace(/"/g, "&quot;"); // Escape quotes

    // Check if this verse is already in the pending queue
    const key = `${fullRef}::${version}`;
    const isSelected = pendingVerseAdds.has(key);
    const selectedClass = isSelected ? 'selected-for-add' : '';
    const btnSelectedClass = isSelected ? 'selected' : '';

    html += `
      <div class="verse verse-card-style ${selectedClass}" 
           data-ref="${fullRef}" 
           data-version="${version}" 
           data-text="${text}">
        
        <span class="verse-number verse-ref-style">${fullRef}</span>
        
        <span class="verse-text verse-text-style">${verseData.text}</span>
        
        <button class="search-query-verse-add-button ${btnSelectedClass}" 
                aria-label="Add verse ${fullRef}">
        </button>
      </div>
    `;
  }

  verseList.innerHTML = html;
  container.innerHTML = ""; // Clear loader/previous
  container.appendChild(verseList);
}


/**
 * NEW: Scrolls the search panel to a specific verse number.
 */
function scrollToVerse(verseNumber) {
  if (!verseNumber) return;

  // Wait for the DOM to update after rendering
  requestAnimationFrame(() => {
    const panel = document.getElementById("search-query-content");
    if (!panel) return;

    const verseElement = panel.querySelector(`[data-verse="${verseNumber}"]`);
    
    if (verseElement) {
      verseElement.scrollIntoView({
        behavior: "smooth",
        block: "center", // Centers the verse in the panel
      });
    }
  });
}

/**
 * NEW: Manages the search mode state and UI.
 */



function mountInterlinearInline() {
  const container = document.getElementById("search-query-content");
  const interPanel = document.getElementById("interlinear-panel");
  if (!interPanel || !container) return;
  if (interPanel.parentElement !== container) {
    container.appendChild(interPanel);
  }
  // Make it look/behave like the other sections (inline, no overlay)
  interPanel.style.position = "static";
  interPanel.style.top = "auto";
  interPanel.style.left = "auto";
  interPanel.style.width = "auto";
  interPanel.style.background = "transparent";
  interPanel.style.border = "none";
  interPanel.style.boxShadow = "none";
  interPanel.style.padding = "0";
  interPanel.style.maxHeight = "none";
  interPanel.style.overflow = "visible";
}

/**
 * UPDATED: Handles switching modes and VISIBILITY of the main container.
 * Fixes the issue where Bible/Music tabs appeared empty after an Interlinear search.
 */
function setSearchMode(mode, opts = {}) {
  if (mode !== "bible" && mode !== "songs" && mode !== "interlinear") return;
  const { openDrawer = false } = opts;

  currentSearchMode = mode;

  if (openDrawer) {
    searchDrawerOpen = true;
    try { applyLayout && applyLayout(true); } catch {}
  }

  const verseContainer = document.getElementById("search-query-verse-container");
  const songsContainer = document.getElementById("search-query-song-container");
  const interlinearPanelEl = document.getElementById("interlinear-panel");
  const fullContainer = document.getElementById("search-query-full-container"); // <--- NEW REF

  const versesHeader = document.getElementById("search-query-verses-text");
  const songsHeader  = document.getElementById("search-query-songs-text");

  // 1. Reset standard containers (Hide all first)
  if (verseContainer) verseContainer.style.display = "none";
  if (songsContainer) songsContainer.style.display = "none";
  if (interlinearPanelEl) interlinearPanelEl.style.display = "none";
  if (versesHeader) versesHeader.style.display = "none";
  if (songsHeader)  songsHeader.style.display  = "none";

  // 2. Update pills
  document.getElementById("search-mode-bible")?.classList.toggle("active", mode === "bible");
  document.getElementById("search-mode-songs")?.classList.toggle("active", mode === "songs");
  document.getElementById("search-mode-interlinear")?.classList.toggle("active", mode === "interlinear");

  // 3. Handle specific modes and FULL CONTAINER visibility
  if (mode === "bible") {
    // Show standard container
    if (fullContainer) fullContainer.style.display = "flex"; 
    
    if (versesHeader) versesHeader.style.display = "block";
    if (verseContainer) verseContainer.style.display = "block";
    
  } else if (mode === "songs") {
    // Show standard container
    if (fullContainer) fullContainer.style.display = "flex";

    if (songsHeader) songsHeader.style.display = "block";
    if (songsContainer) songsContainer.style.display = "grid";
    
  } else if (mode === "interlinear") {
    // Hide standard container so Interlinear can take over
    if (fullContainer) fullContainer.style.display = "none";

    // Mount inline and show the panel
    if (typeof mountInterlinearInline === 'function') mountInterlinearInline();
    if (interlinearPanelEl) interlinearPanelEl.style.display = "block";
  }
}

/**
 * NEW: Updates the floating "Add to Board" button's visibility and text.
 * Updated to include Interlinear items.
 */
function updateFloatingAddButton() {
  if (!floatingAddBtn) return;

  const vCount = pendingVerseAdds.size;
  const sCount = window.pendingSongAdds ? window.pendingSongAdds.size : 0;
  const iCount = window.pendingInterlinearAdds ? window.pendingInterlinearAdds.size : 0;

  const count = vCount + sCount + iCount;

  // If nothing is selected, hide and clear the button
  if (count === 0) {
    floatingAddBtn.style.display = "none";
    floatingAddBtn.replaceChildren?.() || (floatingAddBtn.innerHTML = "");
    return;
  }

  // Show the button
  floatingAddBtn.style.display = "inline-flex"; 

  // Clear any previous content
  floatingAddBtn.replaceChildren?.() || (floatingAddBtn.innerHTML = "");

  // Label text
  const labelSpan = document.createElement("span");
  labelSpan.textContent = `Add ${count} item${count > 1 ? "s" : ""}`;
  floatingAddBtn.appendChild(labelSpan);

  // SVG icon
  const SVG_NS = "http://www.w3.org/2000/svg";
  const iconElement = document.createElementNS(SVG_NS, "svg");
  iconElement.setAttribute("class", "add-to-board-icon-open");
  iconElement.setAttribute("viewBox", "0 -960 960 960");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M212-86q-53 0-89.5-36.5T86-212v-536q0-53 36.5-89.5T212-874h268v126H212v536h536v-268h126v268q0 53-36.5 89.5T748-86H212Zm207-246-87-87 329-329H560v-126h314v314H748v-101L419-332Z");
  iconElement.appendChild(path);
  floatingAddBtn.appendChild(iconElement);
}

/**
 * NEW: Toggles a verse's selection in the pending queue.
 * @param {HTMLElement} cardEl The verse card element (.verse or .search-query-verse-container)
 */
function toggleVerseSelection(cardEl) {
  if (!cardEl) return;

  const ref = cardEl.dataset.ref;
  const version = cardEl.dataset.version;
  const text = cardEl.dataset.text;
  const key = `${ref}::${version}`;

  const addBtn = cardEl.querySelector('.search-query-verse-add-button');

  if (pendingVerseAdds.has(key)) {
    // --- Remove from queue ---
    pendingVerseAdds.delete(key);
    cardEl.classList.remove("selected-for-add");
    addBtn?.classList.remove("selected");
  } else {
    // --- Add to queue ---
    if (!ref || !version || !text) {
      console.warn("Could not add verse, missing data:", cardEl);
      return;
    }
    pendingVerseAdds.set(key, { ref, text, version });
    cardEl.classList.add("selected-for-add");
    addBtn?.classList.add("selected");
  }

  updateFloatingAddButton();
}

/**
 * 1. helper function to toggle selection in the global map
 * Paste this near the bottom of script.js
 */
function toggleInterlinearSelection(btn, row, data) {
  // Ensure the map exists
  if (!window.pendingInterlinearAdds) window.pendingInterlinearAdds = new Map();
  
  // Create a unique key based on reference + word
  const key = `${data.reference}::${data.surface}`;

  if (window.pendingInterlinearAdds.has(key)) {
    // REMOVE
    window.pendingInterlinearAdds.delete(key);
    row.classList.remove("selected-for-add");
    btn.classList.remove("selected");
  } else {
    // ADD
    window.pendingInterlinearAdds.set(key, data);
    row.classList.add("selected-for-add");
    btn.classList.add("selected");
  }

  // Update the floating button (helper from script.js)
  if (typeof updateFloatingAddButton === "function") {
    updateFloatingAddButton();
  }
}

/**
 * UPDATED: Adds all pending verses, songs, AND interlinear items with ANIMATION DELAYS.
 */
function handleFloatingAddClick() {
  clearSelection();
  closeInterlinearPanel();
  closeSearchQuery();

  // Snapshot queues
  const versesToAdd = Array.from(pendingVerseAdds.values());
  const songsToAdd  = window.pendingSongAdds ? Array.from(window.pendingSongAdds.values()) : [];
  const interlinearToAdd = window.pendingInterlinearAdds ? Array.from(window.pendingInterlinearAdds.values()) : [];

  if (versesToAdd.length === 0 && songsToAdd.length === 0 && interlinearToAdd.length === 0) return;

  // Clear queues immediately
  pendingVerseAdds.clear();
  if (window.pendingSongAdds) window.pendingSongAdds.clear();
  if (window.pendingInterlinearAdds) window.pendingInterlinearAdds.clear();

  let delay = 0.05; // Start with a tiny delay

  // 1. Add Verses
  for (const { ref, text, version } of versesToAdd) {
    window.BoardAPI.addBibleVerse(ref, text, false, version, delay);
    delay += 0.10; // Stagger effect
    prefetchAdjacentVerses(ref, null, version);
  }

  // 2. Add Songs
  for (const song of songsToAdd) {
    if (typeof window.BoardAPI.addSongElement === "function") {
      window.BoardAPI.addSongElement(song, delay);
    }
    delay += 0.10;
  }

  // 3. Add Interlinear Items (NOW WITH DELAY)
  for (const item of interlinearToAdd) {
    window.BoardAPI.addInterlinearCard(item, delay); 
    delay += 0.10; 
  }

  // Clear visual selection states
  document.querySelectorAll(".selected-for-add").forEach(el => {
    el.classList.remove("selected-for-add");
    el.querySelector('.search-query-verse-add-button')?.classList.remove('selected');
  });

  updateFloatingAddButton();
}


// --- NEW: Add global click listener for the floating button ---
floatingAddBtn?.addEventListener("click", function() {
  handleFloatingAddClick()
});


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

// ==================== Action helpers ====================

/**
 * Deletes a board item, removing it and its connections.
 * This is the canonical entry point for deletion, allowing
 * it to be wrapped by the undo/redo manager.
 * @param {HTMLElement} el The board item to delete.
 */
function deleteBoardItem(el) {
  // GUARD: Do not allow deletion in read-only mode
  if (!el || window.__readOnly) return;

  // Use BoardAPI functions if available (they are)
  window.BoardAPI.removeConnectionsFor(el);
  try {
    el.remove();
  } catch (_e) {}

  // Trigger save (safe due to onBoardMutated restore check)
  onBoardMutated("delete_item");
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
          {
            clientX: pendingMouseDrag.startX,
            clientY: pendingMouseDrag.startY,
          },
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
    viewport.scrollTop = scrollTop - (e.clientY - startY); // ← fixed

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
  bringToFront(item);
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
  // FIX: Get the viewport's position on the screen
  const vpRect = viewport.getBoundingClientRect();

  // Calculate mouse position relative to the viewport container
  // (Screen Mouse X - Container Left Edge)
  const relX = clientX - vpRect.left;
  const relY = clientY - vpRect.top;

  // Convert to workspace coordinates (World Space)
  const newLeft = (viewport.scrollLeft + relX) / scale - offsetX;
  const newTop = (viewport.scrollTop + relY) / scale - offsetY;

  // Clamp to workspace boundaries
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

let connections = [];
let disconnectMode = false;

function setDisconnectMode(enabled) {
  disconnectMode = !!enabled;
  document.body.classList.toggle("disconnect-mode", disconnectMode);
}

function toggleDisconnectMode() {
  setDisconnectMode(!disconnectMode);
}

function isDisconnectMode() {
  return !!disconnectMode;
}

function connectionExists(a, b) {
  if (!a || !b) return false;
  const ka = itemKey(a);
  const kb = itemKey(b);
  return connections.some((c) => {
    const ca = itemKey(c.itemA);
    const cb = itemKey(c.itemB);
    return (ca === ka && cb === kb) || (ca === kb && cb === ka);
  });
}

/**
 * Center-to-center curved connection (original behavior),
 * plus optional midpoint handle positioning.
 * Expects a full connection object: { path, itemA, itemB, handle? }
 */
function updateConnection(conn) {
  if (!conn) return;
  const { path, itemA, itemB, handle } = conn;
  if (!path || !itemA || !itemB) return;

  const vpRect = viewport.getBoundingClientRect();
  const r1 = itemA.getBoundingClientRect();
  const r2 = itemB.getBoundingClientRect();

  if ((!r1.width && !r1.height) || (!r2.width && !r2.height)) return;

  const p1 = {
    x:
      (viewport.scrollLeft +
        (r1.left - vpRect.left) +
        r1.width / 2) / scale,
    y:
      (viewport.scrollTop +
        (r1.top - vpRect.top) +
        r1.height / 2) / scale,
  };

  const p2 = {
    x:
      (viewport.scrollLeft +
        (r2.left - vpRect.left) +
        r2.width / 2) / scale,
    y:
      (viewport.scrollTop +
        (r2.top - vpRect.top) +
        r2.height / 2) / scale,
  };

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let d;

  if (absDx < 40 || absDy < 40) {
    // Short distance → straight line
    d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
  } else {
    // Original smooth curve
    const s = 0.7;
    let c1x = p1.x;
    let c1y = p1.y;
    let c2x = p2.x;
    let c2y = p2.y;

    if (absDx > absDy) {
      // Mostly horizontal layout
      c1x += dx * s;
      c2x -= dx * s;
      c1y += dy * 0.1;
      c2y -= dy * 0.1;
    } else {
      // Mostly vertical layout
      c1y += dy * s;
      c2y -= dy * s;
      c1x += dx * 0.1;
      c2x -= dx * 0.1;
    }

    d = `M${p1.x},${p1.y} C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }

  path.setAttribute("d", d);

  // Keep handle at midpoint of current path
  if (handle) {
    try {
      const length = path.getTotalLength();
      if (length > 0 && Number.isFinite(length)) {
        const mid = path.getPointAtLength(length / 2);
        if (mid && Number.isFinite(mid.x) && Number.isFinite(mid.y)) {
          handle.setAttribute(
            "transform",
            `translate(${mid.x}, ${mid.y})`
          );
        }
      }
    } catch {
      // don't break drawing if geometry not ready
    }
  }
}

function updateAllConnections() {
  connections.forEach((c) => updateConnection(c));
}

/**
 * Create a new connection: center-to-center curve
 * + hidden X-handle that becomes visible only in disconnect mode.
 */
function connectItems(a, b) {
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;
  if (!a || !b || a === b || connectionExists(a, b)) return;

  const SVG_NS = "http://www.w3.org/2000/svg";

  const path = document.createElementNS(SVG_NS, "path");
  path.classList.add("connection-line");
  path.style.pointerEvents = "stroke";
  svg.appendChild(path);

  // Midpoint delete handle (only shown in disconnect mode via CSS)
  const handleGroup = document.createElementNS(SVG_NS, "g");
  handleGroup.classList.add("connection-handle");

  const circle = document.createElementNS(SVG_NS, "circle");
  circle.classList.add("handle-circle");
  circle.setAttribute("r", "9");

  const line1 = document.createElementNS(SVG_NS, "line");
  line1.classList.add("handle-cross");
  line1.setAttribute("x1", "-4");
  line1.setAttribute("y1", "-4");
  line1.setAttribute("x2", "4");
  line1.setAttribute("y2", "4");

  const line2 = document.createElementNS(SVG_NS, "line");
  line2.classList.add("handle-cross");
  line2.setAttribute("x1", "-4");
  line2.setAttribute("y1", "4");
  line2.setAttribute("x2", "4");
  line2.setAttribute("y2", "-4");

  handleGroup.appendChild(circle);
  handleGroup.appendChild(line1);
  handleGroup.appendChild(line2);

  // Only active in disconnect mode
  handleGroup.onclick = (e) => {
    e.stopPropagation();
    if (!disconnectMode || window.__readOnly) return;
    window.BoardAPI.disconnectLine(path);
  };

  svg.appendChild(handleGroup);

  const conn = { path, itemA: a, itemB: b, handle: handleGroup };
  connections.push(conn);

  updateConnection(conn);
  onBoardMutated("connect_items");
}

/**
 * Remove a single connection by its path element.
 */
function disconnectLine(path) {
  if (window.__readOnly) return;

  const idx = connections.findIndex((c) => c.path === path);
  if (idx === -1) return;

  const conn = connections[idx];

  if (conn.handle) {
    try {
      svg.removeChild(conn.handle);
    } catch (_e) {}
  }
  try {
    svg.removeChild(conn.path);
  } catch (_e) {}

  connections.splice(idx, 1);
  onBoardMutated("disconnect_line");
}

/**
 * Remove all connections touching the given element.
 */
function removeConnectionsFor(el) {
  if (window.__readOnly) return;

  let changed = false;
  connections = connections.filter((c) => {
    if (c.itemA === el || c.itemB === el) {
      if (c.handle) {
        try {
          svg.removeChild(c.handle);
        } catch (_e) {}
      }
      try {
        svg.removeChild(c.path);
      } catch (_e) {}
      changed = true;
      return false;
    }
    return true;
  });

  if (changed) onBoardMutated("remove_connections_for_item");
}

// --- Expose to other modules (undo-redo, colors, supabase, UI, etc.) ---

window.BoardAPI = window.BoardAPI || {};
window.BoardAPI.connectItems = connectItems;
window.BoardAPI.disconnectLine = disconnectLine;
window.BoardAPI.removeConnectionsFor = removeConnectionsFor;
window.BoardAPI.getConnections = () => connections;
window.BoardAPI.itemKey = itemKey;
window.BoardAPI.updateAllConnections = updateAllConnections;

window.BoardAPI.setDisconnectMode = setDisconnectMode;
window.BoardAPI.toggleDisconnectMode = toggleDisconnectMode;
window.BoardAPI.isDisconnectMode = isDisconnectMode;



// ==================== Element Creation ====================
function addBibleVerse(
  reference,
  text,
  createdFromLoad = false,
  version = null,
  delay=0,

) {
  currentIndex += 1;
  // GUARD: Allow creation during load/restore, but not by user action
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "bible-verse");
  if(delay != 0) {
    el.style.opacity = "0";
    el.style.animation = "loadItemToBoard 1s forwards " + delay + "s"
  };
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
  const randX = visibleX + 0.5 * (visibleW - 300);
  const randY = visibleY + 0.5 * (visibleH - 200);
  el.style.left = `${randX + delay * 200}px`;
  el.style.top = `${randY + delay * 200}px`;
  el.style.zIndex = currentIndex;
  // console.log(currentIndex)

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
  el.style.zIndex = currentIndex;

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

// Ensure this function is attached to BoardAPI
if (!window.BoardAPI) window.BoardAPI = {};
window.BoardAPI.addInterlinearCard = addInterlinearCard;

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
  // if (versesHeader) versesHeader.style.display = "block";

  if (verseContainer) {
    verseContainer.style.display = "block";
    verseContainer.innerHTML = ""; // Clear for single-verse result

    // Check if this verse is already in the pending queue
    const key = `${reference}::${version}`;
    const isSelected = pendingVerseAdds.has(key);
    const selectedClass = isSelected ? 'selected-for-add' : '';
    const btnSelectedClass = isSelected ? 'selected' : '';

    const item = document.createElement("div");
    item.classList.add("search-query-verse-container", selectedClass);
    // Add data attributes to the card itself
    item.dataset.ref = reference;
    item.dataset.version = version;
    item.dataset.text = text;
    
    item.innerHTML = `
      <div class="search-query-verse-text">${text}</div>
      <div class="search-query-verse-reference">– ${reference} ${version.toUpperCase()}</div>
      <button class="search-query-verse-add-button ${btnSelectedClass}" 
              aria-label="Add verse ${reference}">
      </button>
    `;

    // Click is now handled by the event delegation listener, so no .onclick needed here.
    
    verseContainer.appendChild(item);
  }
}

function displayNoVerseFound(reference) {
  const versesHeader = document.getElementById("search-query-verses-text");
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
  // if (versesHeader) versesHeader.style.display = "block";
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
/**
 * OPTIMIZED: Fetches verse texts in PARALLEL instead of sequentially.
 * @param {Array<{ref: string, el: HTMLElement}>} verseBatch
 * @param {AbortSignal} signal
 */
async function fillVerseBatch(verseBatch, signal, version) {
  // Map each verse element to a fetch promise
  const promises = verseBatch.map(async ({ ref, el }) => {
    if (signal?.aborted) return;
    if (el.dataset.status === "ready") return;

    const parts = parseReferenceToParts(ref);
    if (!parts) {
      el.dataset.status = "error";
      el.querySelector(".search-query-verse-text").textContent = "Verse not found.";
      return;
    }

    try {
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
        return;
      }

      // Populate real text and enable Add
      el.dataset.status = "ready";
      el.dataset.ref = ref;
      el.dataset.version = version;
      el.dataset.text = text;

      el.querySelector(".search-query-verse-text").textContent = text;
      el.querySelector(".search-query-verse-text").style.color = ""; 
      el.querySelector(".search-query-verse-text").style.textAlign = ""; 

      let addBtn = el.querySelector(".search-query-verse-add-button");
      if (!addBtn) {
        addBtn = document.createElement("button");
        addBtn.className = "search-query-verse-add-button";
        addBtn.setAttribute("aria-label", `Add verse ${ref}`);
        el.appendChild(addBtn);
      }

      const key = `${ref}::${version}`;
      if (pendingVerseAdds.has(key)) {
        el.classList.add("selected-for-add");
        addBtn.classList.add("selected");
      }
      
      addBtn.disabled = false;
    } catch (err) {
      if (!signal?.aborted) {
         console.warn(`Failed to load ${ref}`, err);
         el.querySelector(".search-query-verse-text").textContent = "Error loading text.";
      }
    }
  });

  // Wait for ALL fetches in this batch to finish (or fail) concurrently
  await Promise.all(promises);
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
    btn.type = "button"; // Good practice

    // --- FIX: Stop click from bubbling ---
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // Stop this click from reaching the document
      onClick(); // Run the original load more logic
    });
    // --- END FIX ---

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
 *G * @returns {HTMLElement}
 */
function buildVerseCard(ref, text, signal, version) {
  const item = document.createElement("div");
  item.classList.add("search-query-verse-container");
  item.dataset.status = "ready"; // Mark as ready

  // --- NEW: Add data attributes ---
  item.dataset.ref = ref;
  item.dataset.version = version;
  item.dataset.text = text;
  // --- END NEW ---

  // Check if it should be selected
  const key = `${ref}::${version}`;
  if (pendingVerseAdds.has(key)) {
    item.classList.add("selected-for-add");
  }
  const btnSelectedClass = pendingVerseAdds.has(key) ? 'selected' : '';

  item.innerHTML = `
    <div class="search-query-verse-text">${text}</div>
    <div class="search-query-verse-reference">– ${ref} ${version.toUpperCase()}</div>
    <button class="search-query-verse-add-button ${btnSelectedClass}" 
            aria-label="Add verse ${ref}">
    </button>
  `;

  // Click is handled by event delegation, no .onclick needed
  return item;
}

/**
 * Creates a final, ready-to-add song card element.
 * Uses existing classes from style.css to maintain visuals.
 * @param {object} song - A song object from fetchSongs (e.g., { trackName, artistName, artworkUrl100 })
 * @returns {HTMLElement}
 */


function buildSongCard(song) {
  // Normalize song fields
  const title  = song.title  || song.trackName || song.name || '';
  const artist = song.artist || song.artistName || song.author || '';
  const lyrics = song.lyrics || '';
  const cover  = song.cover  || song.artworkUrl100 || song.image || '';

  // Container: flex row (image | text | + button)
  const row = document.createElement('div');
  row.className = 'search-query-verse-container verse song-row';
  row.dataset.title  = title;
  row.dataset.artist = artist;
  row.dataset.lyrics = lyrics;
  row.dataset.cover  = cover;

  // Image (left)
  const img = document.createElement('img');
  img.className = 'song-cover';
  img.alt = title ? `Cover art for ${title}` : 'Cover art';
  if (cover) img.src = cover;

  // Text container (middle)
  const textWrap = document.createElement('div');
  textWrap.className = 'song-meta';

  const titleEl = document.createElement('div');
  titleEl.className = 'song-title';
  titleEl.textContent = title || 'Untitled';

  const artistEl = document.createElement('div');
  artistEl.className = 'song-artist';
  artistEl.textContent = artist || 'Unknown';

  textWrap.appendChild(titleEl);
  textWrap.appendChild(artistEl);

  // + button (right) — reuse verse add button class
  const addBtn = document.createElement('button');
  addBtn.className = 'search-query-verse-add-button';
  addBtn.setAttribute('aria-label', `Add song ${title} by ${artist}`);

  function toggle() {
    if (!window.pendingSongAdds) window.pendingSongAdds = new Map();
    const key = `song::${(title||'').trim()}::${(artist||'').trim()}`;
    if (window.pendingSongAdds.has(key)) {
      window.pendingSongAdds.delete(key);
      row.classList.remove('selected-for-add');
      addBtn.classList.remove('selected');
    } else {
      window.pendingSongAdds.set(key, { title, artist, lyrics, cover });
      row.classList.add('selected-for-add');
      addBtn.classList.add('selected');
    }
    if (typeof window.updateFloatingAddButton === 'function') window.updateFloatingAddButton();
  }

  addBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
  row.addEventListener('click', (e) => {
    if (e.target && e.target.closest('.search-query-verse-add-button')) return;
    toggle();
  });

  // Assemble
  row.appendChild(img);
  row.appendChild(textWrap);
  row.appendChild(addBtn);

  return row;
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
    btn.type = "button"; // Good practice

    // --- FIX: Stop click from bubbling ---
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // Stop this click from reaching the document
      onClick(); // Run the original load more logic
    });
    // --- END FIX ---

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
 * REFACTORED: Background prefetch function for type-ahead.
 * MODIFIED: Now uses isReferenceShaped to prefetch the correct API.
 */
function prefetchSearchForQuery(query) {
  // Abort any previous prefetch
  if (typeAheadController) {
    typeAheadController.abort();
  }
  typeAheadController = new AbortController();
  const { signal } = typeAheadController;
  const version = getSelectedVersion();

  // This is a "fire and forget" prefetch.
  // We swallow errors as this is non-critical.
  (async () => {
    try {
      // --- NEW: Use isReferenceShaped ---
      const refShaped = window.isReferenceShaped ? window.isReferenceShaped(query) : false;

      // --- 1. ALWAYS prefetch songs ---
      fetchSongs(query, SEARCH_RESULT_LIMIT, signal).catch(() => {});
      console.log(`[Prefetch] Warmed songs cache for "${query}"`);

      // --- 2. Prefetch correct Bible data ---
      if (refShaped) {
        // It looks like a reference, try to parse it
        const bibleRef = window.findBibleVerseReference ? window.findBibleVerseReference(query) : null;
        if (bibleRef && bibleRef.book && bibleRef.chapter) {
          // Prefetch the full chapter (e.g., "John 3:16" or "Josua 1:9" -> "Joshua 1:9")
          fetchChapterText(bibleRef.book, bibleRef.chapter, signal, version).catch(() => {});
          console.log(`[Prefetch] Warmed chapter cache for ${bibleRef.book} ${bibleRef.chapter}`);
        } else {
          // It's reference-shaped but didn't parse (e.g., "Asdf 1:1" or "Josua 1:9" -> didYouMean)
          // We can't prefetch a chapter, so just prefetch text search as a fallback.
          fetchBibleSearchResults(query, SEARCH_RESULT_LIMIT, signal, version).catch(() => {});
          console.log(`[Prefetch] Warmed bible text search for "${query}" (ref-shaped fallback)`);
        }
      } else {
        // NOT reference-shaped (e.g., "love")
        // Prefetch the text search results
        fetchBibleSearchResults(query, SEARCH_RESULT_LIMIT, signal, version).catch(() => {});
        console.log(`[Prefetch] Warmed bible text search for "${query}" (text query)`);
      }
    } catch (err) {
      if (!signal.aborted) {
        console.warn("[Prefetch] Failed:", err.message);
      }
    }
  })();
}

/**
 * OPTIMIZATION: Debounced input handler.
 * MODIFIED: Now calls `prefetchSearchForQuery` instead of `searchForQuery`.
 */
function onSearchInput(e) {
  clearTimeout(searchDebounceTimer);
  const query = e.target.value.trim();

  // Don't search for empty or very short strings
  if (!query || query.length < 3) {
    // If query is empty, close the panel
    // if (!query) closeSearchQuery();
    return;
  }

  startPerfTimer(); // Start perf timer for debounced search
  logPerf("debounce_start");

  searchDebounceTimer = setTimeout(() => {
    // MODIFIED: Call prefetch, not the full UI search
    prefetchSearchForQuery(query);
  }, DEBOUNCE_MS);
}

// Bind the debounced handler
if (TYPE_AHEAD_ENABLED && searchBar) {
  searchBar.addEventListener("input", onSearchInput);
}

/**
 * NEW: Refactored song rendering logic.
 * MODIFIED: Respects isBackground flag.
 */
function renderSongResults(songs, songsContainer, signal, options = {}) {
  const { isBackground = false } = options;
  const readySongs = (songs || []).filter(s => s && s.trackName && s.artistName);
  songsContainer.innerHTML = ""; // Clear previous results

  if (readySongs.length === 0) {
    // Only show "No songs found" if this is the primary search,
    // not the background pre-load.
    if (!isBackground) {
      songsContainer.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">No songs found.</div>`;
    }
    return; // Nothing more to do
  }

  // ... (rest of the function is unchanged) ...
  const initialSongs = readySongs.slice(0, INITIAL_VISIBLE_COUNT);
  const remainingSongs = readySongs.slice(INITIAL_VISIBLE_COUNT);

  for (const s of initialSongs) {
    const card = buildSongCard(s);
    songsContainer.appendChild(card);
  }

  if (remainingSongs.length > 0) {
    const loadMore = () => {
      if (signal?.aborted) return;
      const next = remainingSongs.splice(0, LOAD_MORE_CHUNK);
      for (const s of next) {
        const card = buildSongCard(s);
        const btn = songsContainer.querySelector("#load-more-songs-btn");
        if (btn) {
          songsContainer.insertBefore(card, btn);
        } else {
          songsContainer.appendChild(card);
        }
      }
      if (remainingSongs.length === 0) {
        songsContainer.querySelector("#load-more-songs-btn")?.remove();
      }
    };
    ensureSongsLoadMoreButton(songsContainer, loadMore);
  }
}

/**
 * NEW: Smart fallback function to run a song search.
 * MODIFIED: Now calls the new runSongsSearch helper.
 */
async function runSongsFallback(query, signal, version) {
  // console.log("Bible search failed, falling back to Songs mode...");
  setSearchMode("songs");
  
  // Reset header text from "John 3" back to the query
  if (typeof searchQuery !== "undefined") {
    searchQuery.textContent = `Search for "${query}"`;
  }
  
  // Run the song search as the primary task (not background)
  await runSongsSearch(query, signal, version, { isBackground: false });
}

/**
 * NEW: Sanitizes a string to be safe for insertion into HTML.
 * Prevents XSS by converting special characters to HTML entities.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * NEW HELPER: Runs the song search and renders the results.
 * Can be run in "background" mode to pre-load the tab.
 */
async function runSongsSearch(query, signal, version, options = {}) {
  const { isBackground = false } = options;
  const songsContainer = document.getElementById("search-query-song-container");
  if (!songsContainer) return;

  // In background mode, we just clear the container.
  // In foreground mode, we'll let renderSongResults show the error.
  if (isBackground) {
    songsContainer.innerHTML = "";
  }
  
  try {
    const songs = await fetchSongs(query, SEARCH_RESULT_LIMIT, signal);
    if (signal.aborted) return;
    
    // Only log performance if it's the *main* task
    if (!isBackground) {
      logPerf("songs_data_received (primary)");
    }

    // Pass the isBackground flag to the renderer
    renderSongResults(songs, songsContainer, signal, { isBackground });

  } catch (err) {
    if (signal.aborted) return;
    // Only show errors if we're not in the background
    if (!isBackground) {
      // console.error("Error in song search:", err);
      // ESCAPE USER INPUT HERE
      const safeQuery = escapeHtml(query);
      const safeMessage = err.message ? escapeHtml(err.message) : `No songs found for "${safeQuery}".`;
      songsContainer.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">${safeMessage}</div>`;
    }
  }
}

/**
 * MODIFIED: Now accepts an options object to run as a background task.
 * Runs the full Bible REFERENCE (chapter) search logic.
 * THROWS on failure (e.g., "John 99" not found).
 */
async function runBibleSearch(bibleRef, signal, version, options = {}) { // Added options
  const { isBackground = false } = options; // Destructure
  const verseContainer = document.getElementById("search-query-verse-container");
  if (!verseContainer) throw new Error("Internal UI error.");

  // 1. We already have the reference, so we can skip parsing.
  const result = bibleRef; // Use the passed-in ref
  
  if (!result || !result.book || !result.chapter) {
    // This should technically not be hit if searchForQuery is correct,
    // but it's a good safeguard.
    throw new Error(`Invalid Bible reference passed to runBibleSearch.`);
  }

  // 2. Set header and fetch full chapter
  const refString = `${result.book} ${result.chapter}`;
  
  // --- MODIFICATION ---
  if (!isBackground) {
    // Only update UI text if this is the primary task
    if (searchQuery) searchQuery.textContent = `Search for "${searchBar.value}"`;
    if (didYouMeanText) didYouMeanText.style.display = "none"; // Always hide suggestion on success
  }
  // --- END MODIFICATION ---

  // This will throw if fetch fails (e.g., John 99)
  const verses = await fetchChapterText(result.book, result.chapter, signal, version);

  if (!verses || verses.length === 0) {
    // This will also be caught and trigger song fallback
    throw new Error(`No verses found for ${refString}.`);
  }
  
  if (signal.aborted) throw new Error("Search aborted");
  
  if (!isBackground) { // Log perf only for primary task
    logPerf("chapter_data_received");
  }

  // 3. Render chapter (This is safe, it just populates the hidden container)
  renderChapter(verseContainer, verses, result.verse, refString, result.book, version);

  // 4. Scroll to verse
  if (result.verse && !isBackground) { // Only scroll if primary
    scrollToVerse(result.verse);
  }
  
  return true; // Success
}

/**
 * NEW: Runs a full-text search for Bible verses.
 * Renders results as verse cards and falls back to songs on 0 results (if primary).
 */
async function runBibleTextSearch(query, signal, version, options = {}) { // Added options
  const { isBackground = false } = options; // Destructure
  const verseContainer = document.getElementById("search-query-verse-container");
  if (!verseContainer) throw new Error("Internal UI error.");

  // --- MODIFICATION ---
  if (!isBackground) {
    // Set header back to "Search for..." since it's not a chapter view
    // .textContent is SAFE, so we don't need to escape here
    if (searchQuery) searchQuery.textContent = `Search for "${query}"`;
    if (didYouMeanText) didYouMeanText.style.display = "none"; // Hide suggestion
  }
  // --- END MODIFICATION ---
  
  try {
    // 1. Fetch search results (list of references)
    // MODIFIED: Passed 'version'
    const refs = await fetchBibleSearchResults(query, SEARCH_RESULT_LIMIT, signal, version);
    if (signal.aborted) return;

    if (!isBackground) { // Log perf only for primary task
      logPerf("bible_text_search_refs_received");
    }

    // 2. Check for "no match"
    if (!refs || refs.length === 0) {
      // --- MODIFICATION (Restored) ---
      if (!isBackground) {
        // Only run song fallback if this was the *primary* task
        console.warn(`Bible text search for "${query}" found 0 results. Falling back to songs.`);
        await runSongsFallback(query, signal, version); // <-- This is the restored fallback
      } else {
        // If background, just show "No results" in the hidden tab
        verseContainer.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">No matching verses found.</div>`;
      }
      return; // Done.
      // --- END MODIFICATION ---
    }

    // 3. We have results! Render them as verse cards. (Unchanged)
    verseContainer.innerHTML = ""; // Clear loader/previous
    
    // Create placeholders for fillVerseBatch
    const verseElements = [];
    for (const ref of refs) {
      const item = document.createElement("div");
      item.classList.add("search-query-verse-container"); 
      item.classList.add("loading"); // <-- ADD THIS
      item.dataset.status = "pending"; // Mark for fillVerseBatch
      
      item.dataset.version = version;

      // Basic skeleton
      item.innerHTML = `
        <div class="search-query-verse-text">Loading...</div>
        <div class="search-query-verse-reference">– ${ref} ${version.toUpperCase()}</div>
        <button class="search-query-verse-add-button" 
                aria-label="Add verse ${ref}" disabled>
        </button>
      `;
      verseContainer.appendChild(item);
      verseElements.push({ ref, el: item });
    }

    // 4. Progressively load text and wire up buttons (Unchanged)
    const initialBatch = verseElements.slice(0, INITIAL_VISIBLE_COUNT);
    const remainingBatch = verseElements.slice(INITIAL_VISIBLE_COUNT);

    // Load initial batch first for responsiveness
    await fillVerseBatch(initialBatch, signal, version);

    if (!isBackground) { // Log perf only for primary task
      logPerf("bible_text_search_initial_batch_rendered");
    }

    // Handle the rest with a "Load more" button
    if (remainingBatch.length > 0) {
      const loadMore = async () => {
        if (signal?.aborted) return;
        const next = remainingBatch.splice(0, LOAD_MORE_CHUNK);
        await fillVerseBatch(next, signal, version);
        
        if (remainingBatch.length === 0) {
          verseContainer.querySelector("#load-more-verses-btn")?.remove();
        }
      };
      
      ensureLoadMoreButton(verseContainer, loadMore);
    }
    
  } catch (err) {
    if (signal.aborted) return;
    // --- MODIFICATION: SECURITY FIX ---
    if (!isBackground) {
      // Only show errors in the UI if this was the primary task
      // console.error("Error in Bible text search:", err);
      
      // ESCAPE USER INPUT HERE
      const safeQuery = escapeHtml(query);
      const safeMessage = err.message ? escapeHtml(err.message) : `No results found for "${safeQuery}".`;

      verseContainer.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">${safeMessage}</div>`;
    }
    // --- END MODIFICATION ---
  }
}

/**
 * OPTIMIZATION: Use LRU cache
 * MODIFIED: Now includes the Bible 'version' in the API call and cache key.
 */
async function fetchBibleSearchResults(query, limit = 5, signal, version = "KJV") { // ADDED version
  if (!query) return [];
  
  // MODIFIED: Added version to cache key
  const key = `${version.toLowerCase()}:${query.toLowerCase()}::${limit}`;
  const cached = bibleSearchCache.get(key); // .get() updates recency
  if (cached) return cached;

  // Use the provided signal from searchForQuery
  const effSignal = signal;

  // MODIFIED: Added version parameter to the URL
  const url = `https://full-bible-api.onrender.com/search?q=${encodeURIComponent(
    query
  )}&version=${encodeURIComponent(version)}&limit=${limit}`;

  try {
    // IMPORTANT: use the same multi-proxy CORS bypass helper
    const resp = await safeFetchWithFallbacks(url, effSignal);
    const data = await resp.json();
    const refs = Array.isArray(data?.references) ? data.references : [];
    bibleSearchCache.set(key, refs);
    return refs;
  } catch (e) {
    if (effSignal?.aborted) return [];
    // console.error("Search API error:", e);
    return [];
  }
}

/**
 * REFACTORED: Handles search for "Bible", "Songs", or "Interlinear" mode.
 * - FIX: Shows "Did you mean" suggestions in Interlinear mode.
 * - FIX: Runs background searches so other tabs aren't empty when switching.
 */
async function searchForQuery(event) {
  // --- 1. Setup & Abort ---
  if (event) {
    event.preventDefault(); // Form submit
  }

  const input = document.getElementById("search-bar");
  const rawQuery = (input?.value || "").trim(); 

  if (!rawQuery) return false;

  startPerfTimer();
  logPerf("search_start");

  input?.blur();

  // Abort previous search (and any lingering prefetch)
  clearTimeout(searchDebounceTimer);
  if (typeAheadController) {
    typeAheadController.abort();
    typeAheadController = null;
  }
  if (globalSearchController) {
    globalSearchController.abort();
  }
  globalSearchController = new AbortController();
  const { signal } = globalSearchController;
  const version = getSelectedVersion();

  // --- 2. Show Skeleton UI & Open Panel ---
  // Reset "Did You Mean" initially
  if (typeof didYouMeanText !== "undefined")
    didYouMeanText.style.display = "none"; 
  
  if (typeof searchQueryFullContainer !== "undefined")
    searchQueryFullContainer.style.display = "none";
  if (typeof loader !== "undefined") loader.style.display = "flex";

  searchDrawerOpen = true;
  
  // Only close interlinear panel if we are NOT in interlinear mode
  if (currentSearchMode !== "interlinear" && interlinearOpen) {
      closeInterlinearPanel();
  }
  
  applyLayout(true); // This triggers the slide-up animation

  if (typeof searchQuery !== "undefined")
    searchQuery.textContent = `Search for "${rawQuery}"`;

  // Get containers and clear them for the new results
  const verseContainer = document.getElementById("search-query-verse-container");
  const songsContainer = document.getElementById("search-query-song-container");
  if (verseContainer) verseContainer.innerHTML = "";
  if (songsContainer) songsContainer.innerHTML = "";

  // This will be the *active* mode shown to the user
  setSearchMode(currentSearchMode);
  logPerf("skeleton_rendered");

  // --- 3. Determine Search Paths ---
  try {
    // 1. Decide if it's reference-shaped
    const refShaped = window.isReferenceShaped ? window.isReferenceShaped(rawQuery) : false;
    
    // 2. Only attempt to parse a Bible reference if it's reference-shaped
    const bibleRefInfo = refShaped && window.findBibleVerseReference
      ? window.findBibleVerseReference(rawQuery)
      : null;
    
    const isClearBibleRef = bibleRefInfo && bibleRefInfo.book && bibleRefInfo.chapter;
    const isDidYouMean = refShaped && bibleRefInfo && bibleRefInfo.didYouMean && !isClearBibleRef;

    let primarySearchPromise;

    // --- CASE: INTERLINEAR MODE ---
    if (currentSearchMode === "interlinear") {
       
       // A. "Did You Mean" Logic (NEW)
       if (isDidYouMean) {
          showDidYouMeanSuggestion(bibleRefInfo);
       }

       // B. Primary Task: Interlinear
       if (typeof window.openInterlinearFromCurrentQuery === "function") {
           primarySearchPromise = window.openInterlinearFromCurrentQuery();
       } else {
           primarySearchPromise = Promise.resolve();
       }
       
       // Hide the loader since openInterlinearFromCurrentQuery manages its own loader
       if (loader) loader.style.display = "none"; 

       // C. Background Tasks (Fixes "Empty Tabs" issue)
       // 1. Background Songs
       runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(() => {});

       // 2. Background Bible
       if (isClearBibleRef) {
          runBibleSearch(bibleRefInfo, signal, version, { isBackground: true }).catch(() => {});
       } else {
          // If it's not reference-shaped or just a fuzzy match, run text search
          runBibleTextSearch(rawQuery, signal, version, { isBackground: true }).catch(() => {});
       }
    } 
    
    // --- CASE: BIBLE MODE ---
    else if (currentSearchMode === "bible") {
      if (isClearBibleRef) {
        primarySearchPromise = runBibleSearch(bibleRefInfo, signal, version, { isBackground: false });
        // Background: Songs
        runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(() => {});
      } else if (isDidYouMean) {
        showDidYouMeanSuggestion(bibleRefInfo);
        primarySearchPromise = Promise.resolve(); 
        // Background: Songs
        runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(() => {});
      } else if (refShaped && bibleRefInfo === null) {
        // Ref-shaped but no match (e.g., "Asdf 1:1")
        if (verseContainer) {
          const safeQuery = escapeHtml(rawQuery);
          verseContainer.innerHTML = `
            <div class="search-query-no-verse-found-container" 
                 style="text-align:center; color:var(--muted); padding: 15px;">
              No verses found for "${safeQuery}".
            </div>`;
        }
        primarySearchPromise = Promise.resolve(); 
      } else {
        // NOT reference-shaped (e.g., "love") -> Text Search
        primarySearchPromise = runBibleTextSearch(rawQuery, signal, version, { isBackground: false });
        // Background: Songs
        runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(() => {});
      }

    } 
    
    // --- CASE: SONGS MODE ---
    else {
      primarySearchPromise = runSongsSearch(rawQuery, signal, version, { isBackground: false });
      
      // Background Bible Search
      if (isClearBibleRef) {
        runBibleSearch(bibleRefInfo, signal, version, { isBackground: true }).catch(() => {});
      } else if (isDidYouMean) {
        showDidYouMeanSuggestion(bibleRefInfo); 
      } else if (!refShaped) {
        runBibleTextSearch(rawQuery, signal, version, { isBackground: true }).catch(() => {});
      }
    }
    
    // --- 5. Wait for the Primary task to complete ---
    if (primarySearchPromise) {
        await primarySearchPromise;
    }

  } catch (err) {
    if (!signal.aborted) {
      // console.error("Error in searchForQuery:", err);
      const container = currentSearchMode === 'bible' ? verseContainer : songsContainer;
      if (container && currentSearchMode !== 'interlinear') {
        const safeQuery = escapeHtml(rawQuery);
        const safeMessage = err.message ? escapeHtml(err.message) : `No results found for "${safeQuery}".`;
        container.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">${safeMessage}</div>`;
      }
    }
  } finally {
    // Hide main loader (unless we are in interlinear, which handles its own)
    if (loader && currentSearchMode !== 'interlinear') {
        loader.style.display = "none";
    }
    if (searchQueryFullContainer && currentSearchMode !== 'interlinear') {
        searchQueryFullContainer.style.display = "flex";
    }
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
  // NEW: Abort prefetch controller
  if (typeAheadController) {
    typeAheadController.abort();
    typeAheadController = null;
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
const body = document.querySelector("body");
const moonIcon = document.getElementById("moon-icon");
const sunIcon = document.getElementById("sun-icon");

function setTheme(isLight) {
  // console.log(isLight)
  body.classList.toggle("light", isLight);
  localStorage.setItem("theme", isLight ? "light" : "dark");
  moonIcon.style.display = isLight ? "block" : "none";
  sunIcon.style.display = isLight ? "none" : "block";
}
setTheme(localStorage.getItem("theme") === "light");
toggle?.addEventListener("click", () => {
  // console.log("Change Theme!")
  setTheme(body.classList.contains("light"))
});

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
  el.style.zIndex = currentIndex;
  currentIndex += 1
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
    window.BoardAPI.connectItems(selectedItem, item);
    throttledUpdateAllConnections(); // OPTIMIZATION: Use throttled version
    clearSelection();
  }
});

document.addEventListener("click", (e) => {
  const insideWorkspace = e.target.closest("#workspace");
  const insideAction = e.target.closest("#action-buttons-container");
  const insideSearch = e.target.closest("#search-container"); // Don't deselect when clicking search

  // Allow deselecting in read-only, just don't do work if nothing is selected
  if (window.__readOnly && !selectedItem) return;

  if (!insideWorkspace && !insideAction && !insideSearch) {
    // 🔵 IMPORTANT: do NOT auto-close the search panel here anymore.
    // It should only close via Esc key or the Esc button.

    if (
      !window.__readOnly &&
      !e.target.closest(".share-popover") &&
      !e.target.closest("#share-btn")
    ) {
      clearSelection();
    }
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
const disconnectModeBtn = document.getElementById("disconnect-mode-btn");
if (disconnectModeBtn) {
  disconnectModeBtn.addEventListener("click", () => {
    if (!window.BoardAPI || typeof window.BoardAPI.toggleDisconnectMode !== "function") return;

    window.BoardAPI.toggleDisconnectMode();
    const on =
      typeof window.BoardAPI.isDisconnectMode === "function" &&
      window.BoardAPI.isDisconnectMode();
    disconnectModeBtn.classList.toggle("active", !!on);
  });
}


connectBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedItem) return;
  setConnectMode(!isConnectMode);
});

textBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  window.BoardAPI.addTextNote("New note");
});

deleteBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!selectedItem) return;

  // Call the new BoardAPI function
  window.BoardAPI.deleteItem(selectedItem);

  // clearSelection is still handled here as it's UI state, not
  // part of the core deletion action.
  clearSelection();
  // NOTE: onBoardMutated is now called inside deleteBoardItem
});

// ==================== Interlinear integration ====================
// ... (Interlinear logic unchanged) ...
function openInterlinearPanel() {
  const interPanel = document.getElementById("interlinear-panel");
  const interList = document.getElementById("interlinear-list");
  const interLoader = document.getElementById("interlinear-loader");
  const interError = document.getElementById("interlinear-error");
  mountInterlinearInline();
  if (interPanel) {
    interPanel.style.display = "block";
    interPanel.setAttribute("aria-busy", "true");
  }
  if (interLoader) interLoader.style.display = "flex";
  if (interError) { interError.style.display = "none"; interError.textContent = "Couldn’t load interlinear data."; }
  if (interList) interList.innerHTML = "";
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
  const base = `https://full-bible-api.onrender.com/interlinear/${encodeURIComponent(
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
  // console.error("❌ Interlinear fetch failed (all attempts):", lastError);
  throw lastError || new Error("Interlinear fetch failed after all attempts.");
}

/**
 * 2. The fixed render function
 * Replaces the broken one at the bottom of your file.
 */
function renderInterlinearTokens(tokens, referenceTitle) {
  const list = document.getElementById("interlinear-list");
  if (!list) return;
  
  list.innerHTML = ""; // Clear loading state

  if (!tokens || tokens.length === 0) {
    list.innerHTML = `<div style="padding:15px; color:var(--muted); text-align:center;">No interlinear data available.</div>`;
    return;
  }

  tokens.forEach((token, index) => {
    // Create the Row
    const row = document.createElement("div");
    row.className = "interlinear-row"; 

    // Extract Data with safe fallbacks
    const surface = token.text || token.surface || token.original || token.word || "?";
    const english = token.gloss || token.english || token.translated || token.definition || token.meaning || token.trans || token.translation || "?";
    const translit = token.translit || token.transliteration || "";
    const morph = token.morph || token.grammar || "";
    const strong = token.strong || token.strongs || "";
    
    // Build Content
    const surfaceEl = document.createElement("div");
    surfaceEl.className = "interlinear-surface";
    surfaceEl.textContent = surface;

    const englishEl = document.createElement("div");
    englishEl.className = "interlinear-english";
    englishEl.textContent = english;

    const metaEl = document.createElement("div");
    metaEl.className = "interlinear-meta";
    if (translit) metaEl.innerHTML += `<span class="meta-chip">${translit}</span>`;
    if (morph) metaEl.innerHTML += `<span class="meta-chip">${morph}</span>`;
    if (strong) metaEl.innerHTML += `<span class="meta-chip">${strong}</span>`;

    // --- THE ADD BUTTON ---
    const addBtn = document.createElement("div");
    addBtn.className = "search-query-verse-add-button";
    
    // Data payload
    const cardData = {
      type: "interlinear",
      surface: surface,
      english: english,
      translit: translit,
      morph: morph,
      strong: strong,
      reference: `${referenceTitle}:${index + 1}`
    };

    // Check if already selected (Persistence)
    const key = `${cardData.reference}::${surface}`;
    if (window.pendingInterlinearAdds && window.pendingInterlinearAdds.has(key)) {
       row.classList.add("selected-for-add");
       addBtn.classList.add("selected");
    }

    // Click Handler -> CALLS THE NEW FUNCTION
    addBtn.onclick = (e) => {
      e.stopPropagation();
      toggleInterlinearSelection(addBtn, row, cardData);
    };

    // Assemble
    row.appendChild(surfaceEl);
    row.appendChild(englishEl);
    row.appendChild(metaEl);
    row.appendChild(addBtn);

    list.appendChild(row);
  });
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
  // console.log(cleanedRef);

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
      // console.log("Ignoring stale interlinear response");
      return;
    }

    renderInterlinearTokens(data);
  } catch (err) {
    // Check if this is still the latest request AND not an intentional abort
    if (currentSeq !== interlinearSeq || controller.signal.aborted) {
      // console.log("Ignoring stale interlinear error/abort", err.message);
      return;
    }

    // Genuine error for the current request
    interLoader.style.display = "none";
    interError.textContent = "Couldn’t load interlinear data."; // Generic error
    interError.style.display = "block";
    // console.error("Interlinear fetch failed:", err);
  } finally {
    // Only the LATEST request can clear the busy state
    if (currentSeq === interlinearSeq) {
      interPanel.setAttribute("aria-busy", "false");
      interlinearInFlight = null;
    }
  }
});

// ==================== Song search (iTunes public API, CORS-friendly) ====================
/**
 * OPTIMIZATION: Added AbortSignal for cancellation.
 * MODIFIED: Now uses songsCache.
 */
async function fetchSongs(query, limit = 5, signal = null) {
  if (!query) return [];

  // --- NEW: Check cache first ---
  const cacheKey = `${query.toLowerCase()}::${limit}`;
  const cached = songsCache.get(cacheKey); // .get() updates recency
  if (cached) {
    console.log(`[Cache] HIT: ${cacheKey}`);
    return cached;
  }
  console.log(`[Cache] MISS: ${cacheKey}`);
  // --- END NEW ---

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

    // --- NEW: Store in cache on success ---
    songsCache.set(cacheKey, data.results);
    // --- END NEW ---

    // Return the raw results, mapping is now handled by buildSongCard
    return data.results;
  } catch (e) {
    if (signal?.aborted) {
      // console.log("Song search aborted");
      throw e;
    }
    console.warn("Song search error:", e);
    return [];
  }
}

// ==================== Add song to whiteboard ====================
// ... (addSongElement unchanged, but with read-only guard) ...
function addSongElement({ title, artist, cover }, delay = 0) {
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

  // Base position (centered, similar to verses)
  const baseX = visibleX + (visibleW - 320) / 2;
  const baseY = visibleY + (visibleH - 90) / 2;

  // Apply staggered offset and animation if delay is provided
  if (delay !== 0) {
    el.style.opacity = "0";
    el.style.animation = "loadItemToBoard 1s forwards " + delay + "s";
    el.style.left = `${baseX + delay * 200}px`;
    el.style.top  = `${baseY + delay * 200}px`;
  } else {
    el.style.left = `${baseX}px`;
    el.style.top  = `${baseY}px`;
  }

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
  };

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

(function initVerseClickDelegation() {
  const verseContainer = document.getElementById("search-query-verse-container");
  
  verseContainer?.addEventListener("click", (e) => {
    // Check if the click was on an add button
    if (e.target.classList.contains("search-query-verse-add-button")) {
      const card = e.target.closest(".verse, .search-query-verse-container");
      if (card) {
        toggleVerseSelection(card);
      }
    }
  });
})();

// ==================== NEW: Init Search Mode Toggle ====================
(function initSearchModeToggle() {
  const bibleBtn = document.getElementById("search-mode-bible");
  const songsBtn = document.getElementById("search-mode-songs");

  bibleBtn?.addEventListener("click", () => {
    setSearchMode("bible");
    // Optionally: re-run search for the same query in the new mode
    // searchForQuery(null); 
  });

  songsBtn?.addEventListener("click", () => {
    setSearchMode("songs");
    // Optionally: re-run search for the same query in the new mode
    // searchForQuery(null);
  });

  // Set initial state on load
  setSearchMode(currentSearchMode);
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
        text: `Check out this Bible Board: ${
          document.getElementById("title-textbox")?.value || ""
        }`,
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
  const title = (
    document.getElementById("title-textbox")?.value || "BibleBoard"
  )
    .trim()
    .replace(/\s+/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${title}_${suffix}_${ts}.${ext}`;
}

/**
 * Triggers a browser download for a data URL.
 * @param {string} dataUrl - The base64-encoded data URL.
 * @param {string} filename - The desired filename.
 */
function downloadDataURL(dataUrl, filename) {
  const a = document.createElement("a");
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
  const items = Array.from(document.querySelectorAll(".board-item"));
  if (!items.length) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const el of items) {
    // read absolute position from inline styles (authoring model)
    const left = parseFloat(el.style.left || "0");
    const top = parseFloat(el.style.top || "0");
    const w = el.offsetWidth || 0;
    const h = el.offsetHeight || 0;

    // Extend bounds to include the FULL element rect
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + w);
    maxY = Math.max(maxY, top + h);
  }

  const pad = 64; // breathing room
  // Clamp min to 0 so we don't request negative origin (keeps math simple)
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  // Ceil to ensure we don't chop the bottom/right by a fraction
  const width = Math.ceil(maxX + pad - x);
  const height = Math.ceil(maxY + pad - y);

  return { x, y, width, height };
}

/**
 * Sets crossOrigin="anonymous" on all images within a node
 * to prevent canvas tainting during export.
 * @param {HTMLElement} rootNode
 */
function sanitizeImagesForCanvas(root) {
  const imgs = root.querySelectorAll("img");
  imgs.forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (src.startsWith("data:")) return;
    if (!img.crossOrigin) img.crossOrigin = "anonymous";
  });
}

// Temporarily make .board-item backgrounds solid for export
function setTemporarySolidBackgrounds(root = document) {
  const items = root.querySelectorAll(".board-item");
  // Use the app's base bg/alt color—not the translucent token
  const solid =
    getComputedStyle(document.body).getPropertyValue("--bg-dots")?.trim() ||
    getComputedStyle(document.body).getPropertyValue("--bg")?.trim() ||
    "#ffffff";

  items.forEach((el) => {
    // stash original inline values (not computed) so we can restore exactly
    el.dataset._prevBg = el.style.background || "";
    el.dataset._prevBackdrop = el.style.backdropFilter || "";

    el.style.background = solid; // solid fill (no alpha)
    el.style.backdropFilter = "none"; // disable blur—html-to-image can render weirdly with it
  });
}

function restoreBackgrounds(root = document) {
  const items = root.querySelectorAll(".board-item");
  items.forEach((el) => {
    el.style.background = el.dataset._prevBg || "";
    el.style.backdropFilter = el.dataset._prevBackdrop || "";
    delete el.dataset._prevBg;
    delete el.dataset._prevBackdrop;
  });
}

/**
 * Main export function. Renders the used area of the board to a PNG.
 */
async function exportBoardPNGUsedArea({ scale = 1 } = {}) {
  const { viewport } = window.BoardAPI;
  const boardRoot = document.getElementById("workspace"); // wrapper that contains items + connections
  if (!boardRoot) {
    alert("Workspace not found");
    return;
  }

  // Ensure connections are up to date, and layout is stable
  if (typeof updateAllConnections === "function") updateAllConnections();
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r))
  );

  // Compute tight bounds of used area (see section B)
  const box = computeUsedBounds();
  if (!box || box.width <= 0 || box.height <= 0) {
    alert("Nothing to export yet.");
    return;
  }

  // Sanitize images and set temporary solid backgrounds
  sanitizeImagesForCanvas(boardRoot);
  setTemporarySolidBackgrounds(boardRoot);

  // Shift the board so the box’s top-left renders at (0,0)
  const prevTransform = boardRoot.style.transform || "";
  const prevTransformOrigin = boardRoot.style.transformOrigin || "";
  boardRoot.style.transformOrigin = "top left";
  boardRoot.style.transform = `translate(${-box.x}px, ${-box.y}px) scale(1)`;

  // Compute pixel size
  const outW = Math.ceil(box.width * scale);
  const outH = Math.ceil(box.height * scale);

  // Set a background color on the canvas so no part is transparent
  const bg =
    getComputedStyle(document.body).getPropertyValue("--bg")?.trim() ||
    "#ffffff";

  // --- NEW: Add exporting class to hide handles ---
  document.body.classList.add("is-exporting");

  try {
    const dataUrl = await window.htmlToImage.toPng(boardRoot, {
      width: outW,
      height: outH,
      // Fill the canvas background to avoid any transparent strips
      backgroundColor: bg,
      // Prevent clipping issues
      style: { overflow: "visible", position: "relative" },
      cacheBust: true,
    });
    downloadDataURL(dataUrl, makeExportFilename("used", "png"));
  } catch (e) {
    // console.error("Export failed:", e);
    alert("Export failed. Try a smaller scale.");
  } finally {
    // Restore styles
    boardRoot.style.transform = prevTransform;
    boardRoot.style.transformOrigin = prevTransformOrigin;
    restoreBackgrounds(boardRoot);
    // --- NEW: Always remove exporting class ---
    document.body.classList.remove("is-exporting");
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
  document.body.classList.toggle("read-only", isReadOnly);
  window.__readOnly = isReadOnly; // Set global flag
  const actionButtons = document.getElementById("action-buttons-container");
  const titleInput = document.getElementById("title-textbox");
  const editIcon = document.getElementById("edit-Icon");
  const searchForm = document.getElementById("search-container"); // ADDED
  const tourBtn = document.getElementById("bb-tour-help-btn"); // ADDED
  const exportBtn = document.getElementById("export-btn"); // ADDED FOR EXPORT

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
    if (searchForm) searchForm.style.display = "none";
    if (tourBtn) tourBtn.style.display = "none";

    // 6. Show Export button (viewers can export)
    // if (exportBtn) exportBtn.style.display = "inline-block"; // Make sure it's visible
    if (exportBtn) exportBtn.style.display = "none"; // Make sure it's visible
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
    if (searchForm) searchForm.style.display = ""; // Use '' to reset to CSS default
    if (tourBtn) tourBtn.style.display = "inline-block"; // Match supabase-sync.js logic

    // 6. Show Export button
    // if (exportBtn) exportBtn.style.display = "inline-block";
    if (exportBtn) exportBtn.style.display = "none"; // Make sure it's visible

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
      color:
        c.color ||
        (c.path && (c.path.dataset.color || c.path.style.stroke)) ||
        undefined,
    }));

    const title = document.getElementById("title-textbox")?.value || "";

    const viewportData = {
      scale,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };

    return { title, viewport: viewportData, items, connections: conns };
  } catch (err) {
    // console.error("❌ Serialization Failed:", err);
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
          // console.error("Failed to restore item:", item, itemErr);
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
            : data.viewport.scrollLeft || 0;
        const targetTop =
          data.viewport.centerY != null
            ? data.viewport.centerY * sc - viewport.clientHeight / 2
            : data.viewport.scrollTop || 0;

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
    // console.error("❌ Error during board restore:", err);
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
      target: () => document.getElementById("viewport"),
      title: "Your Workspace",
      text: "This is your canvas. Drag with your mouse or finger to pan, and use the scroll wheel or pinch to zoom.",
      placement: "right",
      allowPointerThrough: true,
    },
    {
      id: "search",
      target: () => document.getElementById("search-bar"),
      title: "Search anything",
      text:
        "Use this search bar to find verses, topics, and songs. It's your quick entry into the board.",
      placement: "top",
      allowPointerThrough: true,
      beforeStep: () => {
        const el = document.getElementById("search-bar");
        if (el) el.focus();
      },
    },
    {
      id: "choose-version",
      target: () => document.getElementById("version-select"),
      title: "Choose your version",
      text: "Use this menu beside the search bar to choose your Bible version. Searches and added verses use this selection.",
      placement: "top",
      allowPointerThrough: true,
      beforeStep: () => {
        const select = document.getElementById("version-select");
        if (select) {
          // small UX touch so it's obvious this is interactive
          select.focus();
        }
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
          tempVerse.style.left = `${
            (viewport.scrollLeft + vpRect.width / 2 - 150) / scale
          }px`;
          tempVerse.style.top = `${
            (viewport.scrollTop + vpRect.height / 2 - 100) / scale
          }px`;
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
      id: "undo",
      target: () => document.getElementById("undo-btn"),
      title: "Undo Your Last Action",
      text: "Made a mistake? Tap this button to undo your last action, like adding an item or making a connection. You can also use the shortcut Ctrl+Z.",
      placement: "right",
      allowPointerThrough: true,
    },
    {
      id: "redo",
      target: () => document.getElementById("redo-btn"),
      title: "Redo an Action",
      text: "If you undo too far, tap this button to bring your action back. The shortcut for this is Ctrl+Shift+Z.",
      placement: "right",
      allowPointerThrough: true,
    },
    {
      id: "connect",
      target: () => document.getElementById("mobile-action-button"),
      title: "Connect Ideas",
      text: "Select a card, then tap this 'Connect' button. Tap another card to draw a line between them.",
      placement: "right",
      padding: 8, // <-- ADDED THIS LINE for extra padding
      allowPointerThrough: true, // <-- ADD THIS LINE
    },
    {
      id: "disconnect",
      target: () => document.getElementById("disconnect-mode-btn"),
      title: "Disconnect Ideas",
      text: "Made a mistake? Connecting some ideas just click this and enter 'Disconnect Mode' allowing you to disconnect any connections.",
      placement: "right",
      allowPointerThrough: true,
    },
    {
      id: "notes",
      target: () => document.getElementById("text-action-button"),
      title: "Add Notes",
      text: "Tap this 'note' button to add a blank note card to your board. You can type anything you want!",
      placement: "right",
      allowPointerThrough: true, // <-- ADD THIS LINE
    },
    // {
    //   id: "interlinear",
    //   target: () => document.getElementById("interlinear-action-button"),
    //   title: "Go Deeper",
    //   text: "Select a verse card, then tap the 'Interlinear' button to open a word-by-word breakdown of the original language.",
    //   placement: "right",
    //   allowPointerThrough: true, // <-- ADD THIS LINE
    // },

    {
      id: "delete",
      target: () => document.getElementById("delete-action-button"),
      title: "Delete Item",
      text: "Select a item on the bible board, then tap the 'Delete' button to delete the selected item.",
      placement: "right",
      allowPointerThrough: true, // <-- ADD THIS LINE
    },
    {
      id: "colors",
      target: () => document.getElementById("connection-color-toolbar"),
      title: "Colors for your connections",
      text: "If you want to add some color to your board select a color and when connecting ideas the 'Connection Lines' will be the selected color.",
      placement: "left",
      allowPointerThrough: true,
    },
    {
      id: "finish",
      title: "You're All Set!",
      text: "You're ready to build your board. Try searching for a verse now to get started.",
      // allowPointerThrough: true, // <-- ADD THIS LINE
    },
  ];

  return steps;
}

function setupBoardSettingsPanel() {
  const runSetup = () => {
    // 1. --- Guards ---
    if (document.getElementById("board-settings-toggle")) return; // Already setup
    const body = document.getElementById("main-content-container");
    if (!body) return;

    // 2. --- Create Toggle Button ---
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "board-settings-toggle";
    toggleBtn.className = "toggle-btn"; // Use existing class from index.html
    toggleBtn.setAttribute("aria-label", "Board Settings");
    toggleBtn.setAttribute("aria-haspopup", "true");
    toggleBtn.setAttribute("aria-expanded", "false");
    // Simple Gear SVG Icon
    toggleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="width: 18px; height: 18px; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.08-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>`;

    // Style toggle button (fixed position, replaces old theme toggle)
    toggleBtn.style.position = "absolute";
    toggleBtn.style.top = "15px";
    toggleBtn.style.right = "15px";
    toggleBtn.style.zIndex = "10003";

    // 3. --- Create Panel ---
    const panel = document.createElement("div");
    panel.id = "board-settings-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "board-settings-title");

    // Style panel
    panel.style.position = "absolute";
    panel.style.right = "70px"; // Below 50px button + 25px top + 10px gap
    panel.style.top = "15px";
    panel.style.minWidth = "240px";
    panel.style.background = "var(--bg-seethroug)";
    panel.style.border = "1px solid var(--fg-seethrough)";
    panel.style.backdropFilter = "blur(1rem)";
    panel.style.borderRadius = "12px";
    panel.style.padding = "12px";
    panel.style.zIndex = "10004";
    panel.style.display = "none"; // Start hidden

    // 4. --- Create Panel Internals ---
    panel.innerHTML = `<div id="board-settings-title" style="font-size: 1rem; font-weight: 700; color: var(--fg); padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 12px;">Settings</div>
                       <div id="board-settings-content" style="display: flex; flex-direction: column; gap: 8px;"></div>`;
    const content = panel.querySelector("#board-settings-content");

    // Helper to create muted labels
    const createLabel = (text) => {
      const label = document.createElement("div");
      label.textContent = text;
      label.style.fontSize = "0.75rem";
      label.style.fontWeight = "700";
      label.style.color = "var(--muted)";
      label.style.textTransform = "uppercase";
      label.style.padding = "8px 0 4px 4px";
      label.style.marginTop = "4px";
      return label;
    };

    // Helper to reset moved button styles for stacking
    const resetPosition = (el) => {
      if (!el) return;
      el.style.position = "relative";
      el.style.top = "auto";
      el.style.left = "auto";
      el.style.right = "auto";
      el.style.width = "100%";
      el.style.boxSizing = "border-box"; // Ensure padding doesn't break 100% width
    };

    // 5. --- Find and Move Elements ---
    const themeToggle = document.getElementById("theme-toggle");
    const exportBtn = document.getElementById("export-btn");
    const shareBtn = document.getElementById("share-btn");
    const tourBtn = document.getElementById("bb-tour-help-btn");

    // Appearance Section
    if (themeToggle) {
      content.appendChild(createLabel("Appearance"));
      resetPosition(themeToggle);

      // Add a text label *inside* the button (modifies button, but required for context)
      const themeLabel = document.createElement("span");
      themeLabel.textContent = "Theme";
      themeLabel.style.fontWeight = "700";
      themeLabel.style.fontSize = "15px";
      themeToggle.style.justifyContent = "space-between";
      themeToggle.style.padding = "5px 15px";
      themeToggle.style.height = "40px";
      themeToggle.prepend(themeLabel); // Add label

      content.appendChild(themeToggle);
    }

    // Board Actions Section
    if (exportBtn || shareBtn) {
      content.appendChild(createLabel("Board Actions"));
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
      content.appendChild(createLabel("Help"));
      resetPosition(tourBtn);
      content.appendChild(tourBtn);
    }

    // 6. --- Append New UI to Body ---
    body.appendChild(toggleBtn);
    body.appendChild(panel);

    // 7. --- Open/Close/Focus Logic ---
    const openPanel = () => {
      panel.style.display = "block";
      toggleBtn.setAttribute("aria-expanded", "true");
      localStorage.setItem("bb_settings_open", "true");

      // Focus first focusable element in panel
      const firstFocusable = panel.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (firstFocusable) firstFocusable.focus();
    };

    const closePanel = () => {
      panel.style.display = "none";
      toggleBtn.setAttribute("aria-expanded", "false");
      localStorage.setItem("bb_settings_open", "false");
      toggleBtn.focus(); // Return focus to the toggle
    };

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = panel.style.display === "none";
      if (isHidden) openPanel();
      else closePanel();
    });

    // Close on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.style.display !== "none") {
        closePanel();
      }
    });

    // Close on click outside
    document.addEventListener("click", (e) => {
      if (
        panel.style.display !== "none" &&
        !panel.contains(e.target) &&
        e.target !== toggleBtn &&
        !toggleBtn.contains(e.target)
      ) {
        closePanel();
      }
    });

    // 8. --- Restore State from localStorage ---
    if (localStorage.getItem("bb_settings_open") === "true") {
      openPanel();
    }
  };

  // --- Invocation ---
  if (document.readyState !== "loading") {
    runSetup();
  } else {
    document.addEventListener("DOMContentLoaded", runSetup);
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

  // NEW: Add the deleteItem function
  deleteItem: deleteBoardItem,
  getConnections: () => connections,
  connectItems,
  disconnectLine,
  removeConnectionsFor,
  updateAllConnections,
  getElementByVKey: (key) => document.querySelector(`[data-vkey="${key}"]`),

  // 🆕 disconnection mode
  setDisconnectMode,
  toggleDisconnectMode,
  isDisconnectMode,

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
}

/**
 * Parse "Book C:V" into {book, chapter, verse} or null
 */
function parseReferenceString(refStr) {
  if (!refStr) return null;
  let s = String(refStr)
    .replace(/\(.*?\)/g, '')
    .replace(/[“”"']/g, '')
    .trim();
  const m = s.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return { book: m[1].trim(), chapter: parseInt(m[2], 10), verse: parseInt(m[3], 10) };
}



/**
 * Open Interlinear for current search query (if verse). Otherwise show "No interlinear for ..."
 */
function openInterlinearFromCurrentQuery() {
  const inputVal = (document.getElementById("search-bar")?.value || "").trim();
  const q = inputVal || (window.__lastRawQuery || "").trim() || "";

  const interList = document.getElementById("interlinear-list");
  const interLoader = document.getElementById("interlinear-loader");
  const interError = document.getElementById("interlinear-error");
  const interPanel = document.getElementById("interlinear-panel");

  // Show loader state
  if (interPanel) interPanel.setAttribute("aria-busy", "true");
  if (interLoader) interLoader.style.display = "flex";
  if (interError) interError.style.display = "none";
  if (interList) interList.innerHTML = "";

  const ref = parseReferenceString(q);
  if (ref && typeof openInterlinearForReference === "function") {
    // Ensure drawer is open
    if (!window.searchDrawerOpen) { window.searchDrawerOpen = true; try { applyLayout && applyLayout(true); } catch {} }
    // Switch to Interlinear mode
    try { setSearchMode && setSearchMode("interlinear", { openDrawer: true }); } catch {}
    // Fetch and render
    openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
  } else {
    // Not a verse-shaped query: show message
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
    if (interError) interError.style.display = "none";
    if (interList) interList.innerHTML = q
      ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`
      : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
  }
}


function populateInterlinearFromCurrentQuery() {
  const bar = document.getElementById("search-bar");
  const q = (bar && bar.value ? bar.value.trim() : "") || (window.__lastRawQuery || "").trim();

  const interList = document.getElementById("interlinear-list");
  const interLoader = document.getElementById("interlinear-loader");
  const interError = document.getElementById("interlinear-error");
  const interPanel = document.getElementById("interlinear-panel");

  if (interPanel) interPanel.setAttribute("aria-busy", "true");
  if (interLoader) interLoader.style.display = "flex";
  if (interError) interError.style.display = "none";
  if (interList) interList.innerHTML = "";

  // Prefer project parser if available
  let ref = null;
  try { if (typeof parseReferenceString === "function") ref = parseReferenceString(q); } catch {}
  if (!ref && q) {
    const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
    if (m) ref = { book: m[1].trim(), chapter: parseInt(m[2],10), verse: parseInt(m[3],10) };
  }

  if (ref && typeof openInterlinearForReference === "function") {
    openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
  } else {
    // Not a verse-shaped query → show message "No interlinear for 'q'"
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
    if (interError) interError.style.display = "none";
    if (interList) interList.innerHTML = q
      ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`
      : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
  }
}





// --- BEGIN: Interlinear-from-query hardening (drop-in) ---

// Keep track of the user's latest raw query locally (fallback if the header helper wasn't loaded)
window.__lastRawQuery = window.__lastRawQuery || "";

// Robust "Book C:V" parser (uses the one already in your file)
function __parseRefStrict(s) {
  if (typeof parseReferenceString === "function") return parseReferenceString(s);
  const t = String(s || "")
    .replace(/\(.*?\)/g, "")
    .replace(/[“”"']/g, "")
    .trim();
  const m = t.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return { book: m[1].trim(), chapter: parseInt(m[2], 10), verse: parseInt(m[3], 10) };
}

/**
 * Open interlinear **for the current query**.
 * - If the query is verse-shaped => fetch interlinear.
 * - Otherwise => show "No interlinear for '_____'."
 */
async function openInterlinearFromCurrentQuery() {
  const searchEl = document.getElementById("search-bar");
  const q = (searchEl?.value || window.__lastRawQuery || "").trim();

  // console.log(q)
  const interPanel = document.getElementById("interlinear-panel");
  const interList  = document.getElementById("interlinear-list");
  const interErr   = document.getElementById("interlinear-error");
  const interLoad  = document.getElementById("interlinear-loader");

  // Make sure the panel is inline (not hidden behind the drawer)
  try { mountInterlinearInline && mountInterlinearInline(); } catch {}

  // Ensure drawer open + switch to Interlinear
  if (!window.searchDrawerOpen) { window.searchDrawerOpen = true; try { applyLayout?.(true); } catch {} }
  try { setSearchMode?.("interlinear", { openDrawer: true }); } catch {}

  // Reset UI
  if (interPanel) interPanel.setAttribute("aria-busy", "true");
  if (interLoad)  interLoad.style.display = "flex";
  if (interErr)   interErr.style.display  = "none";
  if (interList)  interList.innerHTML     = "";

  // Parse "Book C:V" (use project parser if available)
  const ref = (typeof parseReferenceString === "function")
    ? parseReferenceString(q)
    : (() => {
        const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
        return m ? { book: m[1].trim(), chapter: parseInt(m[2],10), verse: parseInt(m[3],10) } : null;
      })();

  if (!ref) {
    // Not a verse-shaped query → show friendly message
    if (interList) {
      interList.innerHTML = q
        ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`
        : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
    }
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoad)  interLoad.style.display = "none";
    return;
  }

  // Call your existing interlinear opener; ALWAYS stop the loader afterward
  try {
    if (typeof openInterlinearForReference === "function") {
      await openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
    } else {
      throw new Error("openInterlinearForReference not found");
    }
  } catch (err) {
    console.warn("Interlinear fetch failed:", err);
    if (interErr) {
      interErr.textContent = "Couldn’t load interlinear data.";
      interErr.style.display = "block";
    }
  } finally {
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoad)  interLoad.style.display = "none";
  }
}


// Capture the last query when the user presses Enter in the search bar,
// so the Interlinear pill can immediately use it without retyping.
(function bindEnterToRememberQuery() {
  const searchEl = document.getElementById("search-bar");
  if (!searchEl) return;
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      window.__lastRawQuery = (searchEl.value || "").trim();
    }
  });
})();

// Also expose a safe global (optional utility)
window.openInterlinearFromCurrentQuery = openInterlinearFromCurrentQuery;

// =============================================================================
// 1. The Fetching Logic (Your provided code, kept intact)
// =============================================================================
// Global variable to track what is currently on screen
let _lastLoadedInterlinearRef = null;

async function openInterlinearForReference(refString) {
  // Ensure panel visible/inline
  try { mountInterlinearInline && mountInterlinearInline(); } catch {}
  
  const interPanel = document.getElementById("interlinear-panel");
  const interList  = document.getElementById("interlinear-list");
  const interLoader= document.getElementById("interlinear-loader");
  const interError = document.getElementById("interlinear-error");

  // 1. Parse the requested reference
  const ref = parseReferenceString(refString);
  
  if (!ref) {
    // Handle invalid reference logic
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
    if (interList) interList.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${refString}". Please search for a verse(John 3:16, e.g)</div>`;
    return;
  }

  // 2. CACHE CHECK: Construct a unique ID for this request
  const requestKey = `${ref.book.toUpperCase()}_${ref.chapter}:${ref.verse}`;
  const hasContent = interList && interList.children.length > 0;

  // If we are already showing this exact chapter/verse, STOP here.
  if (_lastLoadedInterlinearRef === requestKey && hasContent) {
    // Just ensure UI is in "Ready" state (hide loader, show content)
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
    if (interError)  interError.style.display = "none";
    if (interList)   interList.style.display = "block";
    return; // <--- EXIT EARLY
  }

  // 3. New request proceeding... update cache key
  _lastLoadedInterlinearRef = requestKey;

  // Show Loading UI
  if (interPanel) interPanel.setAttribute("aria-busy", "true");
  if (interLoader) interLoader.style.display = "flex";
  if (interError)  interError.style.display  = "none";
  if (interList)   interList.innerHTML       = "";

  // Map to code if bibleBookCodes exists
  let bookCode = ref.book;
  try {
    if (typeof bibleBookCodes === "object" && bibleBookCodes[ref.book]) {
      bookCode = bibleBookCodes[ref.book];
    }
  } catch (_) {}

  // Build API URL
  const apiUrl = `https://full-bible-api.onrender.com/interlinear/${encodeURIComponent(bookCode)}/${ref.chapter}/${ref.verse}`;

  // Abort previous in-flight request
  if (window.__interlinearAbortController) {
    try { window.__interlinearAbortController.abort(); } catch (_) {}
  }
  const controller = new AbortController();
  window.__interlinearAbortController = controller;

  try {
    // Fetch
    let resp;
    if (typeof safeFetchWithFallbacks === "function") {
      resp = await safeFetchWithFallbacks(apiUrl, controller.signal);
    } else {
      resp = await fetch(apiUrl, { signal: controller.signal, mode: "cors", credentials: "omit" });
    }
    
    const data = await resp.json();
    const tokens = Array.isArray(data?.tokens) ? data.tokens : (Array.isArray(data) ? data : []);
    
    // Render
    renderInterlinearTokens(tokens, `${ref.book} ${ref.chapter}:${ref.verse}`);
    
  } catch (err) {
    if (controller.signal.aborted) return;
    
    // Reset cache on error so user can try again
    _lastLoadedInterlinearRef = null; 

    console.warn("Interlinear fetch failed:", err);
    if (interError) {
      interError.textContent = "Couldn’t load interlinear data.";
      interError.style.display = "block";
    }
  } finally {
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
  }
}

// This should already be in your script.js, but ensure 
// it handles the visual toggling for the parent row correctly.
function toggleItemInQueue(btn, rowElement, data) {
  const queue = window.itemsToAddQueue;
  const floatBtn = document.getElementById("floating-add-to-board-btn");

  // Check if item is already in queue (simple object reference check might fail if recreating objs, 
  // but for this UI lifecycle it's usually fine. If strict dedupe needed, use a unique ID).
  
  // Basic toggle logic
  if (btn.classList.contains("selected")) {
    // REMOVE
    btn.classList.remove("selected");
    rowElement.classList.remove("selected-for-add");
    
    // Find and delete from Set (since object references might differ, we might need to find by ID/content)
    // Simple approach: Iterate set and match specific props
    for (const i of queue) {
      if (i.type === data.type && 
         (i.reference === data.reference && i.surface === data.surface)) { // Unique check for Interlinear
         queue.delete(i);
         break;
      }
      // Add checks for verse/song uniqueness if needed
      if (i.type === 'verse' && i.reference === data.reference) {
         queue.delete(i);
         break;
      }
    }
  } else {
    // ADD
    btn.classList.add("selected");
    rowElement.classList.add("selected-for-add");
    queue.add(data);
  }

  // Update Floating Button
  if (queue.size > 0) {
    floatBtn.style.display = "flex";
    floatBtn.innerHTML = `<svg class="add-to-board-icon-open" ...>...</svg> Add ${queue.size} to Board`;
    // Add click listener only once or rely on global listener
    floatBtn.onclick = flushItemsQueueToBoard; 
  } else {
    floatBtn.style.display = "none";
  }
}

/**
 * UPDATED: Handles 'interlinear' type in the flush queue.
 */
async function flushItemsQueueToBoard() {
  const floatBtn = document.getElementById("floating-add-to-board-btn");
  if (window.itemsToAddQueue.size === 0) return;

  // 1. Hide the search/drawer UI
  const searchContainer = document.getElementById("search-query-container");
  const searchInput = document.getElementById("search-bar");
  
  // Fade out search
  if (searchContainer) {
    searchContainer.style.opacity = "0";
    setTimeout(() => {
      searchContainer.style.width = "0px";
      if (searchInput) searchInput.value = "";
    }, 250);
  }
  
  // Hide Interlinear Panel if open
  const interlinearPanel = document.getElementById("interlinear-panel");
  if (interlinearPanel) interlinearPanel.classList.remove("open");

  // Reset floating button
  if (floatBtn) {
    floatBtn.style.display = "none";
    floatBtn.innerHTML = ""; // Clear icon
  }

  // 2. Calculate center position for new items
  const viewport = document.querySelector(".viewport");
  const rect = viewport.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  // Offset logic
  let index = 0;
  const offsetStep = 30; 
  const totalItems = window.itemsToAddQueue.size;
  const startX = centerX - ((totalItems - 1) * offsetStep) / 2;
  const startY = centerY - ((totalItems - 1) * offsetStep) / 2;

  // 3. Iterate and Add
  for (const item of window.itemsToAddQueue) {
    let newEl = null;

    // --- CASE: VERSE ---
    if (item.type === "verse") {
      newEl = window.BoardAPI.addBibleVerse(
        item.reference,
        item.text,
        false, // not from load
        item.version
      );
    } 
    // --- CASE: SONG ---
    else if (item.type === "song") {
      newEl = window.BoardAPI.addSongElement(item);
    }
    // --- NEW CASE: INTERLINEAR ---
    else if (item.type === "interlinear") {
       // This calls the existing BoardAPI function (wrapped by undo-redo.js)
       newEl = window.BoardAPI.addInterlinearCard({
         surface: item.surface,
         english: item.english,
         translit: item.translit,
         morph: item.morph,
         strong: item.strong,
         reference: item.reference
       });
    }

    // 4. Position & Animate
    if (newEl) {
      const x = startX + index * offsetStep;
      const y = startY + index * offsetStep;

      newEl.style.left = `${x}px`;
      newEl.style.top = `${y}px`;
      
      // Add the "pop-in" animation class
      newEl.classList.add("item-pop-in");
      
      // Trigger a save/sync
      if (window.BoardAPI.triggerAutosave) {
        window.BoardAPI.triggerAutosave("items_flushed");
      }
    }
    index++;
  }

  // 5. Clean up
  window.itemsToAddQueue.clear();
  
  // Remove "selected" styling from all buttons in the DOM
  document.querySelectorAll(".search-query-verse-add-button.selected").forEach(btn => {
      btn.classList.remove("selected");
  });
  document.querySelectorAll(".selected-for-add").forEach(row => {
      row.classList.remove("selected-for-add");
  });
}


/* =================================================================
   SINGLE INTERLINEAR HANDLER (Paste at bottom of script.js)
   =================================================================
*/

// Global variable to track what is currently on screen
window.__currentInterlinearRef = null;

// Override the helper to check cache BEFORE clearing the DOM
window.openInterlinearFromCurrentQuery = async function() {
  const searchEl = document.getElementById("search-bar");
  const q = (searchEl?.value || window.__lastRawQuery || "").trim();

  // 1. Parse
  const ref = (typeof parseReferenceString === "function")
    ? parseReferenceString(q)
    : (() => {
        const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
        return m ? { book: m[1].trim(), chapter: parseInt(m[2],10), verse: parseInt(m[3],10) } : null;
    })();

  const interPanel = document.getElementById("interlinear-panel");
  const interLoader = document.getElementById("interlinear-loader");
  const interList = document.getElementById("interlinear-list");

  if (!ref) {
    if (interList) interList.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`;
    if (interLoader) interLoader.style.display = "none";
    return;
  }

  // 2. CHECK CACHE
  const requestKey = `${ref.book.toUpperCase()}_${ref.chapter}:${ref.verse}`;
  const hasContent = interList && interList.children.length > 0;
  
  // If the panel is open AND showing this exact verse, STOP.
  if (window.__currentInterlinearRef === requestKey && interPanel && interPanel.classList.contains("open") && hasContent) {
    // console.log("Interlinear already loaded for:", requestKey);
    return; 
  }

  // 3. Proceed
  window.__currentInterlinearRef = requestKey;
  
  if (interPanel) {
      interPanel.setAttribute("aria-busy", "true");
      interPanel.classList.add("open");
  }
  if (interLoader) interLoader.style.display = "flex";
  if (interList) interList.innerHTML = ""; 

  if (typeof openInterlinearForReference === "function") {
    await openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
  }
};

/* =================================================================
   FINAL FIX: INTERLINEAR REFRESH LOOP
   Paste this at the VERY BOTTOM of board/script.js
   =================================================================
*/

(function() {
  // console.log("🔧 Applying Interlinear Refresh Fix...");

  // 1. Global tracking for the current view
  window.__lastInterlinearRef = null;

  // 2. Define the "Smart" logic that checks cache
  const smartInterlinearOpener = async function() {
    const searchEl = document.getElementById("search-bar");
    // Get query from input OR the global fallback
    const q = (searchEl?.value || window.__lastRawQuery || "").trim();

    const interPanel = document.getElementById("interlinear-panel");
    const interList  = document.getElementById("interlinear-list");
    const interLoad  = document.getElementById("interlinear-loader");
    
    // 1. Parse the reference (e.g. "John 3:16")
    // Use your project's parser if available, otherwise simple regex
    let ref = null;
    if (typeof parseReferenceString === "function") {
      ref = parseReferenceString(q);
    } else {
      const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
      if (m) ref = { book: m[1].trim(), chapter: parseInt(m[2],10), verse: parseInt(m[3],10) };
    }

    // If not a verse, just clear and show message
    if (!ref) {
      if (interList) interList.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`;
      if (interLoad) interLoad.style.display = "none";
      return;
    }

    // 2. CACHE CHECK (The Fix)
    // Generate a unique key for this specific verse
    const requestKey = `${ref.book.toUpperCase()}_${ref.chapter}:${ref.verse}`;
    const hasContent = interList && interList.children.length > 0;
    const isPanelOpen = interPanel && (interPanel.classList.contains("open") || interPanel.style.display === "block");

    // If we are already looking at this verse, and the panel has content... STOP.
    if (window.__lastInterlinearRef === requestKey && isPanelOpen && hasContent) {
      // console.log("🛑 Interlinear Cache Hit: Preventing refresh for", requestKey);
      return; 
    }

    // 3. It's a new request. Update tracking and proceed.
    // console.log("🚀 Fetching Interlinear for", requestKey);
    window.__lastInterlinearRef = requestKey;

    // Ensure UI is open/loading
    if (interPanel) {
      // Use inline style if not using classes, or class if using CSS
      interPanel.style.display = "block"; 
      interPanel.classList.add("open");
      interPanel.setAttribute("aria-busy", "true");
    }
    if (interLoad) interLoad.style.display = "flex";
    if (interList) interList.innerHTML = ""; // NOW it is safe to clear

    // 4. Call the API Fetcher
    if (typeof openInterlinearForReference === "function") {
      await openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
    }
  };

  // 3. OVERWRITE global helpers so any other code calls our smart logic
  window.populateInterlinearFromCurrentQuery = smartInterlinearOpener;
  window.openInterlinearFromCurrentQuery = smartInterlinearOpener;

  // 4. NUCLEAR OPTION: Strip all existing listeners from the button
  const oldBtn = document.getElementById("search-mode-interlinear");
  if (oldBtn) {
    // Cloning the node removes all event listeners attached via .addEventListener
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);

    // Attach EXACTLY ONE listener
    newBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // 1. Update Visuals (Pills)
      if (window.setSearchMode) {
        // We assume you fixed setSearchMode to NOT fetch data automatically
        window.setSearchMode("interlinear", { openDrawer: true });
      }

      // 2. Trigger Data Load (using our smart logic)
      smartInterlinearOpener();
    });

    // console.log("✅ Interlinear Button: Listeners reset.");
  }

})();




/* =============================================================================
   FIX: INTERLINEAR CARD SETUP & DRAG LOGIC
   Paste this at the VERY BOTTOM of board/script.js
   ============================================================================= */

// 1. Define a standalone helper to attach drag/drop events
function attachInterlinearEvents(el) {
  if (!el) return;

  // A. Card Dragging (Mouse)
  el.addEventListener("mousedown", (e) => {
    // Ignore clicks on buttons/inputs or the connection handle (handled separately)
    if (e.target.tagName === "BUTTON" || 
        e.target.tagName === "INPUT" || 
        e.target.closest(".connection-handle")) {
      return;
    }
    
    // Try to call the global BoardAPI handler if it exists
    if (window.BoardAPI && typeof window.BoardAPI.onItemDown === "function") {
      window.BoardAPI.onItemDown(e, el);
    }
  });

  // B. Card Dragging (Touch)
  el.addEventListener("touchstart", (e) => {
    if (e.target.tagName === "BUTTON" || 
        e.target.tagName === "INPUT" || 
        e.target.closest(".connection-handle")) {
      return;
    }
    
    if (window.BoardAPI && typeof window.BoardAPI.onItemDown === "function") {
      window.BoardAPI.onItemDown(e, el);
    }
  }, { passive: false });

  // C. Connection Handle Logic
  const handle = el.querySelector(".connection-handle");
  if (handle) {
    handle.addEventListener("mousedown", (e) => {
      e.stopPropagation(); // Stop card drag
      if (window.BoardAPI && typeof window.BoardAPI.startConnectionDrag === "function") {
        window.BoardAPI.startConnectionDrag(e, el);
      }
    });

    handle.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      if (window.BoardAPI && typeof window.BoardAPI.startConnectionDrag === "function") {
        window.BoardAPI.startConnectionDrag(e, el);
      }
    }, { passive: false });
  }
}

/* =============================================================================
   FIXED: ADD INTERLINEAR CARD
   Replaces the broken function at the bottom of script.js.
   Uses 'startDragMouse' directly to ensure compatibility with your board.
   ============================================================================= */

function addInterlinearCard(data, delay = 0) {
  const el = document.createElement("div");
  el.className = "board-item interlinear-card";
  
  // --- Animation ---
  if (delay !== 0) {
    el.style.opacity = "0";
    el.style.animation = "loadItemToBoard 1s forwards " + delay + "s";
  }

  // --- ID & Type ---
  const id = crypto.randomUUID();
  el.dataset.vkey = id;
  el.dataset.type = "interlinear";

  // --- Data Attributes ---
  el.dataset.surface = data.surface || "";
  el.dataset.english = data.english || "";
  el.dataset.translit = data.translit || "";
  el.dataset.morph = data.morph || "";
  el.dataset.strong = data.strong || "";
  el.dataset.reference = data.reference || "";

  // --- Position (Center of Viewport) ---
  const viewport = document.querySelector(".viewport");
  if (viewport) {
    const rect = viewport.getBoundingClientRect();
    const visibleX = viewport.scrollLeft / scale;
    const visibleY = viewport.scrollTop / scale;
    const visibleW = rect.width / scale;
    const visibleH = rect.height / scale;

    // Base position centered
    const baseX = visibleX + (visibleW - 320) / 2;
    const baseY = visibleY + (visibleH - 90) / 2;

    // Apply delay offset
    el.style.left = `${baseX + delay * 200}px`;
    el.style.top = `${baseY + delay * 200}px`;
  }

  // --- HTML Content ---
  el.innerHTML = `
    <div style="width:100%">
      <div class="interlinear-card-header">
        <span class="interlinear-card-badge">Interlinear</span>
        <span class="interlinear-card-ref">${data.reference || ""}</span>
      </div>
      <div class="interlinear-card-surface">${data.surface || "?"}</div>
      <div class="interlinear-card-english">${data.english || "?"}</div>
      <div class="interlinear-card-meta">
        ${data.translit ? `<span class="interlinear-chip">${data.translit}</span>` : ""}
        ${data.morph ? `<span class="interlinear-chip">${data.morph}</span>` : ""}
        ${data.strong ? `<span class="interlinear-chip">${data.strong}</span>` : ""}
      </div>
    </div>
    <div class="connection-handle">
      <svg viewBox="0 0 100 100" width="30" height="30">
        <circle class="handle-circle" cx="50" cy="50" r="45"></circle>
        <line class="handle-cross" x1="50" y1="30" x2="50" y2="70"></line>
        <line class="handle-cross" x1="30" y1="50" x2="70" y2="50"></line>
      </svg>
    </div>
  `;

  // --- EVENT ATTACHMENT (The Fix) ---
  // Matches how addBibleVerse and addSongElement work in your file
  el.onmousedown = (e) => {
    // Ignore clicks on buttons/inputs or the handle
    if (e.target.closest("button") || 
        e.target.closest("input") || 
        e.target.closest(".connection-handle")) {
      return;
    }
    
    // Check for connect mode or standard drag
    if (typeof isConnectMode !== "undefined" && isConnectMode) return;

    // Use the global drag starter
    if (typeof startDragMouse === "function") {
       startDragMouse(el, e);
    }
  };

  // Note: Touch events are handled globally by the workspace listener in your script.js,
  // so we don't need to attach ontouchstart here manually.

  // --- Append to Board ---
  const workspace = document.getElementById("workspace");
  if (workspace) workspace.appendChild(el);
  
  // --- Save ---
  // Use the safe autosave trigger
  if (typeof onBoardMutated === "function") {
      onBoardMutated("add_interlinear");
  } else if (window.BoardAPI && window.BoardAPI.triggerAutosave) {
      window.BoardAPI.triggerAutosave("add_interlinear");
  }

  return el;
}

// Attach to Global API
if (!window.BoardAPI) window.BoardAPI = {};
window.BoardAPI.addInterlinearCard = addInterlinearCard;