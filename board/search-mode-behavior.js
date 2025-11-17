
/**
 * Bible Board — Search Mode Header + Defaulting Logic (+ Interlinear sync)
 * Drop this file AFTER script.js in index.html.
 *
 * Update: ALWAYS show `Search for "<query>"` as the header text when a query exists,
 * regardless of the active search mode (Bible / Songs / Interlinear).
 * Defaults to mode-specific labels only when the query is empty.
 */
(function () {
  const searchQueryEl = document.getElementById("search-query");
  const searchBar = document.getElementById("search-bar");

  const pillBible = document.getElementById("search-mode-bible");
  const pillSongs = document.getElementById("search-mode-songs");
  const pillInter = document.getElementById("search-mode-interlinear");

  let lastRawQuery = "";
  let lastKnownDrawerOpen = !!window.searchDrawerOpen;

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
    if (q) return `Search for "${q}"`; // <-- always this when query exists
    // only when empty, show mode defaults
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

  function updateInterlinearForCurrentQuery() {
    const mode = getMode();
    if (mode !== "interlinear") return;

    const ref = parseReferenceString(lastRawQuery);
    if (ref && typeof window.openInterlinearForReference === "function") {
      if (!window.searchDrawerOpen) {
        window.searchDrawerOpen = true;
        try { window.applyLayout?.(true); } catch {}
      }
      try { window.setSearchMode?.("interlinear", { openDrawer: true }); } catch {}
      window.openInterlinearForReference(`${ref.book} ${ref.chapter}:${ref.verse}`);
    } else {
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
      if (!window.searchDrawerOpen) {
        window.searchDrawerOpen = true;
        try { window.applyLayout?.(true); } catch {}
      }
      try { window.setSearchMode?.("interlinear", { openDrawer: true }); } catch {}
    }
  }

  // --- Wire up events --------------------------------------------------------

  // Capture query when user presses Enter in the search bar
  searchBar?.addEventListener("keydown", (e) => {
    window.BBSearchHeader && (window.BBSearchHeader.__lastRawQuery = (searchBar?.value||"").trim());
    if (e.key === "Enter") {
      lastRawQuery = (searchBar.value || "").trim();
      setTimeout(() => { updateHeader(); updateInterlinearForCurrentQuery(); }, 0);
    }
  });

  // Public hook
  window.BBSearchHeader = {
    setRawQuery(q) {
      this.__lastRawQuery = q || "";
      lastRawQuery = q || "";
      updateHeader();
      updateInterlinearForCurrentQuery();
    },
    refresh() {
      updateHeader();
      updateInterlinearForCurrentQuery();
    },
  };

  // Update when user switches pills (even without changing the query)
  pillBible?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); /* interlinear hidden via setSearchMode */ }, 0);
  });
  pillSongs?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); /* interlinear hidden via setSearchMode */ }, 0);
  });
  pillInter?.addEventListener("click", () => {
    setTimeout(() => { updateHeader(); updateInterlinearForCurrentQuery(); }, 0);
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
      updateInterlinearForCurrentQuery();
    } catch (_) {}
    return res;
  };

  // Initial
  updateHeader();
  updateInterlinearForCurrentQuery();
})();
