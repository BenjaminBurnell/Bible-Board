// board/persist-helper.js
// OPTIMIZATION: No changes needed. This file correctly debounces
// the save triggers. The problem was in script.js calling
// triggerAutosave (via onBoardMutated) too frequently, which
// has been fixed in the optimized script.js.

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
      case "saving":
        statusBadge.textContent = "Saving...";
        break;
      case "saved":
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
      case "offline":
        statusBadge.textContent = message || "Offline";
        statusBadge.style.color = "#e55353";
        statusBadge.style.borderColor = "#e55353";
        break;
      case "idle":
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
    // NEW: if the current board is being deleted, do NOT save it again
    if (window.__BOARD_BEING_DELETED__) {
      console.log(
        "[Persist] SKIP performSave because board is being deleted:",
        reason
      );
      logSave(reason, "skip", "board_being_deleted");
      updateBadge("idle");
      return;
    }

    // Guard: Don't save if the persistence layer isn't hooked up
    if (window.BoardAPI.saveBoard === null) {
      logSave(reason, "skip", "saveBoard not implemented");
      updateBadge("offline", "Not Connected");
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
    updateBadge("saving");
    logSave(reason, "start");

    try {
      const payload = window.BoardAPI.serializeBoard();
      if (!payload) throw new Error("Serialization failed");

      console.log("[Persist][save] about to save board", {
        reason,
        boardId: window.BOARD_ID || window.__CURRENT_BOARD_ID || null,
        title: payload.title,
      });

      // The actual async save call to the external module
      await window.BoardAPI.saveBoard(payload);


      logSave(reason, "success");
      updateBadge("saved");
      retryCount = 0; // Success, reset retry
    } catch (err) {
      lastError = err;
      logSave(reason, "fail", err);

      // Basic exponential backoff retry
      if (retryCount < RETRY_SCHEDULE.length) {
        const delay = RETRY_SCHEDULE[retryCount];
        retryCount++;
        updateBadge("offline", `Offline. Retry in ${delay / 1000}s...`);
        setTimeout(() => performSave(`retry_${retryCount}`), delay);
      } else {
        updateBadge("offline", "Offline. Save failed.");
      }
    } finally {
      saveInProgress = false;
      if (pendingSave) {
        // A mutation happened *during* the save. Trigger another one.
        triggerAutosave("coalesced_save");
      }
    }
  }

  /**
   * Debounced save trigger. This is the main entry point.
   * @param {string} reason
   */
  function triggerAutosave(reason = "unknown_mutation") {
    console.log("[Persist] triggerAutosave called:", reason, {
      restoring: window.__RESTORING_FROM_SUPABASE,
      deletingFlag: window.__BOARD_BEING_DELETED__,
    });

    if (window.__RESTORING_FROM_SUPABASE) {
      logSave(reason, "skip", "Restoring");
      return;
    }

    // NEW: ignore autosave while a board is being deleted
    if (window.__BOARD_BEING_DELETED__) {
      logSave(reason, "skip", "board_being_deleted");
      console.log(
        "[Persist] SKIP triggerAutosave because board is being deleted"
      );
      return;
    }

    clearTimeout(debounceTimer);
    updateBadge("saving");
    debounceTimer = setTimeout(() => {
      performSave(reason);
    }, 1200);
  }



  /**
   * Immediately performs a save, bypassing the debounce.
   * @param {string} reason
   */
  function forceFlushSave(reason = "flush") {
    console.log("[Persist] forceFlushSave called:", reason, {
      deletingFlag: window.__BOARD_BEING_DELETED__,
    });

    // NEW: don't flush saves while deleting
    if (window.__BOARD_BEING_DELETED__) {
      logSave(reason, "skip", "board_being_deleted");
      console.log(
        "[Persist] SKIP forceFlushSave because board is being deleted"
      );
      return;
    }

    clearTimeout(debounceTimer);
    logSave(reason, "force_flush");
    performSave(reason);
  }


  // --- Export to BoardAPI ---
  // Overwrite the null/placeholder functions in script.js
  window.BoardAPI.triggerAutosave = triggerAutosave;
  window.BoardAPI.forceFlushSave = forceFlushSave;

  // --- Add global listeners for flush-on-exit ---
  window.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        forceFlushSave("visibility_hidden");
      }
    },
    { passive: true }
  );

  window.addEventListener("beforeunload", (e) => {
    // Best-effort attempt; can’t reliably block navigation in modern browsers
    forceFlushSave("beforeunload");
  });

  logSave("init", "ready");
  updateBadge("idle");
})();
