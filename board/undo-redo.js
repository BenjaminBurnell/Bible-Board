// board/undo-redo.js

/**
 * A self-contained object to manage all undo/redo logic.
 * V2: Includes support for element add/delete.
 */
window.UndoRedoManager = {
  // --- State ---
  undoStack: [],
  redoStack: [],
  isApplyingHistory: false, // Guard flag

  // --- DOM & Script Refs ---
  undoBtn: null,
  redoBtn: null,

  // --- Original API Refs ---
  originalConnectItems: null,
  originalDisconnectLine: null,
  originalAddBibleVerse: null,
  originalAddTextNote: null,
  originalAddInterlinearCard: null,
  originalAddSongElement: null,
  originalDeleteItem: null,

  // --- API Accessors ---
  getGlobalConnections: () => [],
  itemKey: () => null,

  /**
   * Finds a DOM element by its vkey.
   * @param {string} key The vkey.
   * @returns {HTMLElement | null}
   */
  findElementByKey(key) {
    if (!key) return null;
    return document.querySelector(`[data-vkey="${key}"]`);
  },

  /**
   * Finds a connection from the global array by its path element.
   * @param {SVGPathElement} path
   * @returns {object | null} The connection object { path, itemA, itemB }
   */
  findConnectionByPath(path) {
    const connections = this.getGlobalConnections();
    if (!connections) return null;
    return connections.find((c) => c.path === path);
  },

  /**
   * Finds a connection from the global array by its endpoint keys.
   * @param {string} aKey
   * @param {string} bKey
   * @returns {object | null} The connection object { path, itemA, itemB }
   */
  findConnectionByKeys(aKey, bKey) {
    const connections = this.getGlobalConnections();
    if (!connections || !this.itemKey || !aKey || !bKey) return null;

    return connections.find((c) => {
      if (!c || !c.itemA || !c.itemB) return false;
      const cKeyA = this.itemKey(c.itemA);
      const cKeyB = this.itemKey(c.itemB);
      return (
        (cKeyA === aKey && cKeyB === bKey) || (cKeyA === bKey && cKeyB === aKey)
      );
    });
  },

  /**
   * Updates the enabled/disabled state of the undo/redo buttons.
   */
  refreshUndoRedoButtons() {
    if (!this.undoBtn || !this.redoBtn) return;
    const readOnly = !!window.__readOnly;
    this.undoBtn.disabled = this.undoStack.length === 0 || readOnly;
    this.redoBtn.disabled = this.redoStack.length === 0 || readOnly;
  },

  // =================================================================
  // --- Snapshot & Restore Helpers ---
  // =================================================================

  /**
   * Captures the state of a board element for restoration.
   * @param {HTMLElement} el The board item.
   * @returns {object | null} A serializable snapshot.
   */
  snapshotElement(el) {
    if (!el || !el.dataset) return null;

    const snapshot = {
      vkey: this.itemKey(el),
      type: el.dataset.type || "unknown",
      style: {
        left: el.style.left,
        top: el.style.top,
        zIndex: el.style.zIndex || "10",
      },
      // Store all data attributes, as creators use them
      dataset: { ...el.dataset },
      // Specifically capture live text from notes
      liveText: null,
    };

    if (snapshot.type === "note") {
      const textEl = el.querySelector(".text-content");
      snapshot.liveText = textEl ? textEl.innerHTML : "";
    }

    return snapshot;
  },

  /**
   * Captures all connections for a given element key.
   * @param {string} key The vkey of the element.
   * @returns {Array<{aKey: string, bKey: string}>}
   */
  snapshotConnectionsForElement(key) {
    if (!key) return [];
    const connections = this.getGlobalConnections();
    const related = [];
    for (const c of connections) {
      if (!c || !c.itemA || !c.itemB) continue;
      const aKey = this.itemKey(c.itemA);
      const bKey = this.itemKey(c.itemB);
      if (aKey === key || bKey === key) {
        related.push({ aKey, bKey });
      }
    }
    return related;
  },

  /**
   * Re-creates an element from a snapshot using the *original* API functions.
   * Does NOT set isApplyingHistory; the caller must.
   * @param {object} snapshot The snapshot object.
   * @returns {HTMLElement | null} The restored element.
   */
  restoreElementFromSnapshot(snapshot) {
    if (!snapshot) return null;

    let el = null;
    const data = snapshot.dataset || {};

    try {
      switch (snapshot.type) {
        case "verse":
          el = this.originalAddBibleVerse(
            data.reference,
            data.text,
            true, // createdFromLoad = true
            data.version
          );
          break;
        case "note":
          // Use the live text if available, fallback to dataset
          const noteText = snapshot.liveText || data.text || "";
          el = this.originalAddTextNote(noteText);
          break;
        case "song":
          el = this.originalAddSongElement({
            title: data.title,
            artist: data.artist,
            cover: data.cover,
          });
          break;
        case "interlinear":
          el = this.originalAddInterlinearCard({
            surface: data.surface,
            english: data.english,
            translit: data.translit,
            morph: data.morph,
            strong: data.strong,
            reference: data.reference,
          });
          break;
        default:
          console.warn("Undo/Redo: Unknown element type to restore:", snapshot.type);
      }

      if (el) {
        // Restore position and key
        el.style.left = snapshot.style.left;
        el.style.top = snapshot.style.top;
        el.style.zIndex = snapshot.style.zIndex;
        el.dataset.vkey = snapshot.vkey; // Restore the exact key
      }
      return el;
    } catch (e) {
      console.error("Undo/Redo: Failed to restore element:", e);
      return null;
    }
  },

  /**
   * Re-creates connections from a list.
   * Does NOT set isApplyingHistory; the caller must.
   * @param {Array<{aKey: string, bKey: string}>} connections
   */
  restoreConnections(connections) {
    if (!connections || connections.length === 0) return;

    connections.forEach(({ aKey, bKey }) => {
      const elA = this.findElementByKey(aKey);
      const elB = this.findElementByKey(bKey);
      if (elA && elB) {
        // Call the *wrapped* connectItems.
        // The isApplyingHistory flag (set by the caller)
        // will prevent this from being re-recorded.
        window.BoardAPI.connectItems(elA, elB);
      }
    });
  },

  // =================================================================
  // --- Undo / Redo Handlers ---
  // =================================================================

  /**
   * Performs the Undo operation.
   */
  handleUndo() {
    if (this.isApplyingHistory || !!window.__readOnly || this.undoStack.length === 0) {
      return;
    }

    this.isApplyingHistory = true;
    const action = this.undoStack.pop();

    try {
      if (action.kind === "connection_add") {
        const conn = this.findConnectionByKeys(action.aKey, action.bKey);
        if (conn) {
          // Call public, wrapped API
          window.BoardAPI.disconnectLine(conn.path);
          this.redoStack.push(action);
        }
      } else if (action.kind === "connection_remove") {
        const elA = this.findElementByKey(action.aKey);
        const elB = this.findElementByKey(action.bKey);
        if (elA && elB) {
          // Call public, wrapped API
          window.BoardAPI.connectItems(elA, elB);
          this.redoStack.push(action);
        }
      } else if (action.kind === "element_add") {
        // Undo an add = delete the element
        const el = this.findElementByKey(action.key);
        if (el) {
          // Call public, wrapped API
          window.BoardAPI.deleteItem(el);
          this.redoStack.push(action);
        }
      } else if (action.kind === "element_delete") {
        // Undo a delete = restore element + connections
        const el = this.restoreElementFromSnapshot(action.snapshot);
        if (el) {
          // Restore connections (this calls wrapped API)
          this.restoreConnections(action.connections);
          this.redoStack.push(action);
        }
      }
    } catch (e) {
      console.error("Undo failed:", e);
    }

    this.isApplyingHistory = false;
    this.refreshUndoRedoButtons();
  },

  /**
   * Performs the Redo operation.
   */
  handleRedo() {
    if (this.isApplyingHistory || !!window.__readOnly || this.redoStack.length === 0) {
      return;
    }

    this.isApplyingHistory = true;
    const action = this.redoStack.pop();

    try {
      if (action.kind === "connection_add") {
        const elA = this.findElementByKey(action.aKey);
        const elB = this.findElementByKey(action.bKey);
        if (elA && elB) {
          // Call public, wrapped API
          window.BoardAPI.connectItems(elA, elB);
          this.undoStack.push(action);
        }
      } else if (action.kind === "connection_remove") {
        const conn = this.findConnectionByKeys(action.aKey, action.bKey);
        if (conn) {
          // Call public, wrapped API
          window.BoardAPI.disconnectLine(conn.path);
          this.undoStack.push(action);
        }
      } else if (action.kind === "element_add") {
        // Redo an add = restore the element
        const el = this.restoreElementFromSnapshot(action.snapshot);
        if (el) {
          this.undoStack.push(action);
        }
      } else if (action.kind === "element_delete") {
        // Redo a delete = delete the element again
        const el = this.findElementByKey(action.key);
        if (el) {
          // Call public, wrapped API
          window.BoardAPI.deleteItem(el);
          this.undoStack.push(action);
        }
      }
    } catch (e) {
      console.error("Redo failed:", e);
    }

    this.isApplyingHistory = false;
    this.refreshUndoRedoButtons();
  },

  // =================================================================
  // --- Initialization & API Wrapping ---
  // =================================================================

  /**
   * The main initialization function.
   * This is called by the poller ONLY when all dependencies are ready.
   * @param {object} api The window.BoardAPI object.
   */
  initAndWrap(api) {
    // 1. --- Store references ---
    this.originalConnectItems = api.connectItems;
    this.originalDisconnectLine = api.disconnectLine;
    this.originalAddBibleVerse = api.addBibleVerse;
    this.originalAddTextNote = api.addTextNote;
    this.originalAddInterlinearCard = api.addInterlinearCard;
    this.originalAddSongElement = api.addSongElement;
    this.originalDeleteItem = api.deleteItem;

    this.itemKey = api.itemKey;
    this.getGlobalConnections = api.getConnections;

    // 2. --- Wrap (Monkey-Patch) connectItems ---
    const self = this; // Keep manager's context
    api.connectItems = function (a, b) {
      const shouldRecord =
        !self.isApplyingHistory &&
        !window.__readOnly &&
        !window.__RESTORING_FROM_SUPABASE &&
        a &&
        b;

      let keyA, keyB, existsBefore;
      if (shouldRecord) {
        keyA = self.itemKey(a);
        keyB = self.itemKey(b);
        existsBefore = !!self.findConnectionByKeys(keyA, keyB);
      }

      // Run the original function
      self.originalConnectItems(a, b);

      if (shouldRecord && !existsBefore) {
        const existsAfter = !!self.findConnectionByKeys(keyA, keyB);
        if (existsAfter) {
          self.undoStack.push({ kind: "connection_add", aKey: keyA, bKey: keyB });
          self.redoStack.length = 0; // Clear redo stack
          self.refreshUndoRedoButtons();
        }
      }
    };

    // 3. --- Wrap (Monkey-Patch) disconnectLine ---
    api.disconnectLine = function (path) {
      const shouldRecord =
        !self.isApplyingHistory &&
        !window.__readOnly &&
        !window.__RESTORING_FROM_SUPABASE;

      let keyA, keyB, existsBefore;
      if (shouldRecord) {
        const conn = self.findConnectionByPath(path);
        if (conn && conn.itemA && conn.itemB) {
          keyA = self.itemKey(conn.itemA);
          keyB = self.itemKey(conn.itemB);
          existsBefore = true;
        }
      }

      // Run the original function
      self.originalDisconnectLine(path);

      if (shouldRecord && existsBefore) {
        const existsAfter = !!self.findConnectionByKeys(keyA, keyB);
        if (!existsAfter) {
          self.undoStack.push({ kind: "connection_remove", aKey: keyA, bKey: keyB });
          self.redoStack.length = 0;
          self.refreshUndoRedoButtons();
        }
      }
    };

    // 4. --- Wrap (Monkey-Patch) Element Creators ---
    const wrapCreator = (creatorName, originalCreator) => {
      api[creatorName] = function(...args) {
        const shouldRecord =
          !self.isApplyingHistory &&
          !window.__readOnly &&
          !window.__RESTORING_FROM_SUPABASE;
        
        // Run original creator
        const el = originalCreator.apply(api, args);

        if (shouldRecord && el) {
          const key = self.itemKey(el);
          const snapshot = self.snapshotElement(el);
          if (key && snapshot) {
            self.undoStack.push({
              kind: "element_add",
              key,
              snapshot
            });
            self.redoStack.length = 0;
            self.refreshUndoRedoButtons();
          }
        }
        return el;
      };
    };

    wrapCreator('addBibleVerse', this.originalAddBibleVerse);
    wrapCreator('addTextNote', this.originalAddTextNote);
    wrapCreator('addInterlinearCard', this.originalAddInterlinearCard);
    wrapCreator('addSongElement', this.originalAddSongElement);

    // 5. --- Wrap (Monkey-Patch) deleteItem ---
    api.deleteItem = function(el) {
      const shouldRecord =
        !self.isApplyingHistory &&
        !window.__readOnly &&
        !window.__RESTORING_FROM_SUPABASE &&
        !!el;

      let action = null;

      if (shouldRecord) {
        const key = self.itemKey(el);
        const snapshot = self.snapshotElement(el);
        const relatedConnections = self.snapshotConnectionsForElement(key);
        if (key && snapshot) {
          action = {
            kind: "element_delete",
            key,
            snapshot,
            connections: relatedConnections
          };
        }
      }

      // Run original deleter
      self.originalDeleteItem(el);

      if (action) {
        self.undoStack.push(action);
        self.redoStack.length = 0;
        self.refreshUndoRedoButtons();
      }
    };

    // 6. --- Attach Event Listeners ---
    this.undoBtn.addEventListener("click", this.handleUndo.bind(this));
    this.redoBtn.addEventListener("click", this.handleRedo.bind(this));

    document.addEventListener("keydown", (e) => {
      // Prevent shortcuts while typing
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.isContentEditable)
      ) {
        return;
      }
      
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const metaKey = (isMac && e.metaKey) || (!isMac && e.ctrlKey);
      if (!metaKey) return;

      console.log(e.key)

      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        if (e.shiftKey) {
          this.handleRedo(); // Ctrl/Cmd+Shift+Z
        } else {
          this.handleUndo(); // Ctrl/Cmd+Z
        }
      } else if (e.key === "Shift" && e.key === "z") {
        e.preventDefault();
        this.handleRedo(); // Ctrl/Cmd+Y
      }
    });

    // 7. --- Final Setup ---
    this.refreshUndoRedoButtons(); // Set initial button state
    console.log("✅ Undo/Redo Manager initialized (with element support).");
  },

  /**
   * Resilient Polling Starter. This waits for the DOM and script.js
   * to be fully loaded before trying to initialize.
   */
  startPoller() {
    const self = this;
    let pollAttempts = 0;
    const maxPollAttempts = 100; // 100 * 100ms = 10 seconds

    const poller = setInterval(() => {
      pollAttempts++;
      const api = window.BoardAPI;

      // Find buttons inside the poll
      self.undoBtn = document.getElementById("undo-btn");
      self.redoBtn = document.getElementById("redo-btn");

      // Check if all dependencies are ready
      // (Check for new AND old API functions)
      if (
        api &&
        typeof api.connectItems === "function" &&
        typeof api.disconnectLine === "function" &&
        typeof api.itemKey === "function" &&
        typeof api.getConnections === "function" &&
        typeof api.addBibleVerse === "function" &&
        typeof api.addTextNote === "function" &&
        typeof api.addInterlinearCard === "function" &&
        typeof api.addSongElement === "function" &&
        typeof api.deleteItem === "function" && // The new function
        self.undoBtn &&
        self.redoBtn
      ) {
        // Success!
        clearInterval(poller);
        self.initAndWrap(api);
      } else if (pollAttempts > maxPollAttempts) {
        // Failure
        clearInterval(poller);
        console.error(
          "Undo/Redo: Failed to initialize. BoardAPI or buttons not found after 10 seconds. Check for other script errors."
        );
      }
      // ...else, just keep polling
    }, 100);
  }
};

// --- Kick off the poller ---
UndoRedoManager.startPoller();

window.UndoRedoManager = UndoRedoManager;