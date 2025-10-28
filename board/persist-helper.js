// board/persist-helper.js
(function () {
  if (!window.BoardAPI) {
    console.error("BoardAPI not found. Load persist-helper.js after script.js");
    return;
  }

  const statusBadge = document.getElementById("persistence-status");
  let debounceTimer = null;
  let saveInProgress = false;
  let pendingSave = false;
  let lastError = null;
  let retryCount = 0;
  const RETRY_SCHEDULE = [200, 500, 1200]; // ms

  /**
   * Internal debug logger
   */
  function logSave(reason, phase, ...args) {
    // console.debug(`[Save:${phase}] ${reason}`, ...args);
  }

  /**
   * Updates the #persistence-status badge
   * @param {'saving' | 'saved' | 'offline' | 'idle'} state
   * @param {string} [message]
   */
  function updateBadge(state, message = "") {
    if (!statusBadge) return;
    statusBadge.style.display = "inline-block";
    statusBadge.style.opacity = "1";
    statusBadge.style.color = "var(--muted)";
    statusBadge.style.background = "var(--bg-seethroug)";
    statusBadge.style.borderColor = "var(--fg-seethrough)";

    switch (state) {
      case 'saving':
        statusBadge.textContent = "Saving...";
        break;
      case 'saved':
        statusBadge.textContent = "Saved";
        statusBadge.style.color = "var(--accent)";
        statusBadge.style.borderColor = "var(--accent)";
        // Fade out after a bit
        setTimeout(() => { 
            if (statusBadge.textContent === "Saved") {
              statusBadge.style.opacity = "0"; 
            }
        }, 2000);
        break;
      case 'offline':
        statusBadge.textContent = message || "Offline";
        statusBadge.style.color = "#e55353";
        statusBadge.style.borderColor = "#e55353";
        break;
      case 'idle':
        statusBadge.style.opacity = "0";
        setTimeout(() => { 
            if (statusBadge.style.opacity === "0") {
              statusBadge.style.display = "none"; 
            }
        }, 300);
        break;
    }
  }

  /**
   * The core save function. Coalesces saves if one is already in progress.
   * @param {string} reason
   */
  async function performSave(reason) {
    // Guard: Don't save if the persistence layer isn't hooked up
    if (window.BoardAPI.saveBoard === null) {
      logSave(reason, "skip", "saveBoard not implemented");
      updateBadge('offline', 'Not Connected');
      return;
    }
    
    // Guard: If a save is already running, queue this one for after
    if (saveInProgress) {
      pendingSave = true;
      logSave(reason, "queue");
      return;
    }

    saveInProgress = true;
    pendingSave = false;
    lastError = null;
    updateBadge('saving');
    logSave(reason, 'start');

    try {
      const payload = window.BoardAPI.serializeBoard();
      if (!payload) throw new Error("Serialization failed");

      // The actual async save call to the external module
      await window.BoardAPI.saveBoard(payload); 

      logSave(reason, 'success');
      updateBadge('saved');
      retryCount = 0; // Success, reset retry
      
    } catch (err) {
      lastError = err;
      logSave(reason, 'fail', err);
      
      // Basic exponential backoff retry
      if (retryCount < RETRY_SCHEDULE.length) {
        const delay = RETRY_SCHEDULE[retryCount];
        retryCount++;
        updateBadge('offline', `Offline. Retry in ${delay/1000}s...`);
        setTimeout(() => performSave(`retry_${retryCount}`), delay);
      } else {
        updateBadge('offline', 'Offline. Save failed.');
      }
    } finally {
      saveInProgress = false;
      if (pendingSave) {
        // A mutation happened *during* the save. Trigger another one.
        triggerAutosave('coalesced_save');
      }
    }
  }

  /**
   * Debounced save trigger. This is the main entry point.
   * @param {string} reason
   */
  function triggerAutosave(reason = "unknown_mutation") {
    if (window.__RESTORING_FROM_SUPABASE) {
      logSave(reason, "skip", "Restoring");
      return;
    }
    
    clearTimeout(debounceTimer);
    updateBadge('saving'); // Show "Saving..." immediately on schedule
    
    debounceTimer = setTimeout(() => {
      performSave(reason);
    }, 1200); // 1.2 second debounce
  }

  /**
   * Immediately performs a save, bypassing the debounce.
   * @param {string} reason
   */
  function forceFlushSave(reason = "flush") {
    clearTimeout(debounceTimer);
    logSave(reason, 'force_flush');
    // Don't await, just run. beforeunload has no time.
    performSave(reason);
  }

  // --- Export to BoardAPI ---
  // Overwrite the null/placeholder functions in script.js
  window.BoardAPI.triggerAutosave = triggerAutosave;
  window.BoardAPI.forceFlushSave = forceFlushSave;

  // --- Add global listeners for flush-on-exit ---
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      forceFlushSave('visibility_hidden');
    }
  }, { passive: true });

  window.addEventListener('beforeunload', (e) => {
    // This is a best-effort attempt.
    // We can't use async/await here.
    forceFlushSave('beforeunload');
    
    // If a save is in progress, alert the user (standard browser behavior)
    if (saveInProgress || pendingSave) {
      const msg = 'Your latest changes are still saving. Are you sure you want to leave?';
      e.preventDefault(); 
      e.returnValue = msg;
      return msg;
    }
  });

  logSave("init", "ready");
  updateBadge('idle');

})();