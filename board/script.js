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

// Try to reuse global constants if they exist, otherwise fall back to 5.
const CROSSREF_INITIAL_VISIBLE_COUNT =
  typeof INITIAL_VISIBLE_COUNT === "number" ? INITIAL_VISIBLE_COUNT : 5;
const CROSSREF_LOAD_MORE_CHUNK =
  typeof LOAD_MORE_CHUNK === "number" ? LOAD_MORE_CHUNK : 5;

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
function bringToFront(el) {
  if (!el || window.__readOnly) return;

  // 1. Scan all items to find the current highest Z-Index
  const allItems = document.querySelectorAll(".board-item");
  let maxZ = 0;
  for (let i = 0; i < allItems.length; i++) {
    const z = parseInt(allItems[i].style.zIndex) || 0;
    if (z > maxZ) maxZ = z;
  }

  // 2. Force the global counter to be higher than the max
  if (maxZ >= currentIndex) {
    currentIndex = maxZ + 1;
  } else {
    currentIndex++;
  }

  // 3. Apply to element
  el.style.zIndex = currentIndex;
}

// Delegate: bump z-index on ANY pointerdown inside a .board-item,
// even if the click is on an editable child and we don't start a drag.
document.addEventListener(
  "pointerdown",
  (ev) => {
    const card =
      ev.target && ev.target.closest && ev.target.closest(".board-item");
    if (!card) return;
    bringToFront(card);
  },
  { capture: true }
);

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
      } catch (e) {
        console.warn("Cache load failed", e);
      }
    }
  }

  _persist() {
    if (!this.storageKey) return;
    try {
      // Save as array of entries
      localStorage.setItem(
        this.storageKey,
        JSON.stringify(Array.from(this.cache.entries()))
      );
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

// Reverse bibleBookCodes mapping:
const codeToFullBook = {};
for (const [full, code] of Object.entries(bibleBookCodes)) {
  codeToFullBook[code] = full.toUpperCase();
}

function normalizeQueryRefForCrossrefAPI(str) {
  if (!str) return "";

  str = str.trim().toLowerCase();
  str = str.replace(/\s+/g, " ");

  // Numbered NT books (OpenBible format)
  str = str.replace(/1\s*p(et|e|ter)?/g, "1pet");
  str = str.replace(/2\s*p(et|e|ter)?/g, "2pet");

  str = str.replace(/1\s*j(ohn)?/g, "1jn");
  str = str.replace(/2\s*j(ohn)?/g, "2jn");
  str = str.replace(/3\s*j(ohn)?/g, "3jn");

  // Numbered OT books
  str = str.replace(/\b1\s*c(hr(on(icles)?)?)?/g, "1ch");
  str = str.replace(/\b2\s*c(hr(on(icles)?)?)?/g, "2ch");

  str = str.replace(/\b1\s*k(ings?)?/g, "1ki");
  str = str.replace(/\b2\s*k(ings?)?/g, "2ki");

  // Other common OpenBible abbreviations
  str = str.replace(/\bgenesis\b/g, "gen");
  str = str.replace(/\bexodus\b/g, "exod");
  str = str.replace(/\bpsalms?\b/g, "ps");
  str = str.replace(/\bproverbs?\b/g, "prov");
  str = str.replace(/\bisaiah\b/g, "isa");
  str = str.replace(/\bromans\b/g, "rom");
  str = str.replace(/\bhebrews\b/g, "heb");

  return str;
}

// Expand cross-reference like "Isa 45:18"
function expandReferenceAbbrev(ref) {
  if (!ref) return ref;

  // Handle ranges: "Col 1 16-Col 1:17"
  if (ref.includes("-")) {
    return ref
      .split("-")
      .map((part) => expandReferenceAbbrev(part.trim()))
      .join(" - ");
  }

  // Extract book + chapter:verse
  const match = ref.match(/^([1-3]?\s?[A-Za-z]+)\s+(\d+):(\d+)$/);
  if (!match) return ref;

  let [, bookAbbrev, ch, vs] = match;

  // Normalize abbreviation like "Ps", "Psa", "Psalm", "Psalms"
  const normalized = bookAbbrev.trim().toLowerCase();

  const abbrevMap = {
    // Old Testament
    gen: "Genesis",
    ge: "Genesis",
    gn: "Genesis",

    ex: "Exodus",
    exo: "Exodus",
    exod: "Exodus",

    lev: "Leviticus",
    lv: "Leviticus",

    num: "Numbers",
    nu: "Numbers",
    nm: "Numbers",

    deut: "Deuteronomy",
    dt: "Deuteronomy",
    deu: "Deuteronomy",

    jos: "Joshua",
    josh: "Joshua",

    jdg: "Judges",
    judg: "Judges",

    rut: "Ruth",

    "1sam": "1 Samuel",
    "2sam": "2 Samuel",
    "1sa": "1 Samuel",
    "2sa": "2 Samuel",

    "1kgs": "1 Kings",
    "2kgs": "2 Kings",
    "1ki": "1 Kings",
    "2ki": "2 Kings",

    "1chr": "1 Chronicles",
    "2chr": "2 Chronicles",

    ezr: "Ezra",
    neh: "Nehemiah",
    est: "Esther",

    job: "Job",

    ps: "Psalms",
    psa: "Psalms",
    psm: "Psalms",
    pss: "Psalms",

    prov: "Proverbs",
    pr: "Proverbs",
    pv: "Proverbs",

    eccl: "Ecclesiastes",
    ecc: "Ecclesiastes",

    song: "Song of Solomon",
    sos: "Song of Solomon",

    isa: "Isaiah",
    is: "Isaiah",

    jer: "Jeremiah",
    je: "Jeremiah",

    lam: "Lamentations",

    ezek: "Ezekiel",
    eze: "Ezekiel",

    dan: "Daniel",
    dn: "Daniel",

    hos: "Hosea",
    ho: "Hosea",

    joel: "Joel",
    jl: "Joel",

    amos: "Amos",
    am: "Amos",

    obad: "Obadiah",
    ob: "Obadiah",

    jon: "Jonah",
    jna: "Jonah",

    mic: "Micah",
    mi: "Micah",

    nah: "Nahum",
    na: "Nahum",

    hab: "Habakkuk",
    hb: "Habakkuk",

    zeph: "Zephaniah",
    zep: "Zephaniah",

    hag: "Haggai",
    hg: "Haggai",

    zech: "Zechariah",
    zec: "Zechariah",

    mal: "Malachi",

    // New Testament
    matt: "Matthew",
    mt: "Matthew",

    mark: "Mark",
    mk: "Mark",

    luke: "Luke",
    lk: "Luke",

    john: "John",
    jn: "John",

    acts: "Acts",
    ac: "Acts",

    rom: "Romans",
    ro: "Romans",

    "1cor": "1 Corinthians",
    "2cor": "2 Corinthians",
    "1co": "1 Corinthians",
    "2co": "2 Corinthians",

    gal: "Galatians",

    eph: "Ephesians",

    phil: "Philippians",
    php: "Philippians",

    col: "Colossians",
    cl: "Colossians",

    "1thess": "1 Thessalonians",
    "2thess": "2 Thessalonians",
    "1th": "1 Thessalonians",
    "2th": "2 Thessalonians",

    "1tim": "1 Timothy",
    "2tim": "2 Timothy",

    tit: "Titus",
    ti: "Titus",

    philem: "Philemon",
    phm: "Philemon",

    heb: "Hebrews",
    he: "Hebrews",

    jas: "James",
    jm: "James",

    "1pet": "1 Peter",
    "2pet": "2 Peter",
    "1pe": "1 Peter",
    "2pe": "2 Peter",
    "1pt": "1 Peter",
    "2pt": "2 Peter",

    "1john": "1 John",
    "2john": "2 John",
    "3john": "3 John",
    "1jn": "1 John",
    "2jn": "2 John",
    "3jn": "3 John",

    jude: "Jude",
    jud: "Jude",

    rev: "Revelation",
    re: "Revelation",
  };

  const fullBook =
    abbrevMap[normalized] ||
    abbrevMap[normalized.replace(/\s+/g, "")] ||
    bookAbbrev; // fallback

  // Keep normal casing: "Hebrews 11:3" instead of "HEBREWS 11:3"
  return `${fullBook} ${ch}:${vs}`;
}

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
  const el = document.getElementById("version-select");
  if (!el) return;

  // 1. Load from storage on init
  const saved = localStorage.getItem("bb:lastVersion");
  if (saved) {
    // Verify the saved version actually exists in the dropdown options
    const optionExists = Array.from(el.options).some((o) => o.value === saved);
    if (optionExists) {
      el.value = saved;
    }
  }

  // 2. Listen for changes
  el.addEventListener("change", () => {
    const newVersion = getSelectedVersion();
    localStorage.setItem("bb:lastVersion", newVersion);
    onBoardMutated("version_change");

    // 🔁 NEW: Refresh any search UI that depends on the version
    try {
      const mode = window.currentSearchMode || "bible";
      const searchBar = document.getElementById("search-bar");

      // If we're in CrossRef mode, keep the same reference but reload the verses
      if (mode === "crossref") {
        if (Array.isArray(crossRefResults) && crossRefResults.length > 0) {
          renderCrossRefPage(true);
        } else if (searchBar && searchBar.value.trim()) {
          updateCrossrefsFromCurrentContext(true); // force = true
        }
      }
      // 🔁 Bible mode: re-run the current query so the chapter text updates
      else if (mode === "bible" && searchBar && searchBar.value.trim()) {
        if (typeof window.__bbMarkBibleQueryNeedsSync === "function") {
          window.__bbMarkBibleQueryNeedsSync();
        }
        searchForQuery(null);
      }
    } catch (err) {
      console.warn("Version change refresh failed:", err);
    }

  });
})();

// ==================== Style Injection for Verse Numbers ====================
(function injectVerseStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .verse-num {
      font-size: 0.6em;
      opacity: 0.7;
      margin-right: 4px;
      font-weight: 700;
      vertical-align: super;
      line-height: 0;
    }
  `;
  document.head.appendChild(style);
})();

// ==================== 2. UPDATED: Fetch Single Verse ====================
async function fetchVerseText(book, chapter, verse, signal, version = "KJV") {
  if (version === "ESV") {
    // Always fetch the whole chapter for NLT to ensure correct splitting
    try {
      const verses = await fetchChapterText(book, chapter, signal, "ESV");
      const target = verses.find((v) => v.verse == verse);
      // Remove the [N] prefix if returning raw text for a single lookup
      // (Optional: Your addBibleVerse adds it back, but this keeps it clean)
      return target ? target.text : "Verse not found.";
    } catch (e) {
      return "ESV unavailable.";
    }
  }
  // --- NLT HANDLER ---
  if (version === "NLT") {
    // Always fetch the whole chapter for NLT to ensure correct splitting
    try {
      const verses = await fetchChapterText(book, chapter, signal, "NLT");
      const target = verses.find((v) => v.verse == verse);
      // Remove the [N] prefix if returning raw text for a single lookup
      // (Optional: Your addBibleVerse adds it back, but this keeps it clean)
      return target ? target.text : "Verse not found.";
    } catch (e) {
      return "NLT unavailable.";
    }
  }

  // --- EXISTING LOGIC (KJV, ASV) ---
  const code = bibleBookCodes[book] || book;
  const apiUrl = `https://full-bible-api.onrender.com/verse/${encodeURIComponent(
    version
  )}/${encodeURIComponent(code)}/${chapter}/${verse}`;

  const cacheKey = `${version}:${code}:${chapter}:${verse}`;
  const cached = verseCache.get(cacheKey);
  if (cached) return cached;

  if (signal?.aborted) throw new Error("Fetch aborted");

  try {
    const resp = await safeFetchWithFallbacks(apiUrl, signal);
    const data = await resp.json();

    let finalText = "Verse not found.";

    if (data.verses) {
      finalText = data.verses
        .map((v) => {
          const cleanText = v.text
            .replace(new RegExp(`^${v.verse}`), "")
            .trim();
          return `[${v.verse}] ${cleanText}`;
        })
        .join(" ");
    } else if (data.text) {
      const cleanText = data.text.replace(new RegExp(`^${verse}`), "").trim();
      finalText = `[${verse}] ${cleanText}`;
    }

    verseCache.set(cacheKey, finalText);
    return finalText;
  } catch (err) {
    if (signal?.aborted) throw err;
    return "Verse temporarily unavailable.";
  }
}

// ==================== NEW: Bible Search API Helpers ====================
let activeBibleSearchController = null;
/**
 * OPTIMIZATION: Use LRU cache
 * MODIFIED: Now includes the Bible 'version' in the API call and cache key.
 */
async function fetchBibleSearchResults(
  query,
  limit = 5,
  signal,
  version = "KJV"
) {
  // ADDED version
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
const songsContainer = document.getElementById("search-query-song-container");
const songsHeader = document.getElementById("search-query-songs-text");
if (songsHeader) {
  // Default mode is Bible, so hide Songs header until Songs mode is active.
  songsHeader.style.display = "none";
}

const crossrefContainer = document.getElementById("search-query-crossref");

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

// Global SVG namespace for all connection/ghost paths
const SVG_NS = "http://www.w3.org/2000/svg";

let svg = document.getElementById("connections");
if (!svg) {
  svg = document.createElementNS(SVG_NS, "svg");
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

const connectionsSvg = svg;

// ==================== Connection Line Mini Menu (edit/delete) ====================

// ==================== Connection Line Mini Menu (edit/delete) ====================

let activeConnectionPathForMenu = null;
let connectionLineMenuEl = null;
let rebuildConnectionMenuColors = null;
let connectionColorPlusButton = null;

// NEW: track if we've attached list click listeners yet
let connectionColorPaletteListBound = false;

// Modal state for the premium connection color palette
let connectionColorPaletteBackdrop = null;
let connectionColorPaletteModal = null;
let connectionColorPaletteListEl = null;
let connectionColorPaletteColorInput = null;
let connectionColorPaletteHexInput = null;

let activeConnectionAnchor = null;

// Small helper so we can reuse the same hex validation in a few places
function normalizeConnectionHex(color) {
  if (!color || typeof color !== "string") return null;
  let c = color.trim();
  if (!c) return null;
  if (c[0] !== "#") c = "#" + c;
  if (!/^#([0-9a-fA-F]{6})$/.test(c)) return null;
  return c.toUpperCase();
}

function isProAccount() {
  return !!window.BIBLEBOARD_IS_PRO;
}


function handleConnectionColorPlusClick(ev) {
  ev?.stopPropagation?.();

  const isReadOnly = !!window.__readOnly;
  const isPro = isProAccount();

  // Read-only: no changes allowed, but non-pro users can still see the upgrade paywall
  if (isReadOnly) {
    if (!isPro && typeof window.openUpgradeModal === "function") {
      window.openUpgradeModal("connection-colors");
    }
    return;
  }

  if (!isPro) {
    if (typeof window.openUpgradeModal === "function") {
      window.openUpgradeModal("connection-colors");
    }
    return;
  }

  // Pro + not read-only → open the palette
  openConnectionColorPaletteModal();
}

function findConnectionPathNearPoint(clientX, clientY) {
  const paths = Array.from(
    connectionsSvg.querySelectorAll("path.connection-line")
  );
  if (!paths.length) return null;

  // How much extra space around the visual line counts as a "hit"
  const PADDING = 100; // increase if you want an even bigger invisible hitbox

  for (const path of paths) {
    if (path.classList.contains("draft")) continue;

    const rect = path.getBoundingClientRect();

    const expandedLeft = rect.left - PADDING;
    const expandedRight = rect.right + PADDING;
    const expandedTop = rect.top - PADDING;
    const expandedBottom = rect.bottom + PADDING;

    const inside =
      clientX >= expandedLeft &&
      clientX <= expandedRight &&
      clientY >= expandedTop &&
      clientY <= expandedBottom;

    if (inside) {
      return path;
    }
  }

  return null;
}



// Injects the small bit of CSS needed for the color palette modal
function ensureConnectionColorPaletteStyles() {
  if (document.getElementById("connection-color-palette-styles")) return;

  const style = document.createElement("style");
  style.id = "connection-color-palette-styles";
  style.textContent = `
    .connection-color-palette-backdrop {
      position: relative;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(16px);
      z-index: 6000000;
    }
    .connection-color-palette-backdrop.visible {
      display: flex;
    }
    .connection-color-palette-modal {
      width: calc(100vw - 50px);
      max-width:500px;
      background: var(--bg);
      border-radius: 25px;
      border: 1px solid var(--fg-seethrough, rgba(148,163,184,0.5));
      box-shadow: 0 18px 60px rgba(0,0,0,0.8);
      max-width: 400px;
      background: var(--bg); /* Or #202020 to match image specifically */
      border: 1px solid var(--border);
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      color: var(--fg, #e5e7eb);
    }
    .connection-color-palette-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 4px;
    }
    .connection-color-palette-title-group h3 {
      font-size: 1.1rem;
      margin-bottom: 12px;
      color: var(--fg);
      margin-top:0px;
    }
    .connection-color-palette-title-group p {
      font-size: 0.95rem;
      color: var(--fg);
      margin:0px;
      padding:0px;
    }
    .connection-color-palette-close-btn {
      position: absolute;
      top: 14px;
      right: 14px;
      border: 1px solid var(--border);
      background: var(--bg-dots);
      color: var(--muted);
      border-radius: 50%;
      width: 38px;
      height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .connection-color-picker-row {
      display: flex;
      align-items: center;
      // gap: 8px;
    }
    .connection-color-picker-row input[type="color"] {
      -webkit-appearance: none;
      border-radius: 999px;
      border: 1px solid var(--border, #374151);
      width: 32px;
      height: 32px;
      padding: 0;
      background: transparent;
      cursor: pointer;
    }
    .connection-color-picker-row input[type="color"]::-webkit-color-swatch {
      border-radius: 999px;
      border: none;
    }
    .connection-color-hex-group {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .connection-color-hex-group label {
      font-size: 11px;
      color: var(--muted, #9ca3af);
    }
    .connection-color-hex-group input[type="text"] {
      width: 100%;
      border-radius: 999px;
      border: 1px solid var(--border, #374151);
      background: var(--bg-alt, #020617);
      color: var(--fg, #e5e7eb);
      padding: 6px 10px;
      font-size: 12px;
      outline: none;
    }
    .connection-color-hex-group input[type="text"]:focus {
      border-color: var(--accent, #22c55e);
    }
    .connection-color-add-btn {
      border-radius: 999px;
      border: 1px solid var(--accent, #22c55e);
      background: linear-gradient(135deg, var(--accent, #22c55e), #4ade80);
      color: #020617;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 10px;
      cursor: pointer;
      white-space: nowrap;
    }
    .connection-color-palette-saved {
      border-top: 1px solid var(--bg-seethrough, rgba(148,163,184,0.25));
      padding-top: 10px;
      margin-top: 4px;
    }
    .connection-color-palette-subtitle {
      font-size: 11px;
      color: var(--muted, #9ca3af);
      margin: 0 0 6px;
    }
  `;
  document.head.appendChild(style);
}

function ensureConnectionColorPaletteModal() {
  if (connectionColorPaletteBackdrop) return;

  ensureConnectionColorPaletteStyles();

  const backdrop = document.createElement("div");
  backdrop.className = "connection-color-palette-backdrop";
  backdrop.id = "connection-color-palette-backdrop";

  const modal = document.createElement("div");
  modal.className = "connection-color-palette-modal";
  modal.innerHTML = `
    <div class="connection-color-palette-header">
      <div class="connection-color-palette-title-group">
        <h3>Connection colors</h3>
        <p class="delete-modal-text">Save colors you reuse across boards.</p>
      </div>
      <button type="button" class="connection-color-palette-close-btn" aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="connection-color-picker-row">
      <input type="color" id="connection-color-picker-input" aria-label="Pick color" />
      <div class="connection-color-hex-group" style="display:none;">
        <label for="connection-color-hex-input">Hex</label>
        <input id="connection-color-hex-input" type="text" maxlength="7" placeholder="#F97316" />
      </div>
      <button type="button" class="connection-color-add-btn">Add color</button>
    </div>
    <div class="connection-color-palette-saved">
      <p class="connection-color-palette-subtitle">Added colors</p>
      <div class="connection-color-palette-list" data-role="connection-color-list"></div>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  connectionColorPaletteBackdrop = backdrop;
  connectionColorPaletteModal = modal;
  connectionColorPaletteListEl = modal.querySelector("[data-role='connection-color-list']");
  connectionColorPaletteColorInput = modal.querySelector("#connection-color-picker-input");
  connectionColorPaletteHexInput = modal.querySelector("#connection-color-hex-input");

  const closeBtn = modal.querySelector(".connection-color-palette-close-btn");
  closeBtn.addEventListener("click", () => {
    closeConnectionColorPaletteModal();
  });

  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) {
      closeConnectionColorPaletteModal();
    }
  });

  // Sync picker -> hex
  connectionColorPaletteColorInput.addEventListener("input", () => {
    const hex = normalizeConnectionHex(connectionColorPaletteColorInput.value);
    if (!hex) return;
    connectionColorPaletteHexInput.value = hex;
  });

  // Sync hex -> picker
  connectionColorPaletteHexInput.addEventListener("blur", () => {
    const hex = normalizeConnectionHex(connectionColorPaletteHexInput.value);
    if (!hex) return;
    connectionColorPaletteHexInput.value = hex;
    connectionColorPaletteColorInput.value = hex;
  });

  const addBtn = modal.querySelector(".connection-color-add-btn");
  addBtn.addEventListener("click", () => {
    handleAddConnectionUserColor();
  });

  // Escape closes the modal
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeConnectionColorPaletteModal();
    }
  });
}

function openConnectionColorPaletteModal() {
  ensureConnectionColorPaletteModal();
  if (!connectionColorPaletteBackdrop) return;

  let initial = "#F97316";
  if (
    window.BoardAPI &&
    typeof window.BoardAPI.getConnectionColor === "function"
  ) {
    const current = window.BoardAPI.getConnectionColor();
    const normalized = normalizeConnectionHex(current);
    if (normalized) {
      initial = normalized;
    }
  }

  connectionColorPaletteColorInput.value = initial;
  connectionColorPaletteHexInput.value = initial;

  refreshConnectionColorPaletteList();
  connectionColorPaletteBackdrop.classList.add("visible");
}

function closeConnectionColorPaletteModal() {
  if (!connectionColorPaletteBackdrop) return;
  connectionColorPaletteBackdrop.classList.remove("visible");
}































// --- Custom user connection colors (shared with board/) ---

// Same key used by board/connection-colors.js
const CONNECTION_USER_COLORS_KEY = "bb:connectionUserColors";

// Load saved user colors from localStorage
function loadConnectionUserColors() {
  try {
    const raw = localStorage.getItem(CONNECTION_USER_COLORS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set();
    const out = [];

    for (const c of parsed) {
      const hex = normalizeConnectionHex(c);
      if (!hex) continue;
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push(hex);
    }

    return out;
  } catch (err) {
    console.warn("[Connections] Failed to load user colors", err);
    return [];
  }
}

// Save user colors back to localStorage
function saveConnectionUserColors(colors) {
  try {
    const seen = new Set();
    const cleaned = [];

    for (const c of colors) {
      const hex = normalizeConnectionHex(c);
      if (!hex) continue;
      if (seen.has(hex)) continue;
      seen.add(hex);
      cleaned.push(hex);
    }

    localStorage.setItem(CONNECTION_USER_COLORS_KEY, JSON.stringify(cleaned));
  } catch (err) {
    console.warn("[Connections] Failed to save user colors", err);
  }
}

// Rebuild the list in the "Connection Color Palette" modal
function refreshConnectionColorPaletteList() {
  if (!connectionColorPaletteListEl) return;

  // Lazy-attach click handlers once
  if (!connectionColorPaletteListBound) {
    connectionColorPaletteListEl.addEventListener("click", (ev) => {
      const pill = ev.target.closest(".connection-color-pill");
      if (!pill) return;

      const color = pill.getAttribute("data-color");
      if (!color) return;

      // Remove button
      if (ev.target.closest(".connection-color-pill-remove")) {
        handleRemoveConnectionUserColor(color);
        ev.stopPropagation();
        return;
      }

      // Apply color to the current connection
      applyConnectionColorFromPalette(color);
    });

    connectionColorPaletteListBound = true;
  }

  // Clear current contents
  connectionColorPaletteListEl.innerHTML = "";

  const colors = loadConnectionUserColors();
  if (!colors.length) {
    const empty = document.createElement("div");
    empty.className = "connection-color-palette-empty";
    empty.textContent = 'No saved colors yet. Pick a color and click "Add".';
    connectionColorPaletteListEl.appendChild(empty);
    return;
  }

  // Render color pills
  for (const raw of colors) {
    const hex = normalizeConnectionHex(raw);
    if (!hex) continue;

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "connection-color-pill";
    pill.setAttribute("data-color", hex);

    const dot = document.createElement("span");
    dot.className = "connection-color-pill-dot";
    dot.style.backgroundColor = hex;

    const label = document.createElement("span");
    label.className = "connection-color-pill-hex";
    // label.textContent = hex;

    const remove = document.createElement("span");
    remove.className = "connection-color-pill-remove";
    remove.setAttribute("aria-label", "Remove color");
    remove.textContent = "×";

    pill.appendChild(dot);
    pill.appendChild(label);
    pill.appendChild(remove);

    connectionColorPaletteListEl.appendChild(pill);
  }
}

// "Add color" button in the modal
function handleAddConnectionUserColor() {
  if (window.__readOnly) return;

  const fromHex = normalizeConnectionHex(
    connectionColorPaletteHexInput?.value || ""
  );
  const fromPicker = normalizeConnectionHex(
    connectionColorPaletteColorInput?.value || ""
  );
  const color = fromHex || fromPicker;
  if (!color) return;

  const existing = loadConnectionUserColors();
  // Move to front if already in list
  const filtered = existing.filter(
    (c) => normalizeConnectionHex(c) !== color
  );
  filtered.unshift(color);

  // Optional limit
  const limited = filtered.slice(0, 24);
  saveConnectionUserColors(limited);

  // Keep inputs in sync
  if (connectionColorPaletteHexInput) {
    connectionColorPaletteHexInput.value = color;
  }
  if (connectionColorPaletteColorInput) {
    connectionColorPaletteColorInput.value = color;
  }

  refreshConnectionColorPaletteList();

  // Also let the small connection line menu refresh its swatches
  try {
    if (typeof rebuildConnectionMenuColors === "function") {
      rebuildConnectionMenuColors();
    }
  } catch {
    // ignore
  }
}

// Remove a color from the palette
function handleRemoveConnectionUserColor(colorToRemove) {
  const target = normalizeConnectionHex(colorToRemove);
  if (!target) return;

  const colors = loadConnectionUserColors();
  const filtered = colors.filter(
    (c) => normalizeConnectionHex(c) !== target
  );
  saveConnectionUserColors(filtered);
  refreshConnectionColorPaletteList();

  try {
    if (typeof rebuildConnectionMenuColors === "function") {
      rebuildConnectionMenuColors();
    }
  } catch {
    // ignore
  }
}

// Apply a palette color to the currently selected connection
function applyConnectionColorFromPalette(color) {
  const hex = normalizeConnectionHex(color);
  if (!hex || !window.BoardAPI) return;

  // 1) Change the color of the currently selected connection line
  try {
    if (
      activeConnectionPathForMenu &&
      typeof window.BoardAPI.setConnectionColorForPath === "function"
    ) {
      // ✅ Pass the actual <path> element, not an id
      window.BoardAPI.setConnectionColorForPath(
        activeConnectionPathForMenu,
        hex
      );
    } else if (typeof window.BoardAPI.setConnectionColor === "function") {
      // Fallback: set current color globally
      window.BoardAPI.setConnectionColor(hex);
    }
  } catch (err) {
    console.warn(
      "[Connections] Failed to apply color from palette:",
      err
    );
  }

  // 2) Make sure this color is part of the small connection-line-menu list
  try {
    if (
      typeof window.BoardAPI.addUserConnectionColor === "function"
    ) {
      window.BoardAPI.addUserConnectionColor(hex);
    }
  } catch (err) {
    console.warn(
      "[Connections] Failed to add palette color to menu list:",
      err
    );
  }

  // 3) Rebuild the swatches in the mini connection menu
  try {
    if (typeof rebuildConnectionMenuColors === "function") {
      rebuildConnectionMenuColors();
    }
  } catch {
    // ignore
  }

  // Close the palette modal but leave the mini menu open
  closeConnectionColorPaletteModal();
}





function closeConnectionLineMenu() {
  clearConnectionHighlight?.();

  if (!connectionLineMenuEl) return;
  connectionLineMenuEl.style.display = "none";
  activeConnectionPathForMenu = null;
  activeConnectionAnchor = null;
}


function updateConnectionLineMenuPosition() {
  // If menu isn't open, nothing to do
  if (!connectionLineMenuEl || connectionLineMenuEl.style.display === "none") {
    return;
  }

  // If we don't have a path anymore, or it was removed from DOM, close the menu
  if (
    !activeConnectionPathForMenu ||
    !document.body.contains(activeConnectionPathForMenu)
  ) {
    closeConnectionLineMenu();
    return;
  }

  const rect = activeConnectionPathForMenu.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    return;
  }

  // Use the real width/height of the menu
  const menuWidth = connectionLineMenuEl.offsetWidth || 0;
  const menuHeight = connectionLineMenuEl.offsetHeight || 0;

  // Use the stored anchor if we have one, else default to middle-right
  let anchorX;
  let anchorY;
  if (activeConnectionAnchor) {
    anchorX =
      rect.left + rect.width * activeConnectionAnchor.relX;
    anchorY =
      rect.top + rect.height * activeConnectionAnchor.relY;
  } else {
    anchorX = rect.right;
    anchorY = rect.top + rect.height / 2;
  }

  // Start with menu slightly to the right of the anchor
  let x = anchorX + 8;
  let y = anchorY - menuHeight / 2;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // If going off right edge, flip to the left side of the anchor
  if (x + menuWidth > vw - 8) {
    x = anchorX - menuWidth - 8;
  }

  // --- NEW: keep it to the right of the action buttons ---
  let minX = 8;
  const actions = document.getElementById("action-buttons-container");
  if (actions) {
    const actionRect = actions.getBoundingClientRect();
    // right edge of the left toolbar + a small gap
    minX = Math.max(minX, actionRect.right + 12);
  }

  const maxX = vw - menuWidth - 8;

  if (x < minX) x = minX;
  if (x > maxX) x = maxX;

  // Clamp vertically so it stays on-screen
  if (y < 8) y = 8;
  if (y + menuHeight > vh - 8) {
    y = vh - menuHeight - 8;
  }

  connectionLineMenuEl.style.left = `${x}px`;
  connectionLineMenuEl.style.top = `${y}px`;
}




function ensureConnectionLineMenu() {
  if (connectionLineMenuEl) return;

  const el = document.createElement("div");
  el.id = "connection-line-menu";
  el.innerHTML = `
    <button type="button" data-action="delete" class="connection-delete-button">
      <svg class="action-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-trash">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M4 7l16 0" fill="none"/>
        <path d="M10 11l0 6" fill="none"/>
        <path d="M14 11l0 6" fill="none"/>
        <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" fill="none"/>
        <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" fill="none"/>
      </svg>
    </button>
    <div class="seperation-line"></div>
    <div class="color-row-container">
      <div class="color-row" data-role="color-row"></div>
      <div class="color-row-fade-right"></div>
      <div class="color-row-fade-left"></div>
    </div>
  `;
  document.body.appendChild(el);

  const deleteBtn = el.querySelector("button[data-action='delete']");
  deleteBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (
      activeConnectionPathForMenu &&
      window.BoardAPI &&
      typeof window.BoardAPI.disconnectLine === "function"
    ) {
      window.BoardAPI.disconnectLine(activeConnectionPathForMenu);
    }
    closeConnectionLineMenu();
  });

  const colorRow = el.querySelector("[data-role='color-row']");

  // Persistent "+" button at the far right of the color row
  connectionColorPlusButton = document.createElement("button");
  connectionColorPlusButton.type = "button";
  connectionColorPlusButton.className = "color-swatch connection-color-plus-btn";
  connectionColorPlusButton.setAttribute("aria-label", "More connection colors");
  connectionColorPlusButton.textContent = "+";
  connectionColorPlusButton.style.display = "flex";
  connectionColorPlusButton.style.alignItems = "center";
  connectionColorPlusButton.style.justifyContent = "center";
  connectionColorPlusButton.style.fontSize = "14px";
  connectionColorPlusButton.style.color = "var(--fg)";
  connectionColorPlusButton.addEventListener("click", handleConnectionColorPlusClick);

  rebuildConnectionMenuColors = () => {
    colorRow.innerHTML = "";

    let colors = [];
    if (
      window.BoardAPI &&
      typeof window.BoardAPI.getConnectionColors === "function"
    ) {
      colors = window.BoardAPI.getConnectionColors() || [];
    }
    if (!colors.length) {
      // fallback palette if connection-colors.js isn't loaded
      colors = ["#F97316", "#22C55E", "#3B82F6", "#A855F7"];
    }

    colors.forEach((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "color-swatch";
      swatch.dataset.color = color;
      swatch.style.backgroundColor = color;
      swatch.title = `Set connection color (${color})`;

      swatch.addEventListener("click", (ev) => {
        ev.stopPropagation();

        if (!window.BoardAPI) return;

        if (
          typeof window.BoardAPI.setConnectionColorForPath === "function" &&
          activeConnectionPathForMenu
        ) {
          // Prefer per-line recolor if available
          window.BoardAPI.setConnectionColorForPath(
            activeConnectionPathForMenu,
            color
          );
        } else if (typeof window.BoardAPI.setConnectionColor === "function") {
          // Fallback: just update the global current color
          window.BoardAPI.setConnectionColor(color);
        }
      });

      colorRow.appendChild(swatch);
    });

    // Always keep the "+" button on the far right
    if (connectionColorPlusButton) {
      colorRow.appendChild(connectionColorPlusButton);
    }
  };

  connectionLineMenuEl = el;

  // Expose so connection-colors.js can ask the menu to rebuild its swatches
  window.rebuildConnectionMenuColors = rebuildConnectionMenuColors;
}



function openConnectionLineMenu(path, clientX, clientY) {
  ensureConnectionLineMenu();
  activeConnectionPathForMenu = path;

  // Compute where inside the line's bounding box the user clicked (0–1 in both directions)
  const rect = path.getBoundingClientRect();
  if (rect && (rect.width || rect.height)) {
    const relX = rect.width ? (clientX - rect.left) / rect.width : 0.5;
    const relY = rect.height ? (clientY - rect.top) / rect.height : 0.5;
    activeConnectionAnchor = {
      relX: Math.min(1, Math.max(0, relX)),
      relY: Math.min(1, Math.max(0, relY)),
    };
  } else {
    // Fallback: middle of the line
    activeConnectionAnchor = { relX: 0.5, relY: 0.5 };
  }

  // highlight the line if you have this helper
  if (typeof highlightConnection === "function") {
    highlightConnection(path);
  }

  // rebuild swatches each time in case palette / current color changed
  if (typeof rebuildConnectionMenuColors === "function") {
    rebuildConnectionMenuColors();
  }

  connectionLineMenuEl.style.display = "flex";

  // Position based on the line's current on-screen position + anchor
  updateConnectionLineMenuPosition();
}



// Click on a connection line → show mini menu
connectionsSvg.addEventListener("click", (ev) => {
  if (window.__readOnly) return;

  // Don't interfere with your existing "disconnect mode"
  if (typeof window.disconnectMode !== "undefined" && window.disconnectMode) {
    return;
  }

  // Only react to clicks on a line or its hitbox
  const lineEl = ev.target.closest(
    "path.connection-line, path.connection-line-hit"
  );
  if (!lineEl) {
    // Clicked empty space in the svg – just close the menu if open
    closeConnectionLineMenu();
    return;
  }

  // Ignore the little X handle
  if (ev.target.closest(".handle-circle")) {
    return;
  }

  // Map the clicked element (path or hitPath) back to its connection
  let canonicalPath = null;

  if (window.BoardAPI && typeof window.BoardAPI.getConnections === "function") {
    const conns = window.BoardAPI.getConnections() || [];
    const match = conns.find(
      (c) => c.path === lineEl || c.hitPath === lineEl
    );
    if (match && match.path) {
      canonicalPath = match.path;
    }
  }

  // Fallback: if we didn't find anything, only allow real connection-line
  if (!canonicalPath && lineEl.classList.contains("connection-line")) {
    canonicalPath = lineEl;
  }

  if (!canonicalPath) {
    return;
  }

  ev.stopPropagation();
  openConnectionLineMenu(canonicalPath, ev.clientX, ev.clientY);
});

function clearConnectionHighlight() {
  if (!window.BoardAPI || typeof window.BoardAPI.getConnections !== "function") {
    return;
  }
  const conns = window.BoardAPI.getConnections() || [];
  conns.forEach((c) => {
    if (c.hitPath) {
      c.hitPath.classList.remove("connection-line-hit-selected");
    }
  });
}

function highlightConnection(path) {
  if (!window.BoardAPI || typeof window.BoardAPI.getConnections !== "function") {
    return;
  }
  const conns = window.BoardAPI.getConnections() || [];
  conns.forEach((c) => {
    if (!c.hitPath) return;
    if (c.path === path) {
      c.hitPath.classList.add("connection-line-hit-selected");
    } else {
      c.hitPath.classList.remove("connection-line-hit-selected");
    }
  });
}



// Click anywhere else on the page → close the menu
document.addEventListener("click", (ev) => {
  if (!connectionLineMenuEl || connectionLineMenuEl.style.display === "none") {
    return;
  }
  if (connectionLineMenuEl.contains(ev.target)) {
    // clicks inside the menu are handled above
    return;
  }
  closeConnectionLineMenu();
});


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

// --- Verse Multi-Select Queue State (shared across all modes) ---
window.pendingVerseAdds = window.pendingVerseAdds || new Map();
const pendingVerseAdds = window.pendingVerseAdds;

// --- Song queue (parallel to verse queue) ---
window.pendingSongAdds = window.pendingSongAdds || new Map();

// --- Interlinear queue (parallel to others) ---
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
  if (!searchQueryContainer) return;

  // Enable smooth transitions when requested
  if (withTransition) {
    // Search drawer: fade + slight vertical motion
    searchQueryContainer.style.transition =
      "opacity 0.25s ease, top 0.25s ease";

    // Viewport: fade + slide
    if (viewport) {
      viewport.style.transition =
        "opacity 0.25s ease, transform 0.25s ease";
    }
  }

  if (searchDrawerOpen) {
    // === Drawer OPEN: panel fades in & up ===
    searchQueryContainer.style.zIndex = "10005";
    searchQueryContainer.style.top = "0px";      // move up into place
    searchQueryContainer.style.opacity = "1";    // fade in

    // Viewport fades out & slides up a bit
    if (viewport) {
      viewport.style.opacity = "0";
      viewport.style.transform = "translateY(-12px)";
      viewport.style.pointerEvents = "none";
    }
  } else {
    // === Drawer CLOSED: panel fades out & slightly down ===
    searchQueryContainer.style.top = "20px";     // slide down
    searchQueryContainer.style.opacity = "0";    // fade out

    // After fade-out, drop zIndex so it's not clickable
    setTimeout(() => {
      if (!searchDrawerOpen) {
        searchQueryContainer.style.zIndex = "-1";
      }
    }, 250);

    // Viewport fades in & slides down into place
    if (viewport) {
      viewport.style.opacity = "1";
      viewport.style.transform = "translateY(0)";
      viewport.style.pointerEvents = "auto";
    }
  }

  // Interlinear panel still controlled via .open class
  if (interPanel) {
    interPanel.classList.toggle("open", interlinearOpen);
  }
}



// ==================== State ====================
// ... (All state variables unchanged) ...
let isPanning = false;
let hasMovedDuringDrag = false;
let ignoreNextClick = false;
let startX, startY, scrollLeft, scrollTop;
let active = null;
let offsetX, offsetY;
let scale = 1;
let currentIndex = 1;
let contextMenuTargetItem = null;
const MIN_SCALE = 0.15,
  MAX_SCALE = 1.5,
  PINCH_SENS = 0.003,
  WHEEL_SENS = 0.001;

function syncHandleScaleVar() {
  const s =
    (typeof scale === "number" && isFinite(scale) && scale > 0 ? scale : 1) / .75;
  const inverse = 1 / s;
  document.documentElement.style.setProperty(
    "--bb-handle-scale",
    inverse.toString()
  );
}

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

    syncHandleScaleVar(); // 👈 keep dots size fixed

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
    if (didYouMeanText) didYouMeanText.style.display = "none";
    return;
  }

  // Use the structure from style.css (div is already styled as a link)
  didYouMeanText.innerHTML = `Did you mean <div>${result.reference}</div>?`;
  didYouMeanText.style.display = "flex"; // Make it visible

  const link = didYouMeanText.querySelector("div");
  if (link) {
    // Use .onclick to ensure only one handler is attached
    link.onclick = (e) => {
      e.preventDefault();
      if (searchBar) {
        searchBar.value = result.reference; // Set input to suggestion
      }
      didYouMeanText.style.display = "none"; // Hide suggestion
      searchForQuery(null); // Re-run search with the correct query
    };
  }
}

/**
 * Fetches an entire chapter.
 * NLT/ESV: Uses official APIs (HTML/JSON) and cleans it.
 * Others: Uses default JSON API.
 */
async function fetchChapterText(book, chapter, signal, version = "KJV") {
  const cacheKey = `${version}:${book}:${chapter}`;
  const cached = chapterCache.get(cacheKey);
  if (cached) return cached;

  if (signal?.aborted) throw new Error("Fetch aborted");

  // ==================================================
  // 1. OFFICIAL ESV HANDLER (DEFINITIVE FIX)
  // ==================================================
  // if (version === "ESV") {
  //   const ESV_API_KEY = "4fb585d0388365ed4f7273b1adcbcdad71575a37";
  //   // NOTE: Requires ESV_API_KEY constant defined elsewhere in script.js
  //   if (
  //     typeof ESV_API_KEY === "undefined" ||
  //     ESV_API_KEY === "YOUR_ESV_API_KEY_HERE"
  //   ) {
  //     throw new Error("ESV API key not set.");
  //   }

  //   const ESV_MAP = {
  //     "1 Kings": "1KI",
  //     "2 Kings": "2KI",
  //     "1 Samuel": "1SA",
  //     "2 Samuel": "2SA",
  //     "1 Corinthians": "1CO",
  //     "2 Corinthians": "2CO",
  //     "1 Chronicles": "1CH",
  //     "2 Chronicles": "2CH",
  //     "1 Thessalonians": "1TH",
  //     "2 Thessalonians": "2TH",
  //     "1 Timothy": "1TI",
  //     "2 Timothy": "2TI",
  //     "1 Peter": "1PE",
  //     "2 Peter": "2PE",
  //     "1 John": "1JN",
  //     "2 John": "2JN",
  //     "3 John": "3JN",
  //   };

  //   if (ESV_MAP[book]) book = ESV_MAP[book];

  //   console.log(book);

  //   // ESV API uses a slightly different book naming convention (e.g., '1 John' -> '1-John')
  //   const ref = `${book} ${chapter}`.replace(/\s/g, "-");

  //   // Applying the correct API options to return full chapter content for parsing
  //   const apiUrl = `https://api.esv.org/v3/passage/html/?q=${encodeURIComponent(
  //     ref
  //   )}&include-verse-numbers=true&include-heading=false&include-footnotes=false&include-passage-references=false&include-short-copyright=true`;
  //   // const apiUrl = `https://api.esv.org/v3/passage/html/?q=1JN1&include-verse-numbers=true&include-heading=false&include-footnotes=false&include-passage-references=false&include-short-copyright=false`;

  //   try {
  //     const resp = await fetch(apiUrl, {
  //       signal,
  //       headers: { Authorization: `Token ${ESV_API_KEY}` },
  //     });

  //     if (!resp.ok) {
  //       throw new Error(`ESV API Error: ${resp.status}`);
  //     }

  //     const data = await resp.json();
  //     if (!data.passages || data.passages.length === 0) {
  //       throw new Error("No verses found for ESV.");
  //     }

  //     const html = data.passages[0];

  //     console.log(data)
  //     const parser = new DOMParser();
  //     // Parse the HTML content returned by the ESV API
  //     const doc = parser.parseFromString(html, "text/html");
  //     const textContainer = doc.querySelector(".passage-text") || doc.body;

  //     // 1. Clean up junk elements/headings, including the overall chapter heading
  //     textContainer
  //       .querySelectorAll(
  //         ".esv-passage-heading, .footnotes, .p-end-paragraph, .chapter-num, .chapter-num-break, h3, .heading-paragraph"
  //       )
  //       .forEach((el) => el.remove());

  //     console.log(textContainer);
  //     let currentVerseNum = 1;
  //     const versesMap = new Map();
  //     versesMap.set(1, ""); // Initialize Verse 1 to capture leading text

  //     // 2. Walk the DOM and extract verses
  //     function walk(node) {
  //       if (node.nodeType === Node.ELEMENT_NODE) {
  //         // Check for the ESV verse number marker
  //         if (node.classList.contains("verse-num")) {
  //           // Found a verse number, switch context
  //           const num = parseInt(
  //             node.textContent.trim().replace(/[\[\]]/g, "")
  //           );
  //           if (!isNaN(num)) {
  //             currentVerseNum = num;
  //             if (!versesMap.has(num)) versesMap.set(num, "");
  //           }
  //           // Do NOT recursively process children of the versenum span/bold tag
  //         }

  //         // Continue recursive walk for all child elements
  //         node.childNodes.forEach(walk);
  //       } else if (node.nodeType === Node.TEXT_NODE) {
  //         // Aggregate text content
  //         const text = node.textContent.replace(/\s+/g, " ").trim();

  //         if (text && currentVerseNum !== null) {
  //           let currentText = versesMap.get(currentVerseNum) || "";

  //           // Append text, ensuring a single space separator if needed
  //           const prefix =
  //             currentText.length > 0 && !currentText.endsWith(" ") ? " " : "";
  //           versesMap.set(currentVerseNum, currentText + prefix + text);
  //         }
  //       }
  //     }

  //     walk(textContainer);

  //     // 3. Final formatting and cleanup
  //     const finalVerses = [];
  //     for (const [vn, rawText] of versesMap.entries()) {
  //       // Remove leading number if it snuck in and trim excess space
  //       let cleanText = rawText.trim().replace(new RegExp(`^${vn}\\s*`), "");
  //       if (cleanText) {
  //         finalVerses.push({
  //           verse: vn,
  //           text: `[${vn}] ${cleanText}`, // Explicitly wrap in brackets
  //         });
  //       }
  //     }

  //     finalVerses.sort((a, b) => a.verse - b.verse);

  //     if (finalVerses.length === 0)
  //       throw new Error("No verses parsed from ESV.");

  //     chapterCache.set(cacheKey, finalVerses);
  //     return finalVerses;
  //   } catch (err) {
  //     if (signal?.aborted) throw err;
  //     throw new Error(`ESV content unavailable: ${err.message}`);
  //   }
  // }

  // ==================================================
  // 2. OFFICIAL NLT (via api.nlt.to) - Retaining original logic structure
  // ==================================================
  if (version === "NLT") {
    const NLT_KEY = "TEST"; // Use 'TEST' or your real key

    // --- BOOK MAPPING ---
    let code = bibleBookCodes[book] || book;

    // 2. OVERRIDE: Map codes to NLT-friendly names
    const nltMap = {
      SNG: "Song",
      PRO: "Prov",
      ECC: "Eccl",
      // Numbered Books (Use spaces!)
      "1KI": "1 Kings",
      "2KI": "2 Kings",
      "1SA": "1 Samuel",
      "2SA": "2 Samuel",
      "1PE": "1 Peter",
      "2PE": "2 Peter",
      "1JN": "1 John",
      "2JN": "2 John",
      "3JN": "3 John",
      // Other abbreviations that might fail
      PHP: "Phil",
      PHM: "Phlm",
      JHN: "John",
      EZK: "Ezek",
      JOS: "Josh",
      JDG: "Judg",
      EST: "Esth",
      NAM: "Nah",
      PSA: "Psalm",
      JOL: "Joel",
      AMO: "Amos",
      OBA: "Obadiah",
      ZEP: "Zephaniah",
      ZEC: "Zechariah",
      MAT: "Matthew",

      MRK: "Mark",
      LUK: "Luke",
      ACT: "Acts",
      JUD: "Jude",
      EXO: "Exodus",
      DEU: "Deuteronomy",
    };

    if (nltMap[code]) code = nltMap[code];

    const ref = encodeURIComponent(`${code}.${chapter}`);
    const url = `https://api.nlt.to/api/passages?ref=${ref}&version=NLT&key=${NLT_KEY}`;

    const cacheKey = `NLT_CH:${book}:${chapter}`;
    const cached = chapterCache.get(cacheKey);
    if (cached) return cached;

    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error("NLT API Error");

      const htmlText = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");

      // 1. Clean up junk elements
      const junk = doc.querySelectorAll(
        ".tn, .a-tn, .chapter-number, .subhead, .cw, .cw_ch"
      );
      junk.forEach((el) => el.remove());

      const container = doc.querySelector("body");
      let currentVerseNum = null;
      const versesMap = new Map();

      function walk(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.classList.contains("vn")) {
            const num = parseInt(node.textContent.trim());
            if (!isNaN(num)) {
              currentVerseNum = num;
              if (!versesMap.has(num)) versesMap.set(num, "");
            }
            return;
          }
        }

        if (node.nodeType === Node.TEXT_NODE && currentVerseNum !== null) {
          const text = node.textContent.replace(/\s+/g, " ");
          const currentText = versesMap.get(currentVerseNum);
          versesMap.set(currentVerseNum, currentText + text);
        }

        node.childNodes.forEach(walk);
      }

      walk(container);

      const verses = [];
      for (const [vn, text] of versesMap.entries()) {
        let cleanText = text.trim().replace(new RegExp(`^${vn}\\s*`), "");

        if (cleanText) {
          verses.push({
            verse: vn,
            text: `[${vn}] ${cleanText}`, // Explicitly wrap in brackets
          });
        }
      }

      verses.sort((a, b) => a.verse - b.verse);
      if (verses.length === 0) throw new Error("No verses parsed from NLT.");

      chapterCache.set(cacheKey, verses);
      return verses;
    } catch (err) {
      console.error("NLT Fetch Failed:", err);
      if (signal?.aborted) throw err;
      throw new Error("NLT content unavailable.");
    }
  }

  // ==================================================
  // 3. DEFAULT HANDLER (KJV, ASV, etc.)
  // ==================================================
  const code = bibleBookCodes[book] || book;
  const apiUrl = `https://full-bible-api.onrender.com/chapter/${encodeURIComponent(
    version
  )}/${encodeURIComponent(code)}/${chapter}`;

  if (cached) return cached;

  if (signal?.aborted) throw new Error("Fetch aborted");

  try {
    const resp = await safeFetchWithFallbacks(apiUrl, signal);
    const data = await resp.json();

    if (!data || !Array.isArray(data.verses)) {
      throw new Error("Invalid chapter data received.");
    }

    // Format default versions with brackets too
    const verses = data.verses.map((v) => {
      const cleanText = v.text.replace(new RegExp(`^${v.verse}\\s*`), "");

      return {
        verse: v.verse,
        text: `[${v.verse}] ${cleanText}`,
      };
    });

    chapterCache.set(cacheKey, verses);
    return verses;
  } catch (err) {
    if (signal?.aborted) throw err;
    throw err;
  }
}

// Ensure the search drawer is open and sync layout.
// If forceMode is provided, also switch modes.
function openDrawerUI(forceMode) {
  // Open drawer if not already open
  if (!window.searchDrawerOpen) {
    window.searchDrawerOpen = true;
    try {
      window.applyLayout?.(true);
    } catch (err) {
      console.warn("applyLayout failed during openDrawerUI:", err);
    }
  } else {
    // If it's already open, keep layout in sync (no transition)
    try {
      window.applyLayout?.(false);
    } catch (err) {
      console.warn(
        "applyLayout failed during openDrawerUI (no transition):",
        err
      );
    }
  }

  // Optionally force a particular mode
  if (forceMode) {
    try {
      window.setSearchMode?.(forceMode, { openDrawer: false });
    } catch (err) {
      console.warn("setSearchMode failed in openDrawerUI:", err);
    }
  }
}

window.openDrawerUI = openDrawerUI;

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

window.currentSearchMode = window.currentSearchMode || "bible";

/**
 * Unified mode switching for the search drawer.
 *
 * Modes:
 *   - "bible"
 *   - "songs"
 *   - "interlinear"
 *   - "crossref" (or "cross-reference" alias)
 */
function setSearchMode(mode, opts = {}) {
  const normalized =
    mode === "cross-reference" ? "crossref" : !mode ? "bible" : mode;

  const { openDrawer = false, suppressSave = false } = opts;

  window.currentSearchMode = normalized;

  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
  const songsContainer = document.getElementById("search-query-song-container");
  const crossrefContainer = document.getElementById("search-query-crossref");
  const interlinearPanel = document.getElementById("interlinear-panel");
  const searchQueryFullContainer = document.getElementById(
    "search-query-full-container"
  );

  const isBible = normalized === "bible";
  const isInterlinear = normalized === "interlinear";
  const isSongs = normalized === "songs";
  const isCrossref = normalized === "crossref";

  // When Interlinear is active, we hide the regular query container;
  // for everything else, it's visible.
  if (searchQueryFullContainer) {
    searchQueryFullContainer.style.display =
      normalized === "interlinear" ? "none" : "flex";
  }

  if (verseContainer) {
    verseContainer.style.display = normalized === "bible" ? "block" : "none";
  }
  if (songsContainer) {
    songsContainer.style.display = normalized === "songs" ? "block" : "none";
  }
  if (crossrefContainer) {
    crossrefContainer.style.display =
      normalized === "crossref" ? "block" : "none";
  }
  if (interlinearPanel) {
    interlinearPanel.style.display =
      normalized === "interlinear" ? "block" : "none";
  }

  // Keep the Songs header in sync with the Songs mode
  if (songsHeader) {
    songsHeader.style.display = isSongs ? "" : "none";
  }

  // Update the pills
  toggleSearchModeUI(normalized);

  // Optionally open the drawer as part of the mode change
  if (openDrawer) {
    openDrawerUI(normalized);
  } else {
    try {
      window.applyLayout?.(false);
    } catch (err) {
      console.warn("applyLayout failed after setSearchMode:", err);
    }
  }

  // Mode-specific behaviors
  if (normalized === "crossref") {
    // Do NOT force refresh here – we just reuse the last results
    // when the user is only switching pills.
    try {
      updateCrossrefsFromCurrentContext(false);
    } catch (err) {
      console.warn("updateCrossrefsFromCurrentContext failed:", err);
    }
  } else if (normalized === "interlinear") {
    // Let the interlinear helper respond; it will call openDrawerUI itself.
    try {
      if (
        window.BBSearchHeader &&
        typeof window.BBSearchHeader.refresh === "function"
      ) {
        window.BBSearchHeader.refresh();
      }
    } catch (err) {
      console.warn(
        "BBSearchHeader.refresh failed in setSearchMode(interlinear):",
        err
      );
    }
  }

  // Keep header text in sync for all modes
  try {
    if (
      window.BBSearchHeader &&
      typeof window.BBSearchHeader.refresh === "function"
    ) {
      window.BBSearchHeader.refresh();
    }
  } catch (err) {
    console.warn("BBSearchHeader.refresh failed in setSearchMode:", err);
  }

  // Optional: persist mode to local storage if you were doing that before
  if (!suppressSave) {
    try {
      localStorage.setItem("bb-last-search-mode", normalized);
    } catch (_) {}
  }
}

window.setSearchMode = setSearchMode;

function toggleSearchModeUI(activeMode) {
  const normalized = activeMode === "cross-reference" ? "crossref" : activeMode;

  const pillBible = document.getElementById("search-mode-bible");
  const pillSongs = document.getElementById("search-mode-songs");
  const pillInterlinear = document.getElementById("search-mode-interlinear");
  const pillCrossref = document.getElementById("search-mode-cross-reference");

  [pillBible, pillSongs, pillInterlinear, pillCrossref].forEach((pill) => {
    if (pill) pill.classList.remove("active");
  });

  if (normalized === "bible") {
    pillBible?.classList.add("active");
  } else if (normalized === "songs") {
    pillSongs?.classList.add("active");
  } else if (normalized === "interlinear") {
    pillInterlinear?.classList.add("active");
  } else if (normalized === "crossref") {
    pillCrossref?.classList.add("active");
  }
}

window.toggleSearchModeUI = toggleSearchModeUI;

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

// RENDER INTERLINEAR WORDS INSIDE THE VERSE-STUDY MODAL
// Uses the same queue + selection behavior as the search-query container.
function renderVerseStudyInterlinearTokens(tokens, referenceTitle) {
  const container = document.getElementById("interlinear-section-content");
  if (!container) return;

  container.innerHTML = "";

  tokens.forEach((t, index) => {
    const surface = t.surface || "";
    const english =
      t.translation ||
      t.resolved_gloss ||
      t.gloss ||
      t.english ||
      "";
    const translit = t.resolved_translit || t.translit || "";
    const morph = t.morph || "";
    const strong = t.strong || "";

    // --- ROW ---
    const row = document.createElement("div");
    row.className = "interlinear-row";

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

    // --- THE ADD BUTTON (same class as search-query) ---
    const addBtn = document.createElement("div");
    addBtn.className = "search-query-verse-add-button";

    // Data payload that gets added to the queue
    const cardData = {
      type: "interlinear",
      surface,
      english,
      translit,
      morph,
      strong,
      // e.g. "Genesis 1:1 · word 1"
      reference: `${referenceTitle} · word ${index + 1}`,
    };

    // Match how we store keys in toggleInterlinearSelection
    const key = `${cardData.reference}::${surface}`;
    if (window.pendingInterlinearAdds && window.pendingInterlinearAdds.has(key)) {
      row.classList.add("selected-for-add");
      addBtn.classList.add("selected");
    }

    // --- CLICK HANDLERS (same behavior as search) ---
    addBtn.onclick = (e) => {
      e.stopPropagation();
      toggleInterlinearSelection(addBtn, row, cardData);
    };

    row.onclick = () => {
      toggleInterlinearSelection(addBtn, row, cardData);
    };

    // Assemble
    row.appendChild(surfaceEl);
    row.appendChild(englishEl);
    row.appendChild(metaEl);
    row.appendChild(addBtn);

    container.appendChild(row);
  });
}



// Fetch + render interlinear specifically for the verse-study modal
async function openVerseStudyInterlinear(referenceString) {
  // These are the modal-specific elements
  const interSec = document.getElementById("interlinear-section");
  const loader = document.getElementById("interlinear-section-loader");
  const content = document.getElementById("interlinear-section-content");

  if (!interSec || !loader || !content) return;

  // Show only the interlinear section in the modal
  if (typeof resetVerseStudySections === "function") {
    resetVerseStudySections();
  }
  interSec.style.display = "block";
  loader.style.display = "flex";
  content.innerHTML = "";

  // Parse "Genesis 1:1", "Hebrews 1:3", etc.
  let ref = null;

  if (typeof parseFullRef === "function") {
    ref = parseFullRef(referenceString);
  } else if (window.findBibleVerseReference) {
    ref = window.findBibleVerseReference(referenceString);
  }

  if (!ref || !ref.book || !ref.chapter || !ref.verse) {
    loader.style.display = "none";
    content.innerHTML = `<div style="color:var(--muted)">Couldn’t parse "${referenceString}".</div>`;
    return;
  }

  // Map full book name → API code (e.g., "Genesis" → "GEN")
  let bookCode = ref.book;
  if (window.bibleBookCodes && window.bibleBookCodes[ref.book]) {
    bookCode = window.bibleBookCodes[ref.book]; // e.g. GEN, REV, JHN
  }

  const apiUrl = `https://full-bible-api.onrender.com/interlinear/${encodeURIComponent(
    bookCode
  )}/${ref.chapter}/${ref.verse}`;

  try {
    const resp = await fetch(apiUrl, { mode: "cors" });
    if (!resp.ok) throw new Error(`Bad status ${resp.status}`);

    const data = await resp.json();
    const tokens = Array.isArray(data?.tokens)
      ? data.tokens
      : Array.isArray(data)
      ? data
      : [];

    loader.style.display = "none";

    if (!tokens.length) {
      content.innerHTML = `<div style="color:var(--muted)">No interlinear data found for ${referenceString}.</div>`;
      return;
    }

    // Use the same header text we display to the user
    const refTitle = `${ref.book} ${ref.chapter}:${ref.verse}`;
    renderVerseStudyInterlinearTokens(tokens, refTitle);
  } catch (err) {
    console.error("Verse-study interlinear fetch failed:", err);
    loader.style.display = "none";
    content.innerHTML = `<div style="color:red;">Error loading interlinear data.</div>`;
  }
}



// --- NEW: Add global click listener for the floating button ---
floatingAddBtn?.addEventListener("click", function () {
  handleFloatingAddClick();
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

    // FIX: If we actually dragged, ignore the subsequent click event
    if (hasMovedDuringDrag) {
      ignoreNextClick = true;
      // Reset the blocker after a tiny delay (enough to skip the click event)
      setTimeout(() => {
        ignoreNextClick = false;
      }, 50);
    }

    onBoardMutated("item_move_end");
  }
  active = null;
  pendingMouseDrag = null;
  touchDragElement = null;
  hasMovedDuringDrag = false;

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

  syncHandleScaleVar(); // 👈 update CSS var whenever we zoom

  // Set scroll atomically
  viewport.scrollLeft = worldX * scale - vpX;
  viewport.scrollTop = worldY * scale - vpY;

  clampScroll();
  throttledUpdateAllConnections();
  throttledUpdateViewportBars();

  if (typeof updateConnectionLineMenuPosition === "function") {
    updateConnectionLineMenuPosition();
  }

  onBoardMutated("zoom_end");
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
    throttledUpdateAllConnections(); // keeps lines in sync
    throttledUpdateViewportBars();

    // Also keep the line editor menu near the selected line
    if (typeof updateConnectionLineMenuPosition === "function") {
      updateConnectionLineMenuPosition();
    }
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
  if (typeof updateConnectionLineMenuPosition === "function") {
    updateConnectionLineMenuPosition();
  }
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
  if (window.__readOnly) return;

  active = item;
  hasMovedDuringDrag = false; // Reset flag

  bringToFront(item);
  item.style.cursor = "grabbing";

  // Group Drag Init
  isGroupDrag =
    typeof isGroupingMode !== "undefined" &&
    isGroupingMode &&
    typeof selectedGroupItems !== "undefined" &&
    selectedGroupItems.has(item);

  if (isGroupDrag) {
    groupDragOffsets.clear();
    selectedGroupItems.forEach((groupItem) => {
      const rect = groupItem.getBoundingClientRect();
      groupDragOffsets.set(groupItem, {
        offX: (eOrPoint.clientX - rect.left) / scale,
        offY: (eOrPoint.clientY - rect.top) / scale,
      });
    });
  }

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
  hasMovedDuringDrag = true; // Mark that we moved

  const vpRect = viewport.getBoundingClientRect();

  const moveElement = (el, offX, offY) => {
    const relX = clientX - vpRect.left;
    const relY = clientY - vpRect.top;
    const newLeft = (viewport.scrollLeft + relX) / scale - offX;
    const newTop = (viewport.scrollTop + relY) / scale - offY;

    const maxLeft = workspace.offsetWidth - el.offsetWidth;
    const maxTop = workspace.offsetHeight - el.offsetHeight;

    el.style.left = clamp(newLeft, 0, maxLeft) + "px";
    el.style.top = clamp(newTop, 0, maxTop) + "px";
  };

  if (isGroupDrag) {
    selectedGroupItems.forEach((item) => {
      const offsets = groupDragOffsets.get(item);
      if (offsets) moveElement(item, offsets.offX, offsets.offY);
    });
  } else {
    moveElement(active, offsetX, offsetY);
  }

  throttledUpdateAllConnections();
}

function startDragTouch(item, touchPoint, offX, offY) {
  if (window.__readOnly) return;

  touchDragElement = item;
  touchMoved = false;
  isTouchPanning = false;
  bringToFront(item);

  // --- GROUP DRAG INIT (Touch) ---
  isGroupDrag = isGroupingMode && selectedGroupItems.has(item);
  if (isGroupDrag) {
    groupDragOffsets.clear();
    selectedGroupItems.forEach((groupItem) => {
      const rect = groupItem.getBoundingClientRect();
      groupDragOffsets.set(groupItem, {
        offX: (touchPoint.clientX - rect.left) / scale,
        offY: (touchPoint.clientY - rect.top) / scale,
      });
    });
  }
  // -------------------------------

  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    touchDragOffset.x = (touchPoint.clientX - rect.left) / scale;
    touchDragOffset.y = (touchPoint.clientY - rect.top) / scale;
  } else {
    touchDragOffset.x = offX;
    touchDragOffset.y = offY;
  }
}

function dragTouchTo(touchPoint) {
  const vp = viewport.getBoundingClientRect();

  const moveElement = (el, offX, offY) => {
    const x =
      (viewport.scrollLeft + (touchPoint.clientX - vp.left)) / scale - offX;
    const y =
      (viewport.scrollTop + (touchPoint.clientY - vp.top)) / scale - offY;
    const maxLeft = workspace.offsetWidth - el.offsetWidth;
    const maxTop = workspace.offsetHeight - el.offsetHeight;
    el.style.left = `${clamp(x, 0, maxLeft)}px`;
    el.style.top = `${clamp(y, 0, maxTop)}px`;
  };

  if (isGroupDrag) {
    selectedGroupItems.forEach((item) => {
      const offsets = groupDragOffsets.get(item);
      if (offsets) moveElement(item, offsets.offX, offsets.offY);
    });
  } else {
    moveElement(touchDragElement, touchDragOffset.x, touchDragOffset.y);
  }

  throttledUpdateAllConnections();
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
  const { path, hitPath, itemA, itemB, handle } = conn;
  if (!path || !itemA || !itemB) return;

  const vpRect = viewport.getBoundingClientRect();
  const r1 = itemA.getBoundingClientRect();
  const r2 = itemB.getBoundingClientRect();

  if ((!r1.width && !r1.height) || (!r2.width && !r2.height)) return;

  const p1 = {
    x: (viewport.scrollLeft + (r1.left - vpRect.left) + r1.width / 2) / scale,
    y: (viewport.scrollTop + (r1.top - vpRect.top) + r1.height / 2) / scale,
  };

  const p2 = {
    x: (viewport.scrollLeft + (r2.left - vpRect.left) + r2.width / 2) / scale,
    y: (viewport.scrollTop + (r2.top - vpRect.top) + r2.height / 2) / scale,
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
  if (hitPath) {
    hitPath.setAttribute("d", d);
  }

  // Keep handle at midpoint of current path
  if (handle) {
    try {
      const length = path.getTotalLength();
      if (length > 0 && Number.isFinite(length)) {
        const mid = path.getPointAtLength(length / 2);
        if (mid && Number.isFinite(mid.x) && Number.isFinite(mid.y)) {
          handle.setAttribute("transform", `translate(${mid.x}, ${mid.y})`);
        }
      }
    } catch {
      // don't break drawing if geometry not ready
    }
  }
}

function updateAllConnections() {
  connections.forEach((c) => updateConnection(c));
  // After all paths have been repositioned, keep the menu glued to the line
  if (typeof updateConnectionLineMenuPosition === "function") {
    updateConnectionLineMenuPosition();
  }
}


// --- Connection drag / ghost line + snap-to-nearest-item (DEBUG) ---
const SNAP_RADIUS = 200; // px distance in screen space

// === Drag-to-connect from handles / cards (Miro-style) ===
let connectionDraftPath = null;

function startConnectionDrag(e, sourceEl) {
  if (window.__readOnly) return;
  if (!sourceEl || !connectionsSvg || !viewport) {
    console.warn("[BB-CONN] abort startConnectionDrag, missing deps", {
      hasSource: !!sourceEl,
      hasSvg: !!connectionsSvg,
      hasViewport: !!viewport,
    });
    return;
  }

  const SNAP_RADIUS = 200; // px on the board

  const isTouch = e.type === "touchstart";
  const startPoint = isTouch && e.touches ? e.touches[0] : e;

  e.preventDefault();
  e.stopPropagation();

  const viewportRect = viewport.getBoundingClientRect();

  // center of a board item in *board* coords
  function getElementCenter(el) {
    const r = el.getBoundingClientRect();
    const cx =
      (viewport.scrollLeft + (r.left - viewportRect.left) + r.width / 2) /
      scale;
    const cy =
      (viewport.scrollTop + (r.top - viewportRect.top) + r.height / 2) / scale;
    return { x: cx, y: cy };
  }

  // client (screen) coords -> board coords (same math as connections)
  function clientToBoard(clientX, clientY) {
    return {
      x: (viewport.scrollLeft + (clientX - viewportRect.left)) / scale,
      y: (viewport.scrollTop + (clientY - viewportRect.top)) / scale,
    };
  }

  const src = getElementCenter(sourceEl);

  // Create the ghost dashed path if it doesn't exist yet
  if (!connectionDraftPath) {
    connectionDraftPath = document.createElementNS(SVG_NS, "path");
    connectionDraftPath.classList.add("connection-line", "connection-draft");
    connectionsSvg.appendChild(connectionDraftPath);

    // Match the current connection color + dashed style
    try {
      if (
        window.BoardAPI &&
        typeof window.BoardAPI.getConnectionColor === "function"
      ) {
        const color = window.BoardAPI.getConnectionColor();
        if (color) {
          connectionDraftPath.style.stroke = color;
        }
      }
    } catch (err) {
      console.warn("[BB-CONN] could not read connection color for draft", err);
    }

    // Make it obviously "ghost"
    connectionDraftPath.style.strokeDasharray = "8 6";
    connectionDraftPath.style.opacity = "0.85";
  }

  function updateDraft(clientX, clientY) {
    const dst = clientToBoard(clientX, clientY);

    const p1 = src; // source element center (already in board coords)
    const p2 = dst; // current mouse position in board coords

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    let d;

    if (absDx < 40 || absDy < 40) {
      // Short distance → straight line (same rule as updateConnection)
      d = `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
    } else {
      // Same smooth curve logic as real connections
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

    connectionDraftPath.setAttribute("d", d);

    if (DEBUG_CONNECTIONS) {
      console.log("[BB-CONN] updateDraft", { src: p1, dst: p2, d });
    }
  }

  // Initial position for the ghost line
  updateDraft(startPoint.clientX, startPoint.clientY);

  function onMove(ev) {
    const pt = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    updateDraft(pt.clientX, pt.clientY);
  }

  function cleanupDraft() {
    if (
      connectionDraftPath &&
      connectionDraftPath.parentNode === connectionsSvg
    ) {
      connectionsSvg.removeChild(connectionDraftPath);
    }
    connectionDraftPath = null;
  }

  function onUp(ev) {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onUp);

    const endEvent =
      ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0] : ev;
    const endPos = clientToBoard(endEvent.clientX, endEvent.clientY);

    // remove the ghost line from the SVG
    cleanupDraft();

    // === SNAP-TO-NEAREST BOARD ITEM ===
    let closestEl = null;
    let closestDist = SNAP_RADIUS;

    document.querySelectorAll(".board-item").forEach((candidate) => {
      if (candidate === sourceEl) return;
      if (!candidate.offsetParent) return; // skip hidden

      const cCenter = getElementCenter(candidate);
      const dx = cCenter.x - endPos.x;
      const dy = cCenter.y - endPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < closestDist) {
        closestDist = dist;
        closestEl = candidate;
      }
    });

    if (
      closestEl &&
      window.BoardAPI &&
      typeof window.BoardAPI.connectItems === "function"
    ) {
      window.BoardAPI.connectItems(sourceEl, closestEl);

      // refresh all connections
      if (typeof window.throttledUpdateAllConnections === "function") {
        window.throttledUpdateAllConnections();
      } else if (typeof window.updateAllConnections === "function") {
        window.updateAllConnections();
      }
    }
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("touchmove", onMove, { passive: false });
  document.addEventListener("touchend", onUp);
}

// expose it for the handles / interlinear cards to use
window.startConnectionDrag = startConnectionDrag;
window.BoardAPI = window.BoardAPI || {};
window.BoardAPI.startConnectionDrag = startConnectionDrag;

/**
 * Create a new connection: center-to-center curve
 * + hidden X-handle that becomes visible only in disconnect mode.
 */
function connectItems(a, b) {
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;
  if (!a || !b || a === b || connectionExists(a, b)) return;

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Visible line
  const path = document.createElementNS(SVG_NS, "path");
  path.classList.add("connection-line");
  // Let CSS control pointer-events; clicks will go to the hit path.
  // path.style.pointerEvents = "stroke";

  // Invisible hitbox line (fatter, transparent)
  const hitPath = document.createElementNS(SVG_NS, "path");
  hitPath.classList.add("connection-line-hit");

  // Append hitPath first so the visible stroke is on top
  svg.appendChild(hitPath);
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

  const conn = { path, hitPath, itemA: a, itemB: b, handle: handleGroup };
  connections.push(conn);

  updateConnection(conn);
  onBoardMutated("connect_items");
}


/**
 * Remove a single connection by its path element.
 */
function disconnectLine(path) {
  if (window.__readOnly) return;

  let idx = connections.findIndex(
    (c) => c.path === path || c.hitPath === path
  );
  if (idx === -1) return;

  const conn = connections[idx];

  if (conn.handle) {
    try {
      svg.removeChild(conn.handle);
    } catch (_e) {}
  }

  if (conn.hitPath) {
    try {
      svg.removeChild(conn.hitPath);
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
      if (c.hitPath) {
        try {
          svg.removeChild(c.hitPath);
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

/**
 * Formats raw verse text for DISPLAY (HTML).
 * Converts "[1]" -> "<span class='verse-num'>1</span>"
 */
function formatVerseContent(text) {
  if (!text) return "";
  // Replaces [1], [1-3], or [1:1] with styled HTML span.
  return text.replace(
    /\[(\d+(?:[-:a-z]\d+)*)\]/g,
    '<span class="verse-num">$1</span> '
  );
}

/**
 * Helper to remove [N] from the start of text for clean display lists.
 * Example: "[1] In the beginning" -> "In the beginning"
 */
function cleanDisplayVerse(text) {
  if (!text) return "";
  return text.replace(/^\[\d+\]\s*/, "");
}

/**
 * HEALS raw text for STORAGE.
 * Ensures EVERY verse number in the text is wrapped in brackets [ ]
 * so it saves correctly to Supabase.
 */
function sanitizeVerseText(text) {
  if (!text) return "";
  let clean = text;

  // 1. Fix Start of Line: "1 In..." -> "[1] In..."
  clean = clean.replace(/^(\d+)(?=\s)/, "[$1]");

  // 2. Fix Middle of Line (Multi-verse):
  //    Matches punctuation OR commas OR quotes, followed by space, digit, space.
  //    "John, 2 who" -> "John, [2] who"
  //    "said. 3 Then" -> "said. [3] Then"
  //    "him: 4 The"   -> "him: [4] The"
  clean = clean.replace(/([.,;?!:”—"’']\s+)(\d+)(?=\s)/g, "$1[$2]");

  // 3. Cleanup: Fix double brackets if they happened (e.g. [[1]])
  clean = clean.replace(/\[\[(\d+)\]\]/g, "[$1]");

  return clean;
}
// ==================== Element Creation ====================
function addBibleVerse(
  reference,
  text,
  createdFromLoad = false,
  version = null,
  delay = 0
) {
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "bible-verse");

  if (delay != 0) {
    el.style.opacity = "0";
    el.style.animation = "loadItemToBoard 1s forwards " + delay + "s";
  }
  el.style.position = "absolute";

  // Heal text
  const robustText = sanitizeVerseText(text);

  el.dataset.type = "verse";
  el.dataset.reference = reference;
  el.dataset.text = robustText;
  if (version) el.dataset.version = version;

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale,
    visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale,
    visibleH = vpRect.height / scale;
  const randX = visibleX + 0.5 * (visibleW - 300);
  const randY = visibleY + 0.5 * (visibleH - 200);
  el.style.left = `${randX + delay * 200}px`;
  el.style.top = `${randY + delay * 200}px`;

  // FIX: Z-Index handling
  if (createdFromLoad) {
    // During load, just increment blindly (sync happens at end of load)
    currentIndex++;
    el.style.zIndex = currentIndex;
  } else {
    // User action: force to front
    bringToFront(el);
  }

  const displayReference = createdFromLoad ? reference : `- ${reference}`;
  const versionLabel = version ? ` ${version.toUpperCase()}` : "";
  const htmlContent = formatVerseContent(robustText);

  el.innerHTML = `
    <div id="bible-text-content">
      <div class="verse-text">VERSE</div>
      <div class="verse-text-content">${htmlContent}</div>
      <div class="verse-text-reference">${displayReference}${versionLabel}</div>
    </div>
  `;

  attachSelectionFrame(el);

  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  el.onmousedown = (e) => {
    if (isConnectMode || e.target.closest('[contenteditable="true"]')) return;
    startDragMouse(el, e);
  };

  if (!createdFromLoad) {
    onBoardMutated("add_verse");
  } else if (robustText !== text) {
    onBoardMutated("heal_legacy_verse");
  }

  return el;
}

// === Attach Miro-style selection frame + connection handles to a board item (DEBUG) ===
const DEBUG_CONNECTIONS = false;

function attachSelectionFrame(el) {
  if (!el || el.querySelector(".item-selection-frame")) return;

  const frame = document.createElement("div");
  frame.className = "item-selection-frame";

  const positions = ["top", "right", "bottom", "left"];

  positions.forEach((pos) => {
    const handle = document.createElement("div");
    handle.className = `item-connector-handle handle-${pos}`;

    const inner = document.createElement("div");
    inner.className = "item-connector-dot";
    handle.appendChild(inner);

    const startDrag = (ev) => {
      // only left mouse button for mouse; touches are fine
      if (ev.button !== undefined && ev.button !== 0) return;

      // ✅ Require the item to be selected first
      const isSelected =
        el.classList.contains("selected") ||
        el.classList.contains("selected-connection");

      if (!isSelected) {
        // optional debug
        // console.log("[BB-CONN] ignoring drag: item not selected", el);
        return;
      }

      ev.preventDefault();
      ev.stopPropagation();

      if (typeof window.startConnectionDrag === "function") {
        window.startConnectionDrag(ev, el);
      } else if (
        window.BoardAPI &&
        typeof window.BoardAPI.startConnectionDrag === "function"
      ) {
        window.BoardAPI.startConnectionDrag(ev, el);
      }
    };

    handle.addEventListener("mousedown", startDrag);
    handle.addEventListener("touchstart", startDrag, { passive: false });

    frame.appendChild(handle);
  });

  if (!el.style.position) {
    el.style.position = "absolute";
  }
  el.appendChild(frame);
}



// ==================== Note Modal Logic ====================
const noteModal = document.getElementById("note-modal-backdrop");
const noteInput = document.getElementById("note-modal-input");
const noteSaveBtn = document.getElementById("note-modal-save-btn");
const noteCancelBtn = document.getElementById("note-modal-cancel-btn");

let currentEditingNote = null;

function openNoteModal(noteEl = null) {
  if (window.__readOnly) return;

  currentEditingNote = noteEl;

  if (noteEl) {
    // Edit Mode
    const contentEl = noteEl.querySelector(".text-content");
    // Use innerHTML to preserve line breaks if any, or textContent if simple
    // Replacing <br> with newlines for textarea
    let text = contentEl.innerHTML.replace(/<br\s*\/?>/gi, "\n");
    // Decode HTML entities if needed, but value usually handles it
    const temp = document.createElement("div");
    temp.innerHTML = text;
    noteInput.value = temp.textContent || temp.innerText || "";
  } else {
    // Add Mode
    noteInput.value = "";
  }

  noteModal.classList.remove("hidden");
  setTimeout(() => noteInput.focus(), 50); // Focus after render
}

function closeNoteModal() {
  noteModal.classList.add("hidden");
  currentEditingNote = null;
}

function saveNoteFromModal() {
  const text = noteInput.value.trim(); // Allow empty?

  // Convert newlines to <br> for HTML display
  const htmlContent = text.replace(/\n/g, "<br>");

  if (currentEditingNote) {
    // Update Existing
    const contentEl = currentEditingNote.querySelector(".text-content");
    contentEl.innerHTML = htmlContent || "Empty note";
    onBoardMutated("edit_note_text");
  } else {
    // Create New
    if (text) {
      addTextNote(htmlContent);
    }
  }
  closeNoteModal();
}

// Wire up Modal Buttons
if (noteSaveBtn) {
  noteSaveBtn.addEventListener("click", saveNoteFromModal);
}
if (noteCancelBtn) {
  noteCancelBtn.addEventListener("click", closeNoteModal);
}
// Close on backdrop click
if (noteModal) {
  noteModal.addEventListener("click", (e) => {
    if (e.target === noteModal) closeNoteModal();
  });
}

// Update Main Action Button
if (textBtn) {
  // We need to replace the old clone to strip previous listeners if possible,
  // or just ensure this one runs and we preventDefault.
  // Since we can't easily remove anonymous listeners, ensuring this logic
  // supersedes or we modify the original function is key.
  // For now, I will attach a new listener and rely on the fact that
  // calling openNoteModal is the new desired behavior.

  // To be clean, let's recreate the button to strip old listeners
  const newTextBtn = textBtn.cloneNode(true);
  textBtn.parentNode.replaceChild(newTextBtn, textBtn);

  newTextBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openNoteModal(null); // Open empty for new note
  });
}

// Updated addTextNote (Removed color, fixed Z-Index)
function addTextNote(initial = "New note") {
  currentIndex += 1;
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "text-note");
  el.dataset.type = "note";
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

  // UPDATED HTML: Includes the hidden .edit-btn
  el.innerHTML = `
    <div class="note-content">
      <div class="verse-text note-label">NOTE</div>
      <div class="text-content">${initial}</div>
    </div>
    <button class="edit-btn" aria-label="Edit Note" title="Edit Text">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="24px" fill="currentColor">
        <path d="M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z"/>
      </svg>
    </button>
  `;

  attachSelectionFrame(el);

  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  // --- Logic ---

  // 1. Edit Button Logic: Opens the modal
  const editBtn = el.querySelector(".edit-btn");
  if (editBtn) {
    const openEdit = (e) => {
      e.preventDefault();
      e.stopPropagation(); // Don't bubble to board (prevents deselect/drag)
      openNoteModal(el);
    };
    // Use mousedown/touchstart to catch it before drag logic fires
    editBtn.addEventListener("mousedown", openEdit);
    editBtn.addEventListener("touchstart", openEdit, { passive: false });
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // 2. Drag/Select Logic
  // (Clicking the card body will bubble to workspace, triggering 'selectItem')
  let startX = 0,
    startY = 0;

  el.onmousedown = (e) => {
    if (e.target.closest(".edit-btn")) return; // Ignore edits
    if (isConnectMode) return;

    startX = e.clientX;
    startY = e.clientY;
    startDragMouse(el, e);
  };

  el.ontouchstart = (e) => {
    if (e.target.closest(".edit-btn")) return;
    if (isConnectMode || window.__readOnly || e.touches.length !== 1) return;
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

  el.ontouchend = () => {
    if (touchDragElement) onBoardMutated("item_move_touch_end");
    touchDragElement = null;
    pendingTouchDrag = null;
    setTimeout(() => {
      touchMoved = false;
    }, 0);
  };

  onBoardMutated("add_note");
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
    const selectedClass = isSelected ? "selected-for-add" : "";
    const btnSelectedClass = isSelected ? "selected" : "";

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
 * Fetches verse texts for a batch of cards.
 * - success  -> fills text + marks data-status="ready"
 * - invalid/error -> removes the card completely
 */
async function fillVerseBatch(verseBatch, signal, version) {
  const promises = verseBatch.map(async ({ ref, el }) => {
    if (!el) return;
    if (signal?.aborted) return;
    if (el.dataset.status === "ready") return;

    // Helper: mark as error + remove the card from the DOM
    const removeCard = () => {
      el.dataset.status = "error";
      const parent = el.parentElement;
      el.remove();

      // Optional: if this was the last card in the main list you could
      // show a "No verses found" message here if you want.
      // if (parent && !parent.querySelector(".search-query-verse-container")) {
      //   parent.innerHTML = `<div class="search-query-no-verse-found-container"
      //      style="text-align:center; color:var(--muted); padding: 15px;">
      //      No matching verses found.</div>`;
      // }
    };

    const parts = parseReferenceToParts(ref);
    if (!parts) {
      removeCard();
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

      // Anything that looks like an error – just drop the card
      if (!text || /not\s*found|unavailable|error/i.test(String(text))) {
        removeCard();
        return;
      }

      // ✅ Success: fill in the card
      el.dataset.status = "ready";
      el.dataset.ref = ref;
      el.dataset.version = version;
      el.dataset.text = text;

      const textEl = el.querySelector(".search-query-verse-text");
      if (textEl) {
        textEl.textContent = cleanDisplayVerse(text);
        textEl.style.color = "";
        textEl.style.textAlign = "";
      }

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
        removeCard(); // on network/other error, also hide
      }
    }
  });

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
 * UPDATED: Creates a final, ready-to-add verse card element with clean text.
 */
function buildSongCard(song) {
  const title = song.title || song.trackName || song.name || "";
  const artist = song.artist || song.artistName || song.author || "";
  const lyrics = song.lyrics || "";
  const cover = song.cover || song.artworkUrl100 || song.image || "";

  const row = document.createElement("div");
  row.className = "search-query-verse-container verse song-row";

  // Data attributes for recreation
  row.dataset.title = title;
  row.dataset.artist = artist;
  row.dataset.lyrics = lyrics;
  row.dataset.cover = cover;

  // --- FIX: Check Global Queue for Initial State ---
  // Note: Song keys are tricky if you don't have a unique ID. We use Title+Artist.
  // The unified flush logic relies on `pendingSongAdds`.
  const key = `song::${(title || "").trim()}::${(artist || "").trim()}`;
  const isSelected = window.pendingSongAdds && window.pendingSongAdds.has(key);

  if (isSelected) {
    row.classList.add("selected-for-add");
  }

  const img = document.createElement("img");
  img.className = "song-cover";
  img.alt = title ? `Cover art for ${title}` : "Cover art";
  if (cover) img.src = cover;

  const textWrap = document.createElement("div");
  textWrap.className = "song-meta";

  const titleEl = document.createElement("div");
  titleEl.className = "song-title";
  titleEl.textContent = title || "Untitled";

  const artistEl = document.createElement("div");
  artistEl.className = "song-artist";
  artistEl.textContent = artist || "Unknown";

  textWrap.appendChild(titleEl);
  textWrap.appendChild(artistEl);

  const addBtn = document.createElement("button");
  addBtn.className = "search-query-verse-add-button";
  addBtn.setAttribute("aria-label", `Add song ${title} by ${artist}`);

  if (isSelected) {
    addBtn.classList.add("selected");
  }

  // Toggle Logic
  function toggle() {
    if (!window.pendingSongAdds) window.pendingSongAdds = new Map();

    if (window.pendingSongAdds.has(key)) {
      window.pendingSongAdds.delete(key);
      row.classList.remove("selected-for-add");
      addBtn.classList.remove("selected");
    } else {
      window.pendingSongAdds.set(key, { title, artist, lyrics, cover });
      row.classList.add("selected-for-add");
      addBtn.classList.add("selected");
    }
    if (typeof updateFloatingAddButton === "function")
      updateFloatingAddButton();
  }

  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });
  row.addEventListener("click", (e) => {
    if (e.target && e.target.closest(".search-query-verse-add-button")) return;
    toggle();
  });

  row.appendChild(img);
  row.appendChild(textWrap);
  row.appendChild(addBtn);

  return row;
}

/**
 * Creates a final, ready-to-add song card element.
 * Uses existing classes from style.css to maintain visuals.
 * @param {object} song - A song object from fetchSongs (e.g., { trackName, artistName, artworkUrl100 })
 * @returns {HTMLElement}
 */

function buildSongCard(song) {
  // Normalize song fields
  const title = song.title || song.trackName || song.name || "";
  const artist = song.artist || song.artistName || song.author || "";
  const lyrics = song.lyrics || "";
  const cover = song.cover || song.artworkUrl100 || song.image || "";

  // Container: flex row (image | text | + button)
  const row = document.createElement("div");
  row.className = "search-query-verse-container verse song-row";
  row.dataset.title = title;
  row.dataset.artist = artist;
  row.dataset.lyrics = lyrics;
  row.dataset.cover = cover;

  // Image (left)
  const img = document.createElement("img");
  img.className = "song-cover";
  img.alt = title ? `Cover art for ${title}` : "Cover art";
  if (cover) img.src = cover;

  // Text container (middle)
  const textWrap = document.createElement("div");
  textWrap.className = "song-meta";

  const titleEl = document.createElement("div");
  titleEl.className = "song-title";
  titleEl.textContent = title || "Untitled";

  const artistEl = document.createElement("div");
  artistEl.className = "song-artist";
  artistEl.textContent = artist || "Unknown";

  textWrap.appendChild(titleEl);
  textWrap.appendChild(artistEl);

  // + button (right) — reuse verse add button class
  const addBtn = document.createElement("button");
  addBtn.className = "search-query-verse-add-button";
  addBtn.setAttribute("aria-label", `Add song ${title} by ${artist}`);

  function toggle() {
    if (!window.pendingSongAdds) window.pendingSongAdds = new Map();
    const key = `song::${(title || "").trim()}::${(artist || "").trim()}`;
    if (window.pendingSongAdds.has(key)) {
      window.pendingSongAdds.delete(key);
      row.classList.remove("selected-for-add");
      addBtn.classList.remove("selected");
    } else {
      window.pendingSongAdds.set(key, { title, artist, lyrics, cover });
      row.classList.add("selected-for-add");
      addBtn.classList.add("selected");
    }
    if (typeof window.updateFloatingAddButton === "function")
      window.updateFloatingAddButton();
  }

  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });
  row.addEventListener("click", (e) => {
    if (e.target && e.target.closest(".search-query-verse-add-button")) return;
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
      const refShaped = window.isReferenceShaped
        ? window.isReferenceShaped(query)
        : false;

      // --- 1. ALWAYS prefetch songs ---
      fetchSongs(query, SEARCH_RESULT_LIMIT, signal).catch(() => {});
      console.log(`[Prefetch] Warmed songs cache for "${query}"`);

      // --- 2. Prefetch correct Bible data ---
      if (refShaped) {
        // It looks like a reference, try to parse it
        const bibleRef = window.findBibleVerseReference
          ? window.findBibleVerseReference(query)
          : null;
        if (bibleRef && bibleRef.book && bibleRef.chapter) {
          // Prefetch the full chapter (e.g., "John 3:16" or "Josua 1:9" -> "Joshua 1:9")
          fetchChapterText(
            bibleRef.book,
            bibleRef.chapter,
            signal,
            version
          ).catch(() => {});
          console.log(
            `[Prefetch] Warmed chapter cache for ${bibleRef.book} ${bibleRef.chapter}`
          );
        } else {
          // It's reference-shaped but didn't parse (e.g., "Asdf 1:1" or "Josua 1:9" -> didYouMean)
          // We can't prefetch a chapter, so just prefetch text search as a fallback.
          fetchBibleSearchResults(
            query,
            SEARCH_RESULT_LIMIT,
            signal,
            version
          ).catch(() => {});
          console.log(
            `[Prefetch] Warmed bible text search for "${query}" (ref-shaped fallback)`
          );
        }
      } else {
        // NOT reference-shaped (e.g., "love")
        // Prefetch the text search results
        fetchBibleSearchResults(
          query,
          SEARCH_RESULT_LIMIT,
          signal,
          version
        ).catch(() => {});
        console.log(
          `[Prefetch] Warmed bible text search for "${query}" (text query)`
        );
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
  const readySongs = (songs || []).filter(
    (s) => s && s.trackName && s.artistName
  );
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
      const safeMessage = err.message
        ? escapeHtml(err.message)
        : `No songs found for "${safeQuery}".`;
      songsContainer.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">${safeMessage}</div>`;
    }
  }
}

function safeGetSelectedVersion() {
  try {
    if (typeof window.getSelectedBibleVersion === "function") {
      return window.getSelectedBibleVersion();
    }
    if (typeof window.getSelectedVersion === "function") {
      return window.getSelectedVersion();
    }
  } catch (e) {
    console.warn("getSelectedVersion error:", e);
  }
  return "ESV";
}

/**
 * MODIFIED: Now accepts an options object to run as a background task.
 * Runs the full Bible REFERENCE (chapter) search logic.
 * THROWS on failure (e.g., "John 99" not found).
 */
async function runBibleSearch(bibleRef, signal, version, options = {}) {
  // Added options
  const { isBackground = false } = options; // Destructure
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
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
    if (searchQuery)
      searchQuery.textContent = `Search for "${searchBar.value}"`;
    if (didYouMeanText) didYouMeanText.style.display = "none"; // Always hide suggestion on success
  }
  // --- END MODIFICATION ---

  // This will throw if fetch fails (e.g., John 99)
  const verses = await fetchChapterText(
    result.book,
    result.chapter,
    signal,
    version
  );

  if (!verses || verses.length === 0) {
    // This will also be caught and trigger song fallback
    throw new Error(`No verses found for ${refString}.`);
  }

  if (signal.aborted) throw new Error("Search aborted");

  if (!isBackground) {
    // Log perf only for primary task
    logPerf("chapter_data_received");
  }

  // 3. Render chapter (This is safe, it just populates the hidden container)
  renderChapter(
    verseContainer,
    verses,
    result.verse,
    refString,
    result.book,
    version
  );

  // 4. Scroll to verse
  if (result.verse && !isBackground) {
    // Only scroll if primary
    scrollToVerse(result.verse);
  }

  return true; // Success
}

/**
 * NEW: Runs a full-text search for Bible verses.
 * Renders results as verse cards and falls back to songs on 0 results (if primary).
 */
async function runBibleTextSearch(query, signal, version, options = {}) {
  // Added options
  const { isBackground = false } = options; // Destructure
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
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
    const refs = await fetchBibleSearchResults(
      query,
      SEARCH_RESULT_LIMIT,
      signal,
      version
    );
    if (signal.aborted) return;

    if (!isBackground) {
      // Log perf only for primary task
      logPerf("bible_text_search_refs_received");
    }

    // 2. Check for "no match"
    if (!refs || refs.length === 0) {
      // --- MODIFICATION (Restored) ---
      if (!isBackground) {
        // Only run song fallback if this was the *primary* task
        console.warn(
          `Bible text search for "${query}" found 0 results. Falling back to songs.`
        );
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

    if (!isBackground) {
      // Log perf only for primary task
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
      const safeMessage = err.message
        ? escapeHtml(err.message)
        : `No results found for "${safeQuery}".`;

      verseContainer.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">${safeMessage}</div>`;
    }
    // --- END MODIFICATION ---
  }
}

/**
 * OPTIMIZATION: Use LRU cache
 * MODIFIED: Now includes the Bible 'version' in the API call and cache key.
 */
async function fetchBibleSearchResults(
  query,
  limit = 5,
  signal,
  version = "KJV"
) {
  // ADDED version
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
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );
  const songsContainer = document.getElementById("search-query-song-container");
  if (verseContainer) verseContainer.innerHTML = "";
  if (songsContainer) songsContainer.innerHTML = "";

  // This will be the *active* mode shown to the user
  setSearchMode(currentSearchMode);
  logPerf("skeleton_rendered");

  // --- 3. Determine Search Paths ---
  try {
    // 1. Decide if it's reference-shaped
    const refShaped = window.isReferenceShaped
      ? window.isReferenceShaped(rawQuery)
      : false;

    // 2. Only attempt to parse a Bible reference if it's reference-shaped
    const bibleRefInfo =
      refShaped && window.findBibleVerseReference
        ? window.findBibleVerseReference(rawQuery)
        : null;

    const isClearBibleRef =
      bibleRefInfo && bibleRefInfo.book && bibleRefInfo.chapter;
    const isDidYouMean =
      refShaped && bibleRefInfo && bibleRefInfo.didYouMean && !isClearBibleRef;

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
      runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(
        () => {}
      );

      // 2. Background Bible
      if (isClearBibleRef) {
        runBibleSearch(bibleRefInfo, signal, version, {
          isBackground: true,
        }).catch(() => {});
      } else {
        // If it's not reference-shaped or just a fuzzy match, run text search
        runBibleTextSearch(rawQuery, signal, version, {
          isBackground: true,
        }).catch(() => {});
      }
    }

    // --- CASE: BIBLE MODE ---
    else if (currentSearchMode === "bible") {
      if (isClearBibleRef) {
        primarySearchPromise = runBibleSearch(bibleRefInfo, signal, version, {
          isBackground: false,
        });
        // Background: Songs
        runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(
          () => {}
        );
      } else if (isDidYouMean) {
        showDidYouMeanSuggestion(bibleRefInfo);
        primarySearchPromise = Promise.resolve();
        // Background: Songs
        runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(
          () => {}
        );
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
        primarySearchPromise = runBibleTextSearch(rawQuery, signal, version, {
          isBackground: false,
        });
        // Background: Songs
        runSongsSearch(rawQuery, signal, version, { isBackground: true }).catch(
          () => {}
        );
      }
    }

    // --- CASE: CROSS REF MODE ---
    else if (window.currentSearchMode === "crossref") {
      event.preventDefault();

      try {
        // Ensure drawer + mode are correct
        setSearchMode("crossref", { openDrawer: true });

        // 1) Cross references (primary for this mode) – force refetch for new query
        if (typeof updateCrossrefsFromCurrentContext === "function") {
          updateCrossrefsFromCurrentContext(true);
        }

        // 2) Background Songs search (so Songs tab is warm)
        try {
          runSongsSearch(rawQuery, signal, version, {
            isBackground: true,
          }).catch(() => {});
        } catch (_) {}

        // 3) Background Bible search (chapter/verses or text, just like Bible mode)
        try {
          if (isClearBibleRef) {
            runBibleSearch(bibleRefInfo, signal, version, {
              isBackground: true,
            }).catch(() => {});
          } else {
            runBibleTextSearch(rawQuery, signal, version, {
              isBackground: true,
            }).catch(() => {});
          }
        } catch (_) {}

        // 4) Optional: warm Interlinear panel if the query looks like a verse.
        // This populates the panel but does NOT change the mode.
        try {
          if (
            refShaped &&
            typeof populateInterlinearFromCurrentQuery === "function"
          ) {
            populateInterlinearFromCurrentQuery();
          }
        } catch (_) {}
      } catch (err) {
        console.error("Crossref search failed:", err);
      }

      // We fully handled the submit
      return false;
    }

    // --- CASE: SONGS MODE ---
    else {
      primarySearchPromise = runSongsSearch(rawQuery, signal, version, {
        isBackground: false,
      });

      // Background Bible Search
      if (isClearBibleRef) {
        runBibleSearch(bibleRefInfo, signal, version, {
          isBackground: true,
        }).catch(() => {});
      } else if (isDidYouMean) {
        showDidYouMeanSuggestion(bibleRefInfo);
      } else if (!refShaped) {
        runBibleTextSearch(rawQuery, signal, version, {
          isBackground: true,
        }).catch(() => {});
      }
    }

    // --- 5. Wait for the Primary task to complete ---
    if (primarySearchPromise) {
      await primarySearchPromise;
    }
  } catch (err) {
    if (!signal.aborted) {
      // console.error("Error in searchForQuery:", err);
      const container =
        currentSearchMode === "bible" ? verseContainer : songsContainer;
      if (container && currentSearchMode !== "interlinear") {
        const safeQuery = escapeHtml(rawQuery);
        const safeMessage = err.message
          ? escapeHtml(err.message)
          : `No results found for "${safeQuery}".`;
        container.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">${safeMessage}</div>`;
      }
    }
  } finally {
    // Hide main loader (unless we are in interlinear, which handles its own)
    if (loader && currentSearchMode !== "interlinear") {
      loader.style.display = "none";
    }
    if (searchQueryFullContainer && currentSearchMode !== "interlinear") {
      searchQueryFullContainer.style.display = "flex";
    }
  }

  return false; // prevent default navigation
}

// ... (closeSearchQuery unchanged) ...
function closeSearchQuery() {
  searchDrawerOpen = false;

  // 🔹 Close the Bible Query reader with the same fade/slide animation
  const bibleReader = document.getElementById("bible-query-reader");
  const bibleReaderHeader = document.getElementById("bible-query-reader-header");
  const bibleReaderContent = document.getElementById("bible-query-reader-content");

  if (bibleReader) {
    // Animate out
    bibleReader.style.opacity = "0";
    bibleReader.style.top = "12px";

    // After the animation, hide and clear content
    setTimeout(() => {
      bibleReader.style.display = "none";
      if (bibleReaderHeader) bibleReaderHeader.innerHTML = "";
      if (bibleReaderContent) bibleReaderContent.innerHTML = "";
    }, 250);
  }

  // Reset crossref mode back to bible so reopening works
  // if (window.currentSearchMode === "crossref") {
  //   window.setSearchMode("bible", { openDrawer: false, suppressSave: true });
  // }

  applyLayout(true);
  if (searchBar) {
    searchQuery.textContent = `Search for "${searchBar.value}"`;
  }

  if (globalSearchController) {
    globalSearchController.abort();
    globalSearchController = null;
  }
  if (typeAheadController) {
    typeAheadController.abort();
    typeAheadController = null;
  }
  if (activeBibleSearchController) {
    activeBibleSearchController.abort();
    activeBibleSearchController = null;
  }
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
  setTheme(body.classList.contains("light"));
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
  // initial
  syncHandleScaleVar();
  
  if (!el) return;
  if (selectedItem && selectedItem !== el) {
    selectedItem.classList.remove("selected-connection");
  }
  selectedItem = el;
  el.classList.add("selected-connection");

  // FIX: Ensure selection brings item to front
  bringToFront(el);

  updateActionButtonsEnabled();
}

function clearSelection() {
  if (selectedItem) selectedItem.classList.remove("selected-connection");
  selectedItem = null;
  setConnectMode(false);
  updateActionButtonsEnabled();
}

workspace.addEventListener("click", (e) => {
  // Check ignoreNextClick to skip toggling after a drag
  if (touchMoved || window.__readOnly || ignoreNextClick) return;

  const item = e.target.closest(".board-item");

  if (typeof isGroupingMode !== "undefined" && isGroupingMode) {
    if (item) {
      toggleGroupSelection(item);
    }
    return;
  }

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
    throttledUpdateAllConnections();
    clearSelection();
  }
});

document.addEventListener("click", (e) => {
  const insideWorkspace = e.target.closest("#workspace");
  const insideAction = e.target.closest("#action-buttons-container");
  const insideSearch = e.target.closest("#search-container"); // Don't deselect when clicking search
  const insideColorToolbar = e.target.closest("#connection-color-toolbar"); // ✅ NEW

  // Allow deselecting in read-only, just don't do work if nothing is selected
  if (window.__readOnly && !selectedItem) return;

  if (!insideWorkspace && !insideAction && !insideSearch && !insideColorToolbar) {
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
    if (
      !window.BoardAPI ||
      typeof window.BoardAPI.toggleDisconnectMode !== "function"
    )
      return;

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

// [UPDATE] Inside deleteBtn event listener
deleteBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  // --- NEW: Group Delete ---
  if (isGroupingMode && selectedGroupItems.size > 0) {
    if (confirm(`Delete ${selectedGroupItems.size} items?`)) {
      selectedGroupItems.forEach((el) => {
        window.BoardAPI.deleteItem(el);
      });
      selectedGroupItems.clear();
      onBoardMutated("delete_group"); // Trigger save once
    }
    return;
  }
  // -------------------------

  if (!selectedItem) return;
  window.BoardAPI.deleteItem(selectedItem);
  clearSelection();
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
  if (interError) {
    interError.style.display = "none";
    interError.textContent = "Couldn’t load interlinear data.";
  }
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
    const surface =
      token.text || token.surface || token.original || token.word || "?";
    const english =
      token.gloss ||
      token.english ||
      token.translated ||
      token.definition ||
      token.meaning ||
      token.trans ||
      token.translation ||
      "?";
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
    if (translit)
      metaEl.innerHTML += `<span class="meta-chip">${translit}</span>`;
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
      reference: `${referenceTitle}:${index + 1}`,
    };

    // Check if already selected (Persistence)
    const key = `${cardData.reference}::${surface}`;
    if (
      window.pendingInterlinearAdds &&
      window.pendingInterlinearAdds.has(key)
    ) {
      row.classList.add("selected-for-add");
      addBtn.classList.add("selected");
    }

    // --- CLICK HANDLERS (New Logic) ---

    // 1. Button Click (Stop propagation to prevent double-toggle)
    addBtn.onclick = (e) => {
      e.stopPropagation();
      toggleInterlinearSelection(addBtn, row, cardData);
    };

    // 2. Row Click (Same action as button)
    row.onclick = (e) => {
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
function addSongElement({ title, artist, cover }, delay = 0) {
  if (window.__readOnly && !window.__RESTORING_FROM_SUPABASE) return;

  const el = document.createElement("div");
  el.classList.add("board-item", "song-item");
  el.style.position = "absolute";
  el.dataset.type = "song";
  el.dataset.title = title || "";
  el.dataset.artist = artist || "";
  el.dataset.cover = cover || "";

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale,
    visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale,
    visibleH = vpRect.height / scale;
  const baseX = visibleX + (visibleW - 320) / 2;
  const baseY = visibleY + (visibleH - 90) / 2;

  if (delay !== 0) {
    el.style.opacity = "0";
    el.style.animation = "loadItemToBoard 1s forwards " + delay + "s";
    el.style.left = `${baseX + delay * 200}px`;
    el.style.top = `${baseY + delay * 200}px`;
  } else {
    el.style.left = `${baseX}px`;
    el.style.top = `${baseY}px`;
  }

  // FIX: Force to front
  bringToFront(el);

  el.innerHTML = `
    <div class="song-left">
      <img class="song-cover" src="${cover || ""}" alt="" />
      <div class="song-texts">
        <div class="song-name">${title}</div>
        <div class="song-artist">${artist}</div>
      </div>
    </div>
  `;

  attachSelectionFrame(el);

  workspace.appendChild(el);
  el.dataset.vkey =
    el.dataset.vkey || "v_" + Math.random().toString(36).slice(2);

  el.onmousedown = (e) => {
    if (typeof startDragMouse === "function") startDragMouse(el, e);
  };

  onBoardMutated("add_song");
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

document.addEventListener("DOMContentLoaded", () => {
  initCrossRefSelectionDelegation();
});

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

// ------------------------------
// Cross Reference "+" selection
// ------------------------------

let crossRefSelectionBound = false;

function initCrossRefSelectionDelegation() {
  if (crossRefSelectionBound) return;
  crossRefSelectionBound = true;

  const container = document.getElementById("search-query-crossref-container");
  if (!container) return;

  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".search-query-verse-add-button");
    const card = e.target.closest(".search-query-verse-container");
    if (!card) return;

    // Verse metadata filled by fillVerseBatch(...)
    const reference = card.dataset.ref || card.dataset.reference;
    const text = card.dataset.text || "";
    const version =
      card.dataset.version ||
      (typeof safeGetSelectedVersion === "function"
        ? safeGetSelectedVersion()
        : "KJV");

    if (!reference) return;

    const verseData = { reference, text, version };
    const targetBtn =
      btn || card.querySelector(".search-query-verse-add-button");

    if (
      verseData &&
      targetBtn &&
      typeof window.toggleVerseSelection === "function"
    ) {
      if (btn) {
        // Don't let the click bubble to the card itself
        e.stopPropagation();
      }
      window.toggleVerseSelection(verseData, targetBtn);
    }
  });
}

(function initVerseClickDelegation() {
  const verseContainer = document.getElementById(
    "search-query-verse-container"
  );

  if (!verseContainer) return;

  verseContainer.addEventListener("click", (e) => {
    // 1. Identify targets
    const btn = e.target.closest(".search-query-verse-add-button");
    const card = e.target.closest(".verse, .search-query-verse-container");

    if (!card) return;

    // 2. Extract Data
    // Support both dataset.ref (new) and dataset.reference (legacy)
    const reference = card.dataset.ref || card.dataset.reference;
    const text = card.dataset.text;
    const version = card.dataset.version;

    if (!reference) return;

    const verseData = {
      reference: reference,
      text: text,
      version: version,
    };

    // 3. Find the button (if we clicked the row, we still need the button element to update it)
    const targetBtn =
      btn || card.querySelector(".search-query-verse-add-button");

    if (verseData && targetBtn) {
      // 4. Execute Toggle
      // (Stop propagation if we clicked the button directly to prevent potential double-firing)
      if (btn) {
        e.stopPropagation();
      }
      toggleVerseSelection(verseData, targetBtn);
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
    // if (searchForm) searchForm.style.display = ""; // Use '' to reset to CSS default
    // if (tourBtn) tourBtn.style.display = "inline-block"; // Match supabase-sync.js logic

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
              el = addBibleVerse(item.reference, item.text, true, item.version);
              break;
            case "note":
              // Updated to support color if present
              el = addTextNote(item.text, item.color);
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
            // Restore saved Z-Index
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
        if (elA && elB) connectItems(elA, elB, c.color);
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

    // --- FIX: SYNC Z-INDEX COUNTER ---
    // Find the highest z-index on the board and ensure new items appear above it
    const allItems = document.querySelectorAll(".board-item");
    let maxZ = 0;
    allItems.forEach((el) => {
      const z = parseInt(el.style.zIndex) || 0;
      if (z > maxZ) maxZ = z;
    });
    // Update the global counter so the next click/add is definitely on top
    currentIndex = maxZ + 1;
    // --------------------------------

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

  // const steps = [
  //   {
  //     id: "welcome",
  //     title: "Welcome to Bible Board",
  //     text: "This quick tour shows you how to add verses, arrange them, connect ideas, and view interlinear details.",
  //     placement: "bottom", // Will be centered as it has no target
  //   },
  //   {
  //     id: "workspace",
  //     target: () => document.getElementById("viewport"),
  //     title: "Your Workspace",
  //     text: "This is your canvas. Drag with your mouse or finger to pan, and use the scroll wheel or pinch to zoom.",
  //     placement: "right",
  //     allowPointerThrough: true,
  //   },
  //   {
  //     id: "search",
  //     target: () => document.getElementById("search-bar"),
  //     title: "Search anything",
  //     text: "Use this search bar to find verses, topics, and songs. It's your quick entry into the board.",
  //     placement: "top",
  //     allowPointerThrough: true,
  //     beforeStep: () => {
  //       const el = document.getElementById("search-bar");
  //       if (el) el.focus();
  //     },
  //   },
  //   {
  //     id: "choose-version",
  //     target: () => document.getElementById("version-select"),
  //     title: "Choose your version",
  //     text: "Use this menu beside the search bar to choose your Bible version. Searches and added verses use this selection.",
  //     placement: "top",
  //     allowPointerThrough: true,
  //     beforeStep: () => {
  //       const select = document.getElementById("version-select");
  //       if (select) {
  //         // small UX touch so it's obvious this is interactive
  //         select.focus();
  //       }
  //     },
  //   },
  //   {
  //     id: "board-element",
  //     target: () => document.querySelector(".board-item.bible-verse"),
  //     title: "Arrange Your Cards",
  //     text: "Drag any card on the workspace to arrange your thoughts. You can create notes and add songs, too.",
  //     placement: "bottom",
  //     allowPointerThrough: true,
  //     beforeStep: async () => {
  //       // If no verse *on the board* exists, fake one
  //       if (!document.querySelector(".board-item.bible-verse")) {
  //         tempVerse = addBibleVerse(
  //           "John 3:16 KJV",
  //           "For God so loved the world...",
  //           true
  //         );
  //         tempVerse.id = "temp-tour-board-verse";
  //         // Position it in view
  //         const vpRect = viewport.getBoundingClientRect();
  //         tempVerse.style.left = `${
  //           (viewport.scrollLeft + vpRect.width / 2 - 150) / scale
  //         }px`;
  //         tempVerse.style.top = `${
  //           (viewport.scrollTop + vpRect.height / 2 - 100) / scale
  //         }px`;
  //       }
  //     },
  //     afterStep: () => {
  //       const tempBoardVerse = document.getElementById("temp-tour-board-verse");
  //       if (tempBoardVerse) {
  //         tempBoardVerse.remove();
  //       }
  //       tempVerse = null;
  //     },
  //   },
  //   {
  //     id: "undo",
  //     target: () => document.getElementById("undo-btn"),
  //     title: "Undo Your Last Action",
  //     text: "Made a mistake? Tap this button to undo your last action, like adding an item or making a connection. You can also use the shortcut Ctrl+Z.",
  //     placement: "right",
  //     allowPointerThrough: true,
  //   },
  //   {
  //     id: "redo",
  //     target: () => document.getElementById("redo-btn"),
  //     title: "Redo an Action",
  //     text: "If you undo too far, tap this button to bring your action back. The shortcut for this is Ctrl+Shift+Z.",
  //     placement: "right",
  //     allowPointerThrough: true,
  //   },
  //   {
  //     id: "connect",
  //     target: () => document.getElementById("mobile-action-button"),
  //     title: "Connect Ideas",
  //     text: "Select a card, then tap this 'Connect' button. Tap another card to draw a line between them.",
  //     placement: "right",
  //     padding: 8, // <-- ADDED THIS LINE for extra padding
  //     allowPointerThrough: true, // <-- ADD THIS LINE
  //   },
  //   {
  //     id: "disconnect",
  //     target: () => document.getElementById("disconnect-mode-btn"),
  //     title: "Disconnect Ideas",
  //     text: "Made a mistake? Connecting some ideas just click this and enter 'Disconnect Mode' allowing you to disconnect any connections.",
  //     placement: "right",
  //     allowPointerThrough: true,
  //   },
  //   {
  //     id: "notes",
  //     target: () => document.getElementById("text-action-button"),
  //     title: "Add Notes",
  //     text: "Tap this 'note' button to add a blank note card to your board. You can type anything you want!",
  //     placement: "right",
  //     allowPointerThrough: true, // <-- ADD THIS LINE
  //   },
  //   // {
  //   //   id: "interlinear",
  //   //   target: () => document.getElementById("interlinear-action-button"),
  //   //   title: "Go Deeper",
  //   //   text: "Select a verse card, then tap the 'Interlinear' button to open a word-by-word breakdown of the original language.",
  //   //   placement: "right",
  //   //   allowPointerThrough: true, // <-- ADD THIS LINE
  //   // },

  //   {
  //     id: "delete",
  //     target: () => document.getElementById("delete-action-button"),
  //     title: "Delete Item",
  //     text: "Select a item on the bible board, then tap the 'Delete' button to delete the selected item.",
  //     placement: "right",
  //     allowPointerThrough: true, // <-- ADD THIS LINE
  //   },
  //   // {
  //   //   id: "colors",
  //   //   target: () => document.getElementById("connection-color-toolbar"),
  //   //   title: "Colors for your connections",
  //   //   text: "If you want to add some color to your board select a color and when connecting ideas the 'Connection Lines' will be the selected color.",
  //   //   placement: "left",
  //   //   allowPointerThrough: true,
  //   // },
  //   {
  //     id: "finish",
  //     title: "You're All Set!",
  //     text: "You're ready to build your board. Try searching for a verse now to get started.",
  //     // allowPointerThrough: true, // <-- ADD THIS LINE
  //   },
  // ];

  const steps = []
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
    // toggleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="width: 18px; height: 18px; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);"><path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.08-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/></svg>`;
    toggleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M19.875 6.27a2.225 2.225 0 0 1 1.125 1.948v7.284c0 .809 -.443 1.555 -1.158 1.948l-6.75 4.27a2.269 2.269 0 0 1 -2.184 0l-6.75 -4.27a2.225 2.225 0 0 1 -1.158 -1.948v-7.285c0 -.809 .443 -1.554 1.158 -1.947l6.75 -3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98h-.033z"/><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/></svg>`;

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
    // if (exportBtn || shareBtn) {
    //   content.appendChild(createLabel("Board Actions"));
    //   if (exportBtn) {
    //     resetPosition(exportBtn);
    //     content.appendChild(exportBtn);
    //   }
    //   if (shareBtn) {
    //     resetPosition(shareBtn);
    //     content.appendChild(shareBtn);
    //   }
    // }

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

// ============================================================
//                  CROSS REFERENCE MODE (FINAL)
// ============================================================

// API Endpoint
const CROSSREF_API_BASE = "https://full-bible-api.onrender.com/crossref";

let crossRefResults = [];
let crossRefRenderedCount = 0;
let crossRefAbortController = null;
let lastCrossRefKey = "";

// --- Normalizes reference strings so that "Gen", "Genesis" etc. map consistently ---
function normalizeRef(ref) {
  if (!ref) return "";
  return ref
    .replace(/\s+/g, "")
    .replace(/([A-Za-z]+)(\d+)/, "$1 $2")
    .trim()
    .toLowerCase()
    .replace("genesis", "gen")
    .replace("exodus", "exod")
    .replace("psalms", "ps")
    .replace("psalm", "ps")
    .replace("proverbs", "prov")
    .replace("isaiah", "isa")
    .replace("john", "john") // keep
    .replace("hebrews", "heb");
}

// Helpers
function isMultiVerseReference(ref) {
  if (!ref) return false;

  // If it contains a dash, it's a range.
  if (ref.includes("-")) return true;

  // If it contains two verse numbers without a dash, but split oddly:
  // Example: "John 1 1" (missing colon), treat as invalid.
  const parts = ref.trim().split(/\s+/);

  // Valid single verse should match something like "John", "1:3"
  const last = parts[parts.length - 1];
  if (!/^\d+:\d+$/.test(last)) return true;

  return false;
}

function $(id) {
  return document.getElementById(id);
}

// Normalize a book name from user input (e.g. "1 peter", "1Pe")
// to the canonical label from bibleBookCodes (e.g. "1 Peter").
function normalizeBookForCrossref(book) {
  if (!book) return "";

  const target = book.toLowerCase().replace(/[^a-z0-9]/g, "");

  for (const full of Object.keys(bibleBookCodes)) {
    const normFull = full.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normFull === target) {
      // Exact canonical match, e.g. "1 Peter"
      return full;
    }
  }

  // Fallback: basic title-case so "1 peter" -> "1 Peter"
  return book
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Take whatever the user typed ("1 peter 1:1", "1 Peter1:1", etc.)
// and turn it into a canonical "Book Chapter:Verse" string
// using your existing reference parser + bibleBookCodes.
function cleanRefForApi(rawRef) {
  if (!rawRef) return "";
  let ref = String(rawRef).trim();

  // Try to parse with the helper you already have
  const parts = parseReferenceToParts(ref); // { book, chapter, verse } or null

  if (parts) {
    let { book, chapter, verse } = parts;

    // Normalize the book using bibleBookCodes (handles "1 Peter", "1 peter", etc.)
    const target = book.toLowerCase().replace(/[^a-z0-9]/g, "");

    let canonicalBook = null;
    for (const fullName of Object.keys(bibleBookCodes)) {
      const normFull = fullName.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normFull === target) {
        canonicalBook = fullName;
        break;
      }
    }

    // Fallback: simple title-case if not found in bibleBookCodes
    if (!canonicalBook) {
      canonicalBook = book
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }

    return `${canonicalBook} ${chapter}:${verse}`;
  }

  // Fallback path if parsing failed: at least ensure "Genesis1:1" → "Genesis 1:1"
  ref = ref.replace(/(\D+)(\d+:\d+)/, "$1 $2");
  return ref.trim();
}

// Build valid API URL
function buildCrossrefUrl(ref) {
  const cleaned = cleanRefForApi(ref);
  console.log("[Crossref] Fetching for:", cleaned);
  return `${CROSSREF_API_BASE}/?verse=${encodeURIComponent(cleaned)}`;
}

// Display error or empty state
function renderCrossrefsMessage(msg, type = "empty") {
  const wrap = $("search-query-crossref-container");
  if (!wrap) return;
  wrap.innerHTML = "";

  const div = document.createElement("div");
  div.className =
    type === "error" ? "crossref-error-message" : "crossref-empty-message";
  div.textContent = msg;

  wrap.appendChild(div);
}

// Build individual result row
// Build a "Bible-style" card shell for a cross-reference.
// fillVerseBatch will later fill in the verse text and wire the + button.
function buildCrossRefRowShell(ref, votes, version) {
  const row = document.createElement("div");
  row.className = "search-query-verse-container crossref-row";
  row.dataset.status = "loading";
  row.dataset.ref = ref;
  row.dataset.version = version;

  row.innerHTML = `
    <div class="search-query-verse-text">Loading...</div>
    <div class="search-query-verse-reference">
      – ${ref} ${version.toUpperCase()}
    </div>
  `;
  return row;
}

// Render one "page" of Crossref results
function renderCrossRefPage(isFirstPage) {
  const wrap = $("search-query-crossref-container");
  if (!wrap || !crossRefResults || !crossRefResults.length) return;

  const version = safeGetSelectedVersion() || "KJV";

  // First page: clear + reset counter
  if (isFirstPage) {
    wrap.innerHTML = "";
    crossRefRenderedCount = 0;
  } else {
    // Remove old "Load more" wrapper if present
    const oldMore = wrap.querySelector(".crossref-load-more-wrapper");
    if (oldMore) oldMore.remove();
  }

  const LOAD_SIZE = isFirstPage
    ? CROSSREF_INITIAL_VISIBLE_COUNT
    : CROSSREF_LOAD_MORE_CHUNK;

  const start = crossRefRenderedCount;
  const end = Math.min(start + LOAD_SIZE, crossRefResults.length);
  if (start >= end) return;

  const verseBatch = [];

  for (let i = start; i < end; i++) {
    const item = crossRefResults[i];
    if (!item) continue;

    const cleanedRef = cleanRefForApi(item.cross_ref);
    if (!cleanedRef) continue;

    // ❗ SKIP multi-verse references
    if (isMultiVerseReference(cleanedRef)) {
      console.warn("Skipping multi-verse crossref:", cleanedRef);
      continue;
    }

    const displayRef = expandReferenceAbbrev(cleanedRef);

    const card = buildCrossRefRowShell(displayRef, item.votes, version);
    wrap.appendChild(card);

    verseBatch.push({ ref: displayRef, el: card });
  }

  crossRefRenderedCount = end;

  // ⬅️ THIS is the key change: we now pass { ref, el } objects
  // and a real version argument.
  if (verseBatch.length) {
    fillVerseBatch(verseBatch, null, version);
  }

  // Show "Load more" if there are more crossrefs
  if (crossRefRenderedCount < crossRefResults.length) {
    const moreWrap = document.createElement("div");
    moreWrap.className = "crossref-load-more-wrapper";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-load-more";
    btn.textContent = "Load more";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      renderCrossRefPage(false);
    });

    moreWrap.appendChild(btn);
    wrap.appendChild(moreWrap);
  }
}

// Fetch API → parse → render
async function fetchAndRenderCrossrefs(reference) {
  resetVerseStudySections();
  const crossSec = document.getElementById("crossref-section");
  const loader = document.getElementById("crossref-section-loader");
  const content = document.getElementById("crossref-section-content");

  if (!crossSec) return;
  crossSec.style.display = "block";
  loader.style.display = "flex";
  content.innerHTML = "";

  try {
    const url = `https://api.bibleboard.app/crossref?verse=${encodeURIComponent(reference)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("CrossRef API error " + res.status);

    const data = await res.json();
    loader.style.display = "none";

    if (!data.results || data.results.length === 0) {
      content.innerHTML = `<div style="color:var(--muted)">No cross references for ${reference}.</div>`;
      return;
    }

    content.innerHTML = data.results
      .map(
        (r) => `
        <div class="crossref-result-row">
          <div class="crossref-main">
            <div class="crossref-ref">${r.cross_ref}</div>
            <div class="crossref-text">${r.text || ""}</div>
          </div>
          <button class="crossref-add-button" onclick="addBibleVerse('${r.cross_ref}')">Add</button>
        </div>`
      )
      .join("");
  } catch (err) {
    console.error("CrossRef fetch failed:", err);
    loader.style.display = "none";
    content.innerHTML = `<div style="color:red;">Error loading cross references.</div>`;
  }
}


// Update from context (entry point)
function updateCrossrefsFromCurrentContext(force = false) {
  if (window.currentSearchMode !== "crossref") return;

  const bar = $("search-bar");
  const raw = bar?.value?.trim() ?? "";

  if (!raw) {
    renderCrossrefsMessage("Enter a verse reference to see results.");
    return;
  }

  // ✅ Normalize to a full, canonical reference like "1 Peter 1:3"
  const canonicalRef = cleanRefForApi(raw);
  if (!canonicalRef) {
    renderCrossrefsMessage("Enter a valid verse reference.");
    return;
  }

  const key = canonicalRef;
  if (!force && key === lastCrossRefKey) return;
  lastCrossRefKey = key;

  // We pass the canonical ref; fetchAndRenderCrossrefs will still re-clean it,
  // which is harmless and keeps behavior consistent.
  fetchAndRenderCrossrefs(canonicalRef);
}

window.updateCrossrefsFromCurrentContext = updateCrossrefsFromCurrentContext;

// "Load More" button
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("crossref-load-more");
  if (btn) {
    btn.addEventListener("click", () => {
      renderCrossRefPage(false);
    });
  }
});

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
};

/**
 * Parse "Book C:V" into {book, chapter, verse} or null
 */
function parseReferenceString(refStr) {
  if (!refStr) return null;
  let s = String(refStr)
    .replace(/\(.*?\)/g, "")
    .replace(/[“”"']/g, "")
    .trim();
  const m = s.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return {
    book: m[1].trim(),
    chapter: parseInt(m[2], 10),
    verse: parseInt(m[3], 10),
  };
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
    if (!window.searchDrawerOpen) {
      window.searchDrawerOpen = true;
      try {
        applyLayout && applyLayout(true);
      } catch {}
    }
    // Switch to Interlinear mode
    try {
      setSearchMode && setSearchMode("interlinear", { openDrawer: true });
    } catch {}
    // Fetch and render
    openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
  } else {
    // Not a verse-shaped query: show message
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
    if (interError) interError.style.display = "none";
    if (interList)
      interList.innerHTML = q
        ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`
        : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
  }
}

function populateInterlinearFromCurrentQuery() {
  const bar = document.getElementById("search-bar");
  const q =
    (bar && bar.value ? bar.value.trim() : "") ||
    (window.__lastRawQuery || "").trim();

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
  try {
    if (typeof parseReferenceString === "function")
      ref = parseReferenceString(q);
  } catch {}
  if (!ref && q) {
    const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
    if (m)
      ref = {
        book: m[1].trim(),
        chapter: parseInt(m[2], 10),
        verse: parseInt(m[3], 10),
      };
  }

  if (ref && typeof openInterlinearForReference === "function") {
    openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
  } else {
    // Not a verse-shaped query → show message "No interlinear for 'q'"
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoader) interLoader.style.display = "none";
    if (interError) interError.style.display = "none";
    if (interList)
      interList.innerHTML = q
        ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`
        : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
  }
}

// --- BEGIN: Interlinear-from-query hardening (drop-in) ---

// Keep track of the user's latest raw query locally (fallback if the header helper wasn't loaded)
window.__lastRawQuery = window.__lastRawQuery || "";

// Robust "Book C:V" parser (uses the one already in your file)
function __parseRefStrict(s) {
  if (typeof parseReferenceString === "function")
    return parseReferenceString(s);
  const t = String(s || "")
    .replace(/\(.*?\)/g, "")
    .replace(/[“”"']/g, "")
    .trim();
  const m = t.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
  if (!m) return null;
  return {
    book: m[1].trim(),
    chapter: parseInt(m[2], 10),
    verse: parseInt(m[3], 10),
  };
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
  const interList = document.getElementById("interlinear-list");
  const interErr = document.getElementById("interlinear-error");
  const interLoad = document.getElementById("interlinear-loader");

  // Make sure the panel is inline (not hidden behind the drawer)
  try {
    mountInterlinearInline && mountInterlinearInline();
  } catch {}

  // Ensure drawer open + switch to Interlinear
  if (!window.searchDrawerOpen) {
    window.searchDrawerOpen = true;
    try {
      applyLayout?.(true);
    } catch {}
  }
  try {
    setSearchMode?.("interlinear", { openDrawer: true });
  } catch {}

  // Reset UI
  if (interPanel) interPanel.setAttribute("aria-busy", "true");
  if (interLoad) interLoad.style.display = "flex";
  if (interErr) interErr.style.display = "none";
  if (interList) interList.innerHTML = "";

  // Parse "Book C:V" (use project parser if available)
  const ref =
    typeof parseReferenceString === "function"
      ? parseReferenceString(q)
      : (() => {
          const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
          return m
            ? {
                book: m[1].trim(),
                chapter: parseInt(m[2], 10),
                verse: parseInt(m[3], 10),
              }
            : null;
        })();

  if (!ref) {
    // Not a verse-shaped query → show friendly message
    if (interList) {
      interList.innerHTML = q
        ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`
        : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
    }
    if (interPanel) interPanel.setAttribute("aria-busy", "false");
    if (interLoad) interLoad.style.display = "none";
    return;
  }

  // Call your existing interlinear opener; ALWAYS stop the loader afterward
  try {
    if (typeof openInterlinearForReference === "function") {
      await openInterlinearForReference(
        `${ref.book} ${ref.chapter}:${ref.verse}`
      );
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
    if (interLoad) interLoad.style.display = "none";
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

async function openInterlinearForReference(reference) {
  console.log("[Interlinear] incoming reference:", reference);

  resetVerseStudySections();
  const interSec = document.getElementById("interlinear-section");
  const loader = document.getElementById("interlinear-section-loader");
  const content = document.getElementById("interlinear-section-content");

  if (!interSec || !loader || !content) {
    console.warn("[Interlinear] Missing interlinear DOM elements");
    return;
  }

  interSec.style.display = "block";
  loader.style.display = "flex";
  content.innerHTML = "";

  try {
    // --- 1️⃣ Normalize reference into { book, chapter, verse } ---
    let refObj = null;

    // Case A: already an object { book, chapter, verse }
    if (
      reference &&
      typeof reference === "object" &&
      reference.book &&
      reference.chapter &&
      reference.verse
    ) {
      refObj = {
        book: reference.book,
        chapter: Number(reference.chapter),
        verse: Number(reference.verse),
      };
    }
    // Case B: string like "Genesis 1:1"
    else if (typeof reference === "string") {
      let parsed = null;

      // Prefer your existing helper if available
      if (typeof window.findBibleVerseReference === "function") {
        const result = window.findBibleVerseReference(reference);
        if (result && result.book && result.chapter && result.verse) {
          parsed = {
            book: result.book,
            chapter: result.chapter,
            verse: result.verse,
          };
        } else if (result && result.reference) {
          const m = result.reference.match(/^(.+?)\s+(\d+):(\d+)$/);
          if (m) {
            parsed = {
              book: m[1].trim(),
              chapter: parseInt(m[2], 10),
              verse: parseInt(m[3], 10),
            };
          }
        }
      }

      // Regex fallback if helper fails
      if (!parsed) {
        const m = reference.match(/^(.+?)\s+(\d+):(\d+)$/);
        if (m) {
          parsed = {
            book: m[1].trim(),
            chapter: parseInt(m[2], 10),
            verse: parseInt(m[3], 10),
          };
        }
      }

      refObj = parsed;
    }

    if (!refObj || !refObj.book || !refObj.chapter || !refObj.verse) {
      loader.style.display = "none";
      content.innerHTML = `<div style="color:var(--muted);">
        Couldn’t understand reference: <code>${String(reference)}</code>
      </div>`;
      console.warn("[Interlinear] Failed to parse reference:", reference);
      return;
    }

    const { book, chapter, verse } = refObj;

    // --- 2️⃣ Map full book name → API code (e.g., "Genesis" → "GEN") ---
    let bookCode = book;
    if (typeof bibleBookCodes === "object" && bibleBookCodes[book]) {
      bookCode = bibleBookCodes[book]; // e.g. "GEN", "REV", "JHN"
    }

    // --- 3️⃣ Build the API URL ---
    const apiUrl = `https://full-bible-api.onrender.com/interlinear/${encodeURIComponent(
      bookCode
    )}/${chapter}/${verse}`;

    console.log("[Interlinear] Fetching:", apiUrl);

    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error("Failed to load interlinear");

    const data = await res.json();
    loader.style.display = "none";

    // 🔴 Your API uses "tokens", not "words"
    const tokens = Array.isArray(data.tokens)
      ? data.tokens
      : Array.isArray(data.words)
      ? data.words
      : [];

    if (!tokens.length) {
      content.innerHTML = `<div style="color:var(--muted);">
        No interlinear data found for ${book} ${chapter}:${verse}.
      </div>`;
      return;
    }

    content.innerHTML = tokens
      .map((w) => {
        const surface = w.surface ?? "";
        const english =
          w.english ||
          w.translation ||
          w.resolved_gloss ||
          "";
        const translit = w.translit || w.resolved_translit || "";
        const morph = w.morph || "";
        const strong = w.strong || "";

        return `
          <div class="interlinear-row">
            <div class="interlinear-surface">${surface}</div>
            <div class="interlinear-english">${english}</div>
            <div class="interlinear-meta">
              <span class="meta-chip">${translit}</span>
              <span class="meta-chip">${morph}</span>
              <span class="meta-chip">${strong}</span>
            </div>
          </div>
        `;
      })
      .join("");
  } catch (err) {
    console.error("Interlinear fetch failed:", err);
    loader.style.display = "none";
    content.innerHTML = `<div style="color:red;">
      Error loading interlinear data.
    </div>`;
  }
}



// Load cross references into the verse-study modal
async function openCrossRefForReference(reference) {
  console.log("[VerseStudy Crossref] incoming reference:", reference);

  const crossSec = document.getElementById("crossref-section");
  const loader = document.getElementById("crossref-section-loader");
  const content = document.getElementById("crossref-section-content");

  if (!crossSec || !loader || !content) {
    console.warn("[VerseStudy Crossref] Missing DOM elements");
    return;
  }

  // Show the section + loader
  crossSec.style.display = "block";
  loader.style.display = "flex";
  content.innerHTML = "";

  try {
    // 1️⃣ Normalize the base verse (e.g. "Genesis 1:1")
    const baseRef = typeof cleanRefForApi === "function"
      ? cleanRefForApi(reference)
      : String(reference || "").trim();

    if (!baseRef) {
      loader.style.display = "none";
      content.innerHTML = `<div style="color:var(--muted);">
        Couldn't understand reference: <code>${String(reference)}</code>
      </div>`;
      return;
    }

    // Abort any previous modal crossref request
    if (window.__verseStudyCrossrefAbortController) {
      try {
        window.__verseStudyCrossrefAbortController.abort();
      } catch (_) {}
    }
    const controller = new AbortController();
    window.__verseStudyCrossrefAbortController = controller;

    // 2️⃣ Build API URL (this uses CROSSREF_API_BASE = "https://full-bible-api.onrender.com/crossref")
    const url = typeof buildCrossrefUrl === "function"
      ? buildCrossrefUrl(baseRef)
      : `https://full-bible-api.onrender.com/crossref/?verse=${encodeURIComponent(baseRef)}`;

    console.log("[VerseStudy Crossref] Fetching:", url);

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("Crossref API error " + res.status);

    const data = await res.json();

    // Your API shape: { query, normalized, results: [...] }
    const rawResults = Array.isArray(data.results) ? data.results : [];

    if (!rawResults.length) {
      loader.style.display = "none";
      content.innerHTML = `<div style="color:var(--muted);">
        No cross references found.
      </div>`;
      return;
    }

    const version =
      typeof safeGetSelectedVersion === "function"
        ? safeGetSelectedVersion()
        : (typeof getSelectedVersion === "function"
            ? getSelectedVersion()
            : "KJV");

    const rows = [];
    const MAX_RESULTS = 15; // you can tweak this

    for (let i = 0; i < rawResults.length && rows.length < MAX_RESULTS; i++) {
      if (controller.signal.aborted) return;

      const item = rawResults[i];
      if (!item) continue;

      // The crossref dataset uses `cross_ref`
      const rawRef = item.cross_ref || item.reference || item.verse || "";
      if (!rawRef) continue;

      // Normalize to something like "John 1:1"
      const cleanedCross = typeof cleanRefForApi === "function"
        ? cleanRefForApi(rawRef)
        : String(rawRef);

      if (!cleanedCross) continue;

      // Skip multi-verse refs like "John 1:1-3"
      if (typeof isMultiVerseReference === "function" &&
          isMultiVerseReference(cleanedCross)) {
        continue;
      }

      const parts = parseReferenceToParts(cleanedCross);
      if (!parts) continue;

      let text;
      try {
        text = await fetchVerseText(
          parts.book,
          parts.chapter,
          parts.verse,
          controller.signal,
          version
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("Failed to load crossref verse", cleanedCross, err);
        continue;
      }

      if (!text || /not\s*found|unavailable|error/i.test(String(text))) {
        continue;
      }

      const displayRef = typeof expandReferenceAbbrev === "function"
        ? expandReferenceAbbrev(cleanedCross)
        : cleanedCross;

      const cleanText = typeof cleanDisplayVerse === "function"
        ? cleanDisplayVerse(text)
        : text;

      rows.push(`
        <div class="crossref-row search-query-verse-container"
            data-ref="${displayRef}"
            data-version="${version}"
            data-text="${cleanText}">
          <div class="crossref-main">
            <div class="crossref-ref">${displayRef}</div>
            <div class="crossref-text">${cleanText}</div>
          </div>
          <button
            type="button"
            class="search-query-verse-add-button"
            aria-label="Add ${displayRef} to board">
          </button>
        </div>
      `);

    }

    loader.style.display = "none";

    if (!rows.length) {
      content.innerHTML = `<div style="color:var(--muted);">
        No cross references with text found.
      </div>`;
      return;
    }

    content.innerHTML = rows.join("");

        // Wire up click handlers so cross-ref rows can be added to the
    // same "Add to board" queue used by the Bible search + reader.
    try {
      // Ensure the global verse queue map exists
      if (!window.pendingVerseAdds) {
        window.pendingVerseAdds = new Map();
      }

      const rowsEls = content.querySelectorAll(
        ".crossref-row.search-query-verse-container"
      );

      rowsEls.forEach((rowEl) => {
        const btnEl = rowEl.querySelector(".search-query-verse-add-button");
        if (!btnEl) return;

        // Build the verse payload from data attributes
        const reference =
          rowEl.dataset.ref || rowEl.dataset.reference || "";
        const text = rowEl.dataset.text || "";
        const version =
          rowEl.dataset.version ||
          (typeof safeGetSelectedVersion === "function"
            ? safeGetSelectedVersion()
            : "KJV");

        if (!reference) return;

        const verseData = { reference, text, version };
        const key = `${verseData.reference}::${verseData.version}`;

        // If this verse is already queued, reflect that visually
        if (window.pendingVerseAdds.has(key)) {
          rowEl.classList.add("selected-for-add");
          btnEl.classList.add("selected");
        }

        const handleToggle = (evt) => {
          if (evt) evt.stopPropagation();
          if (typeof toggleVerseSelection === "function") {
            toggleVerseSelection(verseData, btnEl);
          } else if (window.toggleVerseSelection) {
            window.toggleVerseSelection(verseData, btnEl);
          }
        };

        // Click on the plus icon
        btnEl.addEventListener("click", handleToggle);

        // Clicking anywhere on the row should also toggle
        rowEl.addEventListener("click", (evt) => {
          // If the click originated on the actual button, the button
          // handler already fired; no need to run twice.
          if (evt.target.closest(".search-query-verse-add-button")) {
            return;
          }
          handleToggle(evt);
        });
      });
    } catch (wiringErr) {
      console.error(
        "[VerseStudy Crossref] Failed to wire add-to-board handlers:",
        wiringErr
      );
    }

  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("[VerseStudy Crossref] error:", err);
    loader.style.display = "none";
    content.innerHTML = `<div style="color:red;">
      Error loading cross references.
    </div>`;
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
      if (
        i.type === data.type &&
        i.reference === data.reference &&
        i.surface === data.surface
      ) {
        // Unique check for Interlinear
        queue.delete(i);
        break;
      }
      // Add checks for verse/song uniqueness if needed
      if (i.type === "verse" && i.reference === data.reference) {
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
  const queue = window.itemsToAddQueue;

  // Nothing queued → nothing to do
  if (!queue || queue.size === 0) return;

  // 🔒 NEW: enforce the per-board limit ONLY on this bulk add action
  if (typeof window.ensureCanAddBatch === "function") {
    const canAdd = await window.ensureCanAddBatch(queue.size);
    if (!canAdd) {
      // IMPORTANT: do NOT clear the queue or selection.
      // This lets a user upgrade and just click the button again
      // without losing all the verses they’ve selected.
      return;
    }
  }

  // 1. Hide the search/drawer UI
  const searchContainer = document.getElementById("search-query-container");
  const searchInput = document.getElementById("search-bar");
  if (searchContainer) searchContainer.classList.remove("open");
  if (searchInput) searchInput.value = "";
  if (floatBtn) floatBtn.style.display = "none";

  // 2. Calculate where to place new items visually (centered around viewport center)
  const viewportEl = document.querySelector(".viewport");
  const viewportRect = viewportEl.getBoundingClientRect();
  const workspaceRect = workspace.getBoundingClientRect();

  const centerX = viewport.scrollLeft + viewportRect.width / 2;
  const centerY = viewport.scrollTop + viewportRect.height / 2;

  const offsetStep = 40;
  const totalItems = queue.size;
  const startX = centerX - ((totalItems - 1) * offsetStep) / 2;
  const startY = centerY - ((totalItems - 1) * offsetStep) / 2;

  // Take a snapshot so index math is stable even if the Set changes
  const items = Array.from(queue);

  // 3. Iterate and Add
  items.forEach((item, idx) => {
    let newEl = null;

    if (item.type === "verse") {
      // Add a verse card
      newEl = window.BoardAPI.addBibleVerse(
        item.reference,
        item.text,
        false,
        item.version
      );
    } else if (item.type === "song") {
      newEl = window.BoardAPI.addSongElement(item.song);
    } else if (item.type === "interlinear") {
      newEl = window.BoardAPI.addInterlinearCard(item);
    }

    if (newEl) {
      const x = startX + idx * offsetStep;
      const y = startY + idx * offsetStep;

      newEl.style.left = `${Math.max(
        0,
        Math.min(x - workspaceRect.left, workspace.offsetWidth - newEl.offsetWidth)
      )}px`;
      newEl.style.top = `${Math.max(
        0,
        Math.min(y - workspaceRect.top, workspace.offsetHeight - newEl.offsetHeight)
      )}px`;

      newEl.classList.add("highlight-flash");
      setTimeout(() => newEl.classList.remove("highlight-flash"), 800);
    }
  });

  // 5. Clean up
  queue.clear();

  // Remove "selected" styling from all buttons in the DOM
  document
    .querySelectorAll(".search-query-verse-add-button.selected")
    .forEach((btn) => {
      btn.classList.remove("selected");
    });
  document.querySelectorAll(".selected-for-add").forEach((row) => {
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
window.openInterlinearFromCurrentQuery = async function () {
  const searchEl = document.getElementById("search-bar");
  const q = (searchEl?.value || window.__lastRawQuery || "").trim();

  // 1. Parse
  const ref =
    typeof parseReferenceString === "function"
      ? parseReferenceString(q)
      : (() => {
          const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
          return m
            ? {
                book: m[1].trim(),
                chapter: parseInt(m[2], 10),
                verse: parseInt(m[3], 10),
              }
            : null;
        })();

  const interPanel = document.getElementById("interlinear-panel");
  const interLoader = document.getElementById("interlinear-loader");
  const interList = document.getElementById("interlinear-list");

  if (!ref) {
    if (interList)
      interList.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`;
    if (interLoader) interLoader.style.display = "none";
    return;
  }

  // 2. CHECK CACHE
  const requestKey = `${ref.book.toUpperCase()}_${ref.chapter}:${ref.verse}`;
  const hasContent = interList && interList.children.length > 0;

  // If the panel is open AND showing this exact verse, STOP.
  if (
    window.__currentInterlinearRef === requestKey &&
    interPanel &&
    interPanel.classList.contains("open") &&
    hasContent
  ) {
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
    await openInterlinearForReference(
      `${ref.book} ${ref.chapter}:${ref.verse}`
    );
  }
};

/* =================================================================
   FINAL FIX: INTERLINEAR REFRESH LOOP
   Paste this at the VERY BOTTOM of board/script.js
   =================================================================
*/

(function () {
  // console.log("🔧 Applying Interlinear Refresh Fix...");

  // 1. Global tracking for the current view
  window.__lastInterlinearRef = null;

  // 2. Define the "Smart" logic that checks cache
  const smartInterlinearOpener = async function () {
    const searchEl = document.getElementById("search-bar");
    // Get query from input OR the global fallback
    const q = (searchEl?.value || window.__lastRawQuery || "").trim();

    const interPanel = document.getElementById("interlinear-panel");
    const interList = document.getElementById("interlinear-list");
    const interLoad = document.getElementById("interlinear-loader");

    // 1. Parse the reference (e.g. "John 3:16")
    // Use your project's parser if available, otherwise simple regex
    let ref = null;
    if (typeof parseReferenceString === "function") {
      ref = parseReferenceString(q);
    } else {
      const m = q.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
      if (m)
        ref = {
          book: m[1].trim(),
          chapter: parseInt(m[2], 10),
          verse: parseInt(m[3], 10),
        };
    }

    // If not a verse, just clear and show message
    if (!ref) {
      if (interList)
        interList.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}". Please search for a verse(John 3:16, e.g)</div>`;
      if (interLoad) interLoad.style.display = "none";
      return;
    }

    // 2. CACHE CHECK (The Fix)
    // Generate a unique key for this specific verse
    const requestKey = `${ref.book.toUpperCase()}_${ref.chapter}:${ref.verse}`;
    const hasContent = interList && interList.children.length > 0;
    const isPanelOpen =
      interPanel &&
      (interPanel.classList.contains("open") ||
        interPanel.style.display === "block");

    // If we are already looking at this verse, and the panel has content... STOP.
    if (
      window.__lastInterlinearRef === requestKey &&
      isPanelOpen &&
      hasContent
    ) {
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
      await openInterlinearForReference(
        `${ref.book} ${ref.chapter}:${ref.verse}`
      );
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
    if (
      e.target.tagName === "BUTTON" ||
      e.target.tagName === "INPUT" ||
      e.target.closest(".connection-handle")
    ) {
      return;
    }

    // Try to call the global BoardAPI handler if it exists
    if (window.BoardAPI && typeof window.BoardAPI.onItemDown === "function") {
      window.BoardAPI.onItemDown(e, el);
    }
  });

  // B. Card Dragging (Touch)
  el.addEventListener(
    "touchstart",
    (e) => {
      if (
        e.target.tagName === "BUTTON" ||
        e.target.tagName === "INPUT" ||
        e.target.closest(".connection-handle")
      ) {
        return;
      }

      if (window.BoardAPI && typeof window.BoardAPI.onItemDown === "function") {
        window.BoardAPI.onItemDown(e, el);
      }
    },
    { passive: false }
  );

  // C. Connection Handle Logic
  const handle = el.querySelector(".connection-handle");
  if (handle) {
    handle.addEventListener("mousedown", (e) => {
      e.stopPropagation(); // Stop card drag
      if (
        window.BoardAPI &&
        typeof window.BoardAPI.startConnectionDrag === "function"
      ) {
        window.BoardAPI.startConnectionDrag(e, el);
      }
    });

    handle.addEventListener(
      "touchstart",
      (e) => {
        e.stopPropagation();
        if (
          window.BoardAPI &&
          typeof window.BoardAPI.startConnectionDrag === "function"
        ) {
          window.BoardAPI.startConnectionDrag(e, el);
        }
      },
      { passive: false }
    );
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
        ${
          data.translit
            ? `<span class="interlinear-chip">${data.translit}</span>`
            : ""
        }
        ${
          data.morph
            ? `<span class="interlinear-chip">${data.morph}</span>`
            : ""
        }
        ${
          data.strong
            ? `<span class="interlinear-chip">${data.strong}</span>`
            : ""
        }
      </div>
    </div>
  `;

  // --- EVENT ATTACHMENT (The Fix) ---
  // Matches how addBibleVerse and addSongElement work in your file
  el.onmousedown = (e) => {
    // Ignore clicks on buttons/inputs or the handle
    if (
      e.target.closest("button") ||
      e.target.closest("input") ||
      e.target.closest(".connection-handle")
    ) {
      return;
    }

    // Check for connect mode or standard drag
    if (typeof isConnectMode !== "undefined" && isConnectMode) return;

    // Use the global drag starter
    if (typeof startDragMouse === "function") {
      startDragMouse(el, e);
    }
  };

  attachSelectionFrame(el);

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

/* ==================== MULTI-SELECT & VERSE GROUPING LOGIC ==================== */

// 1. State: Tracks which verses are currently selected
const verseSelectionQueue = new Map();

/**
 * Updates the Floating "Add to Board" Button in the top right.
 */
function updateFloatingButton() {
  const floatBtn = document.getElementById("floating-add-to-board-btn");
  if (!floatBtn) return;

  const count = verseSelectionQueue.size;

  if (count > 0) {
    floatBtn.style.display = "flex";
    floatBtn.innerHTML = `
      <span class="material-symbols-outlined">add_circle</span>
      Add ${count} Item${count !== 1 ? "s" : ""}
    `;

    // Unbind old listeners to prevent duplicates, then rebind
    const newBtn = floatBtn.cloneNode(true);
    floatBtn.parentNode.replaceChild(newBtn, floatBtn);

    newBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      flushVerseQueue();
    };
  } else {
    floatBtn.style.display = "none";
  }
}

/**
 * LOGIC ENGINE: Groups continuous verses and adds them to the board.
 */
function flushVerseQueue() {
  if (verseSelectionQueue.size === 0) return;

  // 1. Convert Map to Array
  const verses = Array.from(verseSelectionQueue.values());

  // 2. Sort Verses
  const parseRef = (ref) => {
    const match = ref.match(/^((?:[1-3]\s)?[A-Za-z\s]+)\s+(\d+):(\d+)$/);
    if (!match) return { book: ref, chapter: 0, verse: 0 };
    return {
      book: match[1].trim(),
      chapter: parseInt(match[2]),
      verse: parseInt(match[3]),
    };
  };

  verses.sort((a, b) => {
    const va = parseRef(a.reference);
    const vb = parseRef(b.reference);
    if (va.book !== vb.book) return va.book.localeCompare(vb.book);
    if (va.chapter !== vb.chapter) return va.chapter - vb.chapter;
    return va.verse - vb.verse;
  });

  // 3. Group Continuous Verses
  const groups = [];
  if (verses.length > 0) {
    let currentGroup = [verses[0]];
    for (let i = 1; i < verses.length; i++) {
      const prev = currentGroup[currentGroup.length - 1];
      const curr = verses[i];
      const prevData = parseRef(prev.reference);
      const currData = parseRef(curr.reference);

      // Continuity Check
      if (
        currData.book === prevData.book &&
        currData.chapter === prevData.chapter &&
        currData.verse === prevData.verse + 1
      ) {
        currentGroup.push(curr);
      } else {
        groups.push(currentGroup);
        currentGroup = [curr];
      }
    }
    groups.push(currentGroup);
  }

  // 4. Create Elements
  groups.forEach((group, index) => {
    const delay = index * 0.1;

    if (group.length === 1) {
      // --- Single Verse ---
      const v = group[0];
      window.BoardAPI.addBibleVerse(
        v.reference,
        v.text,
        false,
        v.version,
        delay
      );
    } else {
      // --- Verse Range (Section) ---
      const first = group[0];
      const last = group[group.length - 1];

      const parseRef = (ref) => {
        // Simple parser for the queue logic
        const m = ref.match(/:(\d+)$/);
        return m ? parseInt(m[1]) : 0;
      };

      const firstMeta = parseReferenceToParts(first.reference) || {
        book: "",
        chapter: 0,
        verse: 0,
      };
      const lastMeta = parseReferenceToParts(last.reference) || { verse: 0 };

      // Construct range reference: "Genesis 50:2-3"
      const combinedRef = `${firstMeta.book} ${firstMeta.chapter}:${firstMeta.verse}-${lastMeta.verse}`;

      // FIX: Force [N] formatting on every verse BEFORE joining
      const combinedText = group
        .map((v) => {
          const vNum = parseRef(v.reference);
          let cleanText = v.text;

          // 1. Remove existing [N] or leading numbers to start fresh
          //    Removes "[2] " or "2 " or "<sup>2</sup>"
          cleanText = cleanText
            .replace(/^\[\d+\]\s*/, "")
            .replace(/^\d+\s+/, "")
            .replace(/<[^>]+>/g, ""); // Clean any stray HTML

          // 2. Re-apply standard bracket format
          return `[${vNum}] ${cleanText}`;
        })
        .join(" ");

      window.BoardAPI.addBibleVerse(
        combinedRef,
        combinedText,
        false,
        first.version,
        delay
      );
    }
  });

  // 5. Cleanup
  verseSelectionQueue.clear();
  updateFloatingButton();
  document
    .querySelectorAll(".search-query-verse-add-button.selected")
    .forEach((btn) => {
      btn.classList.remove("selected");
    });

  closeSearchQuery();
}

/* ==================== OVERWRITTEN RENDER FUNCTION ==================== */

/**
 * Renders the list of verses into the search drawer.
 * Updated to support multi-select.
 */
function renderVerses(verses) {
  const container = document.getElementById("search-query-verse-container");
  const noResultContainer = document.querySelector(
    ".search-query-no-verse-found-container"
  );

  if (!container) return;
  container.innerHTML = ""; // Clear previous results

  if (!verses || verses.length === 0) {
    if (noResultContainer) noResultContainer.style.display = "block";
    return;
  }

  if (noResultContainer) noResultContainer.style.display = "none";

  verses.forEach((verse) => {
    // 1. Create Row
    const row = document.createElement("div");
    row.className = "search-query-verse-container verse";
    row.dataset.verse = verse.verse;
    row.dataset.status = "ready"; // Mark ready for CSS animations

    // Dataset for unified selection + cross-tab syncing
    row.dataset.ref = verse.reference;
    row.dataset.text = verse.text;
    row.dataset.version = verse.version;

    // 2. Text Container
    const textDiv = document.createElement("div");
    textDiv.className = "search-query-verse-text";

    textDiv.innerHTML = `
      <div class="search-query-verse-reference">${verse.reference}</div>
      <div class="verse-text-content">${verse.text}</div>
    `;

    // 3. Selection state from the SHARED queue (Bible + CrossRef)
    const key = `${normalizeRef(verse.reference)}::${verse.version}`;
    const isSelected =
      window.pendingVerseAdds && window.pendingVerseAdds.has(key);

    // 4. Selection Button
    const addBtn = document.createElement("button");
    addBtn.className = "search-query-verse-add-button";

    if (isSelected) {
      addBtn.classList.add("selected");
      row.classList.add("selected-for-add");
    }

    // 5. Click Handler
    addBtn.onclick = (e) => {
      e.stopPropagation();
      toggleVerseSelection(
        {
          reference: verse.reference,
          text: verse.text,
          version: verse.version,
          verse: verse.verse,
        },
        addBtn
      );
    };

    row.appendChild(textDiv);
    row.appendChild(addBtn);
    container.appendChild(row);
  });

  // Ensure floating button visibility matches current shared queue
  updateFloatingButton();
}

/* =============================================================================
   UNIFIED SELECTION SYSTEM (Fixes Bible Search Separation)
   Paste this at the bottom of script.js to overwrite separate logic.
   ============================================================================= */

// 1. GLOBAL SHARED STATE
// All three modes will now write to these shared maps.
window.pendingVerseAdds = window.pendingVerseAdds || new Map();
window.pendingSongAdds = window.pendingSongAdds || new Map();
window.pendingInterlinearAdds = window.pendingInterlinearAdds || new Map();

// 2. UNIFIED VERSE TOGGLE
// Handles logic for BOTH Chapter View (Ref Search) AND List View (Text Search)
function toggleVerseSelection(verseData, btnElement) {
  // Create a unique key including version to prevent collisions
  const key = `${verseData.reference}::${verseData.version}`;

  if (window.pendingVerseAdds.has(key)) {
    // REMOVE
    window.pendingVerseAdds.delete(key);
    if (btnElement) btnElement.classList.remove("selected");

    // Row can be a normal verse row or an interlinear row
    const row = btnElement
      ? btnElement.closest(".search-query-verse-container, .interlinear-row")
      : null;
    if (row) row.classList.remove("selected-for-add");
  } else {
    // ADD
    window.pendingVerseAdds.set(key, verseData);
    if (btnElement) btnElement.classList.add("selected");

    const row = btnElement
      ? btnElement.closest(".search-query-verse-container, .interlinear-row")
      : null;
    if (row) row.classList.add("selected-for-add");
  }

  // Trigger the master button update
  updateFloatingAddButton();
}


// 3. UNIFIED FLOATING BUTTON UPDATE
// Counts items from ALL maps to show the total.
function updateFloatingAddButton() {
  const floatBtn = document.getElementById("floating-add-to-board-btn");
  if (!floatBtn) return;

  const vCount = window.pendingVerseAdds.size;
  const sCount = window.pendingSongAdds.size;
  const iCount = window.pendingInterlinearAdds.size;

  const total = vCount + sCount + iCount;

  if (total > 0) {
    floatBtn.style.display = "inline-flex";

    // Rebuild button content
    floatBtn.innerHTML = "";

    // Icon
    const SVG_NS = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("class", "add-to-board-icon-open");
    icon.setAttribute("viewBox", "0 -960 960 960");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      "M212-86q-53 0-89.5-36.5T86-212v-536q0-53 36.5-89.5T212-874h268v126H212v536h536v-268h126v268q0 53-36.5 89.5T748-86H212Zm207-246-87-87 329-329H560v-126h314v314H748v-101L419-332Z"
    );
    icon.appendChild(path);

    // Text
    const text = document.createElement("span");
    text.textContent = `Add ${total} Item${total !== 1 ? "s" : ""}`;

    floatBtn.appendChild(icon);
    floatBtn.appendChild(text);

    // Remove old listeners and attach the unified handler
    const newBtn = floatBtn.cloneNode(true);
    floatBtn.parentNode.replaceChild(newBtn, floatBtn);

    newBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleFloatingAddClick();
    };
  } else {
    floatBtn.style.display = "none";
  }
}

// --- BOARD ITEM LIMIT HELPERS (FREE PLAN) ---

// Count how many items are currently on the open board.
// Assumes each card has the class .board-item
function getCurrentBoardItemCount() {
  const workspace = document.getElementById("workspace");
  if (!workspace) return 0;
  return workspace.querySelectorAll(".board-item").length;
}

// Enforce per-board item limit for FREE users.
// - Pro users (window.BIBLEBOARD_IS_PRO) are unlimited.
// - Free users are limited to 100 items per board.
// - Existing items are NEVER removed.
async function ensureCanAddBatch(batchSize) {
  // Pro users: unlimited
  if (window.BIBLEBOARD_IS_PRO) return true;

  const FREE_BOARD_ITEM_LIMIT = 100;

  const currentCount = getCurrentBoardItemCount();
  const projected = currentCount + batchSize;

  // If this batch would push them over → block
  if (projected > FREE_BOARD_ITEM_LIMIT) {
    if (typeof window.openUpgradeModal === "function") {
      // Use your existing upgrade modal if available
      window.openUpgradeModal("board-items-limit");
    } else {
      // Fallback: plain alert
      alert(
        `On the free plan you can have up to ${FREE_BOARD_ITEM_LIMIT} items per board.\n` +
        `You currently have ${currentCount} item${currentCount !== 1 ? "s" : ""}, ` +
        `and you are trying to add ${batchSize} more.`
      );
    }
    return false;
  }

  return true;
}


// 4. UNIFIED "ADD TO BOARD" ACTION
// Flushes all three queues to the board at once.
async function handleFloatingAddClick() {
  // Hide UI immediately
  if (typeof clearSelection === "function") clearSelection();
  if (typeof closeInterlinearPanel === "function") closeInterlinearPanel();
  if (typeof closeSearchQuery === "function") closeSearchQuery();

  const verses = Array.from(window.pendingVerseAdds.values());
  const songs = Array.from(window.pendingSongAdds.values());
  const interlinear = Array.from(window.pendingInterlinearAdds.values());

  const totalToAdd = verses.length + songs.length + interlinear.length;
  if (totalToAdd === 0) return;

  // 🔒 Enforce free-plan limit ONLY on this bulk add
  const canAdd = await ensureCanAddBatch(totalToAdd);
  if (!canAdd) {
    // Important: do NOT clear the queues.
    // User can upgrade and click the button again.
    return;
  }

  // Clear State (we're definitely adding them now)
  window.pendingVerseAdds.clear();
  window.pendingSongAdds.clear();
  window.pendingInterlinearAdds.clear();
  updateFloatingAddButton(); // Hide button

  let delay = 0.05;

  // --- PROCESS VERSES (Group continuous ranges) ---
  if (verses.length > 0) {
    // Helper to parse "Genesis 1:1" into parts for sorting
    const parseFullRef = (ref) => {
      // Matches "Book Chapter:Verse"
      const parts = ref.match(/^(.+)\s+(\d+):(\d+)$/);
      if (!parts) return { book: ref, chapter: 0, verse: 0 };
      return {
        book: parts[1],
        chapter: parseInt(parts[2]),
        verse: parseInt(parts[3]),
      };
    };

    // Sort by VERSION first, then by Book/Chapter/Verse
    verses.sort((a, b) => {
      if (a.version < b.version) return -1;
      if (a.version > b.version) return 1;

      const ra = parseFullRef(a.reference);
      const rb = parseFullRef(b.reference);

      if (ra.book !== rb.book) return ra.book.localeCompare(rb.book);
      if (ra.chapter !== rb.chapter) return ra.chapter - rb.chapter;
      return ra.verse - rb.verse;
    });

    // Group continuous verses (same version/book/chapter, sequential verse)
    let groups = [[verses[0]]];

    for (let i = 1; i < verses.length; i++) {
      const prev =
        groups[groups.length - 1][groups[groups.length - 1].length - 1];
      const curr = verses[i];

      const prevData = parseFullRef(prev.reference);
      const currData = parseFullRef(curr.reference);

      if (
        prev.version === curr.version &&
        prevData.book === currData.book &&
        prevData.chapter === currData.chapter &&
        currData.verse === prevData.verse + 1
      ) {
        groups[groups.length - 1].push(curr);
      } else {
        groups.push([curr]);
      }
    }

    // Add Groups to Board
    groups.forEach((group) => {
      if (group.length === 1) {
        // Single verse
        const v = group[0];
        window.BoardAPI.addBibleVerse(
          v.reference,
          v.text,
          false,
          v.version,
          delay
        );
      } else {
        // Verse range
        const first = group[0];
        const last = group[group.length - 1];

        const firstData = parseFullRef(first.reference);
        const baseRef = `${firstData.book} ${firstData.chapter}`;

        const startV = firstData.verse;
        const endV = parseFullRef(last.reference).verse;

        const combinedText = group.map((v) => v.text).join(" ");

        window.BoardAPI.addBibleVerse(
          `${baseRef}:${startV}-${endV}`,
          combinedText,
          false,
          first.version,
          delay
        );
      }

      delay += 0.15;
    });
  }

  // --- ADD SONGS ---
  songs.forEach((song) => {
    window.BoardAPI.addSongElement(song, delay);
    delay += 0.15;
  });

  // --- ADD INTERLINEAR ---
  interlinear.forEach((item) => {
    window.BoardAPI.addInterlinearCard(item, delay);
    delay += 0.15;
  });
}


/* =============================================================================
   RENDERER FIXES: Ensure Lists Check the Shared Queue
   Overwrite the existing renderVerseList to make Bible Search consistent.
   ============================================================================= */

function renderVerseList(container, versesData, version) {
  if (!container || !versesData || versesData.length === 0) {
    container.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">No matching verses found.</div>`;
    return;
  }

  const verseList = document.createElement("div");
  verseList.className = "verse-list-container";

  let html = "";

  for (const verseData of versesData) {
    const fullRef = verseData.ref;
    const text = verseData.text.replace(/"/g, "&quot;");
    const displayText = cleanDisplayVerse(verseData.text);

    // --- THE FIX: Check the SHARED queue, not the old isolated one ---
    const key = `${fullRef}::${version}`;
    const isSelected = window.pendingVerseAdds.has(key);

    const selectedClass = isSelected ? "selected-for-add" : "";
    const btnSelectedClass = isSelected ? "selected" : "";

    html += `
      <div class="verse verse-card-style ${selectedClass}" 
           data-ref="${fullRef}" 
           data-version="${version}" 
           data-text="${text}">
        
        <span class="verse-number verse-ref-style">${fullRef}</span>
        <span class="verse-text verse-text-style">${displayText}</span>
        
        <button class="search-query-verse-add-button ${btnSelectedClass}" 
                aria-label="Add verse ${fullRef}">
        </button>
      </div>
    `;
  }

  verseList.innerHTML = html;
  container.innerHTML = "";
  container.appendChild(verseList);
}

// Also patch the Chapter Renderer (Reference Search) to be safe
function renderChapter(
  container,
  verses,
  targetVerse,
  refString,
  book,
  version
) {
  if (!container || !verses || verses.length === 0) {
    container.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 15px;">No matching verses found.</div>`;
    return;
  }

  const verseList = document.createElement("div");
  verseList.className = "verse-list-container";
  const chapterNum = refString.match(/\d+$/)?.[0] || "";

  verses.forEach((verse) => {
    const fullRef = `${book} ${chapterNum}:${verse.verse}`;
    const rawText = verse.text.replace(/"/g, "&quot;");
    const displayText = verse.text.replace(/^\[\d+\]\s*/, "");

    // --- THE FIX: Check shared queue ---
    const key = `${fullRef}::${version}`;
    const isSelected = window.pendingVerseAdds.has(key);

    const selectedClass = isSelected ? "selected-for-add" : "";
    const btnSelectedClass = isSelected ? "selected" : "";

    let isTarget = verse.verse == targetVerse;

    verseList.innerHTML += `
      <div class="verse ${isTarget ? "highlighted" : ""} ${selectedClass}" 
           data-verse="${verse.verse}" 
           data-ref="${fullRef}" 
           data-version="${version}" 
           data-text="${rawText}"> 
        <span class="verse-number">${verse.verse}</span>
        <span class="verse-text">${displayText}</span> 
        <button class="search-query-verse-add-button ${btnSelectedClass}" 
                aria-label="Add verse ${fullRef}">
        </button>
      </div>
    `;
  });

  container.innerHTML = "";
  container.appendChild(verseList);

  // Append copyright (reuse existing logic if available, or minimal fallback)
  const noticeText = {
    NLT: `Scripture quotations are taken from the Holy Bible, New Living Translation, copyright © 1996, 2004, 2015 by Tyndale House Foundation. Used by permission of Tyndale House Publishers, Inc., Carol Stream, Illinois 60188. All rights reserved.`,
    FBV: `The Free Bible Version is licensed under a Creative Commons Attribution-ShareAlike 4.0 International License.`,
    WEBUS: `The World English Bible is in the Public Domain.`,
    KJV: `Public Domain.`,
    ASV: `Public Domain.`,
    ESV: `Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), copyright © 2001 by Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved.`,
  }[version];

  if (noticeText) {
    const copyright = document.createElement("div");
    copyright.className = "chapter-copyright";
    copyright.innerHTML = noticeText;
    container.appendChild(copyright);
  }
}

/* ==================== GROUPING MODE LOGIC (UPDATED) ==================== */

// State
let isGroupingMode = false;
let selectedGroupItems = new Set(); // Stores HTMLElements
let isGroupDrag = false;
let groupDragOffsets = new Map();

// Helper: Inject checkbox if missing
function ensureGroupCheckbox(el) {
  if (el.querySelector(".group-checkbox")) return; // Already has one
  const check = document.createElement("div");
  check.className = "group-checkbox";
  // Allow clicking the checkbox directly to toggle
  check.addEventListener("mousedown", (e) => {
    e.stopPropagation(); // Prevent drag start
    toggleGroupSelection(el);
  });
  // Insert as first child
  el.insertBefore(check, el.firstChild);
}

// 1. Toggle the Mode
function toggleGroupingMode() {
  isGroupingMode = !isGroupingMode;
  document.body.classList.toggle("grouping-mode", isGroupingMode);

  const btn = document.getElementById("grouping-mode-btn");
  if (btn) btn.classList.toggle("active", isGroupingMode);

  if (isGroupingMode) {
    // Clear single selection to avoid confusion
    clearSelection();
  } else {
    // Turning off: clear group selection
    clearGroupSelection();
  }

  updateActionButtonsEnabled();
}

// 2. Toggle Item Selection
function toggleGroupSelection(el) {
  if (!el) return;

  if (selectedGroupItems.has(el)) {
    // Deselect
    selectedGroupItems.delete(el);
    el.classList.remove("group-selected");
  } else {
    // Select
    selectedGroupItems.add(el);
    el.classList.add("group-selected");
  }

  updateActionButtonsEnabled();
}

// 3. Clear All
function clearGroupSelection() {
  selectedGroupItems.forEach((el) => el.classList.remove("group-selected"));
  selectedGroupItems.clear();
  updateActionButtonsEnabled();
}

// Hook up the button
document.getElementById("grouping-mode-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleGroupingMode();
});



function resetVerseStudySections() {
  const interSec = document.getElementById("interlinear-section");
  const crossSec = document.getElementById("crossref-section");

  if (interSec) interSec.style.display = "none";
  if (crossSec) crossSec.style.display = "none";

  const interBtn = document.getElementById("verse-study-open-interlinear");
  const crossBtn = document.getElementById("verse-study-open-crossref");

  if (interBtn) interBtn.classList.remove("verse-study-tab-active");
  if (crossBtn) crossBtn.classList.remove("verse-study-tab-active");
}

