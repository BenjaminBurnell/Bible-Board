/**
 * Bible Board — Search Mode Header + Defaulting Logic (+ Interlinear/Crossref sync)
 * Drop this file AFTER script.js in index.html.
 *
 * Update: OPTIMIZED V4 - Eager Prefetching.
 * Triggers downloads immediately on search so data is ready when tab is clicked.
 */
(function () {
  const searchQueryEl = document.getElementById("search-query");
  const searchBar = document.getElementById("search-bar");

  const pillBible = document.getElementById("search-mode-bible");
  const pillSongs = document.getElementById("search-mode-songs");
  const pillInter = document.getElementById("search-mode-interlinear");
  const pillCrossref = document.getElementById("search-mode-cross-reference");

  let lastRawQuery = "";
  let lastKnownDrawerOpen = !!window.searchDrawerOpen;
  
  // --- CACHING ---
  // Stores Promises so we can track requests that are currently "in-flight"
  const crossRefCache = new Map(); // Key -> Promise<HTMLString>
  let lastFetchedInterlinearRef = null; 

  // --- Helpers ---------------------------------------------------------------
  function parseReferenceString(refStr) {
    if (!refStr) return null;
    let s = String(refStr)
      .replace(/\(.*?\)/g, "")
      .replace(/[“”"']/g, "")
      .trim();
    const m = s.match(/^([\dI]{0,3}\s*[A-Za-z .'-]+?)\s+(\d+):(\d+)$/);
    if (!m) return null;
    const book = m[1].trim();
    const chapter = parseInt(m[2], 10);
    const verse = parseInt(m[3], 10);
    if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) return null;
    return { book, chapter, verse };
  }

  function headerTextFor(mode, raw) {
    const q = (raw || "").trim();
    if (q) return `Search for "${q}"`;
    if (mode === "bible") return "Bible";
    if (mode === "songs") return "Search songs";
    if (mode === "interlinear") return "Interlinear";
    if (mode === "crossref") return "Cross References";
    return "";
  }

  function getMode() {
    return window.currentSearchMode || "bible";
  }

  function setModeWithoutOpeningDrawer(mode) {
    const m = mode || "bible";
    const pills = {
      bible: pillBible,
      songs: pillSongs,
      interlinear: pillInter,
      crossref: pillCrossref,
    };

    Object.values(pills).forEach(p => p?.classList.remove("active"));
    pills[m]?.classList.add("active");

    window.currentSearchMode = m;

    const containers = {
      bible: document.getElementById("search-query-bible"),
      songs: document.getElementById("search-query-songs"),
      interlinear: document.getElementById("search-query-interlinear"),
      crossref: document.getElementById("search-query-crossref"),
    };

    Object.values(containers).forEach(c => c && (c.style.display = "none"));
    if (containers[m]) containers[m].style.display = "block";
  }

  function updateHeader() {
    if (!searchQueryEl) return;
    const mode = getMode();
    searchQueryEl.textContent = headerTextFor(mode, lastRawQuery);
  }

  /**
   * INTERLINEAR LOGIC
   */
  function updateInterlinearForCurrentQuery(force = false) {
    const mode = getMode();
    if (mode !== "interlinear") return;

    const ref = parseReferenceString(lastRawQuery);
    if (!ref) {
      renderInterlinearError(lastRawQuery ? `No interlinear for "${lastRawQuery}"` : "No interlinear.");
      openDrawerUI();
      return;
    }

    const currentRefString = `${ref.book} ${ref.chapter}:${ref.verse}`.toLowerCase();
    if (!force && currentRefString === lastFetchedInterlinearRef) {
      openDrawerUI(); 
      return; 
    }
    lastFetchedInterlinearRef = currentRefString;

    if (typeof window.openInterlinearForReference === "function") {
      openDrawerUI();
      window.openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
    }
  }

  function renderInterlinearError(msg) {
      const interList = document.getElementById("interlinear-list");
      const interLoader = document.getElementById("interlinear-loader");
      const interError = document.getElementById("interlinear-error");
      
      if (interLoader) interLoader.style.display = "none";
      if (interError) interError.style.display = "none";
      if (interList) {
        interList.innerHTML = `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">${msg}</div>`;
      }
  }

  /**
   * CROSS REFERENCE LOGIC (Prefetched)
   */

  // 1. Triggers the fetch immediately (background)
  function prefetchCrossReferences(rawQuery) {
    const ref = parseReferenceString(rawQuery);
    if (!ref) return;

    const refKey = `${ref.book} ${ref.chapter}:${ref.verse}`.toLowerCase();

    // If already cached (or fetching), ignore
    if (crossRefCache.has(refKey)) return;

    console.log(`[Crossref] Prefetch started for: ${refKey}`);
    
    // Store the Promise immediately
    const fetchPromise = fetchFastCrossReferences(ref)
      .then(html => html)
      .catch(err => {
        console.error(err);
        return `<div class="crossref-empty-message">Could not load references.</div>`;
      });
    
    crossRefCache.set(refKey, fetchPromise);
  }

  // 2. Updates the UI when the tab is actually clicked
  async function updateCrossReferencesForCurrentQuery(force = false) {
    const mode = getMode();
    if (mode !== "crossref") return;

    const container = document.getElementById("search-query-crossref-container");
    if (!container) return;

    const ref = parseReferenceString(lastRawQuery);
    if (!ref) {
      container.innerHTML = `<div class="crossref-empty-message">Please enter a specific verse (e.g., "John 3:16") to see cross-references.</div>`;
      openDrawerUI();
      return;
    }

    const refKey = `${ref.book} ${ref.chapter}:${ref.verse}`.toLowerCase();

    // Check Cache (It contains Promises)
    if (crossRefCache.has(refKey)) {
      
      // If the promise is already resolved, this will be instant.
      // If it's still running, we wait for it.
      
      // Show a loader ONLY if it's taking time (optional, but good UX)
      container.innerHTML = `
        <div style="padding:20px; text-align:center; color:var(--muted);">
           <div class="loader-spinner" style="margin:0 auto 10px auto;"></div>
           Finding connections...
        </div>
      `;
      openDrawerUI();

      try {
        const html = await crossRefCache.get(refKey);
        container.innerHTML = html;
      } catch (err) {
        container.innerHTML = `<div class="crossref-empty-message">Error loading data.</div>`;
      }
      return;
    }

    // Fallback: If for some reason it wasn't prefetched, fetch now.
    prefetchCrossReferences(lastRawQuery);
    updateCrossReferencesForCurrentQuery(false); // recurse once
  }

  /**
   * Parallel Fetcher (The actual network work)
   */
  async function fetchFastCrossReferences(sourceRef) {
    const book = sourceRef.book.toLowerCase();
    let relatedRefs = [];

    // Simple mapping for demo/speed
    if (book.includes("gen")) relatedRefs = ["John 1:1", "Hebrews 11:3", "Psalm 33:6", "Romans 1:20", "2 Peter 3:5"];
    else if (book.includes("john")) relatedRefs = ["Genesis 1:1", "Colossians 1:16", "1 John 1:1", "Hebrews 1:2", "Isaiah 9:6"];
    else if (book.includes("rom")) relatedRefs = ["Habakkuk 2:4", "Galatians 3:11", "Hebrews 10:38", "Ephesians 2:8", "Titus 3:5"];
    else relatedRefs = ["Genesis 1:1", "John 3:16", "Psalm 23:1", "Revelation 22:21", "Matthew 5:14"];

    // Fetch ALL at once
    const promises = relatedRefs.map(async (refStr) => {
      try {
        const res = await fetch(`https://bible-api.com/${encodeURIComponent(refStr)}?translation=kjv`);
        const data = await res.json();
        return { ref: data.reference, text: data.text.trim() };
      } catch (e) { return null; }
    });

    const results = await Promise.all(promises);
    const validResults = results.filter(r => r !== null);
    
    if (validResults.length === 0) return `<div class="crossref-empty-message">No cross-references found.</div>`;

    return validResults.map(item => `
        <div class="search-query-verse-container crossref-row">
            <div class="crossref-main">
                <div class="crossref-ref">${item.ref}</div>
                <div class="crossref-text">${item.text}</div>
            </div>
            <button class="search-query-verse-add-button" onclick="window.BoardAPI.addBibleVerse('${item.ref}', '${item.text.replace(/'/g, "\\'")}')">
              <span class="material-symbols-outlined">add</span>
            </button>
        </div>
    `).join("");
  }


  // --- Wire up events --------------------------------------------------------

  searchBar?.addEventListener("keydown", (e) => {
    window.BBSearchHeader && (window.BBSearchHeader.__lastRawQuery = (searchBar?.value||"").trim());
    if (e.key === "Enter") {
      lastRawQuery = (searchBar.value || "").trim();
      
      // NEW: Trigger Prefetch IMMEDIATELY
      prefetchCrossReferences(lastRawQuery);

      setTimeout(() => { 
        updateHeader(); 
        updateInterlinearForCurrentQuery(true);
        // We still call this to update UI if the tab is ALREADY open
        updateCrossReferencesForCurrentQuery(true);
      }, 0);
    }
  });

  window.BBSearchHeader = {
    setRawQuery(q) {
      this.__lastRawQuery = q || "";
      lastRawQuery = q || "";
      
      // Prefetch here too
      prefetchCrossReferences(lastRawQuery);

      updateHeader();
      updateInterlinearForCurrentQuery(true); 
      updateCrossReferencesForCurrentQuery(true);
    },
    refresh() {
      updateHeader();
      updateInterlinearForCurrentQuery(false);
      updateCrossReferencesForCurrentQuery(false);
    },
  };

  pillBible?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); }, 0);
  });
  pillSongs?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); }, 0);
  });
  pillInter?.addEventListener("click", () => {
    setTimeout(() => { 
      updateHeader(); 
      updateInterlinearForCurrentQuery(false); 
    }, 0);
  });
  
  // When clicking Cross Ref pill, data should already be there!
  pillCrossref?.addEventListener("click", () => {
    setTimeout(() => { 
      updateHeader(); 
      updateCrossReferencesForCurrentQuery(false); 
    }, 0);
  });

  updateHeader();
})();