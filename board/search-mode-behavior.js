/**
 * Bible Board — Search Mode Header + Defaulting Logic (+ Interlinear sync)
 * Drop this file AFTER script.js in index.html.
 *
 * Update: Prevents re-fetching Interlinear data if the reference hasn't changed.
 */
(function () {
  const searchQueryEl = document.getElementById("search-query");
  const searchBar = document.getElementById("search-bar");

  const pillBible = document.getElementById("search-mode-bible");
  const pillSongs = document.getElementById("search-mode-songs");
  const pillInter = document.getElementById("search-mode-interlinear");

  let lastRawQuery = "";
  let lastKnownDrawerOpen = !!window.searchDrawerOpen;
  
  // NEW: Track the last reference we successfully fetched to prevent spam
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
    return "";
  }

  function getMode() {
    return window.currentSearchMode || "bible";
  }

  function setModeWithoutOpeningDrawer(mode) {
    const m = mode || "bible";
    pillBible?.classList.toggle("active", m === "bible");
    pillSongs?.classList.toggle("active", m === "songs");
    pillInter?.classList.toggle("active", m === "interlinear");
    window.currentSearchMode = m;
  }

  function updateHeader() {
    if (!searchQueryEl) return;
    const mode = getMode();
    searchQueryEl.textContent = headerTextFor(mode, lastRawQuery);
  }

  /**
   * UPDATED: Logic to fetch interlinear only when necessary
   * @param {boolean} force - If true, ignores the cache and forces a fetch (used on Enter key)
   */
  function updateInterlinearForCurrentQuery(force = false) {
    const mode = getMode();
    if (mode !== "interlinear") return;

    const ref = parseReferenceString(lastRawQuery);

    // If query is invalid reference, show "No interlinear" state
    if (!ref) {
      const interList = document.getElementById("interlinear-list");
      const interLoader = document.getElementById("interlinear-loader");
      const interError = document.getElementById("interlinear-error");
      const interPanel = document.getElementById("interlinear-panel");
      
      if (interPanel) interPanel.setAttribute("aria-busy", "false");
      if (interLoader) interLoader.style.display = "none";
      if (interError) interError.style.display = "none";
      
      if (interList) {
        const q = (lastRawQuery || "").trim();
        interList.innerHTML = q
          ? `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear for "${q}".</div>`
          : `<div class="search-query-no-verse-found-container" style="text-align:center; color:var(--muted); padding: 12px;">No interlinear.</div>`;
      }
      openDrawerUI();
      return;
    }

    // Construct a canonical string (e.g., "john 3:16") to compare against cache
    const currentRefString = `${ref.book} ${ref.chapter}:${ref.verse}`.toLowerCase();

    // CHECK: If we aren't forcing a refresh, and we already fetched this ref, STOP.
    if (!force && currentRefString === lastFetchedInterlinearRef) {
      openDrawerUI(); // Just ensure the UI is open
      return; 
    }

    // Update cache
    lastFetchedInterlinearRef = currentRefString;

    // Perform Fetch
    if (typeof window.openInterlinearForReference === "function") {
      openDrawerUI();
      window.openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
    }
  }

  function openDrawerUI() {
    if (!window.searchDrawerOpen) {
      window.searchDrawerOpen = true;
      try { window.applyLayout?.(true); } catch {}
    }
    try { window.setSearchMode?.("interlinear", { openDrawer: true }); } catch {}
  }

  // --- Wire up events --------------------------------------------------------

  // Capture query when user presses Enter in the search bar
  searchBar?.addEventListener("keydown", (e) => {
    window.BBSearchHeader && (window.BBSearchHeader.__lastRawQuery = (searchBar?.value||"").trim());
    if (e.key === "Enter") {
      lastRawQuery = (searchBar.value || "").trim();
      setTimeout(() => { 
        updateHeader(); 
        // Force = true because user explicitly hit Enter to search
        updateInterlinearForCurrentQuery(true); 
      }, 0);
    }
  });

  // Public hook
  window.BBSearchHeader = {
    setRawQuery(q) {
      this.__lastRawQuery = q || "";
      lastRawQuery = q || "";
      updateHeader();
      updateInterlinearForCurrentQuery(true); // External set usually implies a new search
    },
    refresh() {
      updateHeader();
      updateInterlinearForCurrentQuery(false);
    },
  };

  // Update when user switches pills
  pillBible?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); }, 0);
  });
  pillSongs?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); }, 0);
  });
  
  pillInter?.addEventListener("click", () => {
    setTimeout(() => { 
      updateHeader(); 
      // Force = false. Only fetch if the query changed since last time we were here.
      updateInterlinearForCurrentQuery(false); 
    }, 0);
  });

  // Patch applyLayout to default Bible when drawer closes
  const _applyLayout = window.applyLayout;
  window.applyLayout = function patchedApplyLayout(withTransition) {
    const res = _applyLayout?.call(this, withTransition);
    try {
      const isOpen = !!window.searchDrawerOpen;
      if (isOpen !== lastKnownDrawerOpen) {
        lastKnownDrawerOpen = isOpen;
        if (!isOpen) {
          setModeWithoutOpeningDrawer("bible");
        }
      }
      updateHeader();
      // Don't auto-fetch interlinear just on layout change unless visible
      if (getMode() === "interlinear" && isOpen) {
         updateInterlinearForCurrentQuery(false);
      }
    } catch (_) {}
    return res;
  };

  // Initial load
  updateHeader();
})();