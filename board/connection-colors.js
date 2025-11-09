// board/connection-colors.js

(() => {
  "use strict";

  const PRESET_COLORS = [
    "#594236", // Red (Default)
    "#937666ff", // Yellow
    "#93A3BC", // Blue
    "#384a9dff",  // Purple
    "#48ACF0", // Green 
  ];
  const DEFAULT_COLOR = PRESET_COLORS[0];
  const STORAGE_KEY = "bb:connectionColor";

  let g_currentColor = DEFAULT_COLOR;
  let g_paletteToolbar = null;

  /**
   * Injects the CSS for the color palette into the document head.
   */
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      /* NEW: Container for the right-side palette */
      #connection-color-toolbar {
        display: flex;
        flex-direction: column;
        gap: 8px; /* Match left bar */
        width: 35px; /* Match left bar */
        position: absolute;
        right: 15px;
        top: 50%;
        transform: translateY(-50%);
        background: var(--bg-seethroug);
        border: 1px solid var(--fg-seethrough);
        backdrop-filter: blur(1rem);
        justify-content: center;
        align-items: center;
        padding: 10px 4px; /* Match left bar */
        border-radius: 15px; /* Match left bar */
        z-index: 10001; /* Match left bar */
      }

      .color-swatch {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid var(--bg-alt);
        cursor: pointer;
        transition: transform 0.1s ease, border-color 0.1s ease;
        opacity: 0.7;
      }
      .color-swatch:hover {
        transform: scale(1.1);
        opacity: 1;
      }
      .color-swatch.active {
        transform: scale(1.1);
        border-color: var(--fg);
        opacity: 1;
        box-shadow: 0 0 0 2px var(--bg-alt);
      }
      #connection-color-toolbar.disabled {
        pointer-events: none;
        opacity: 0.5;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Creates the color palette UI and appends it to the action container.
   */
  function buildPalette() {
    // Append to the main container or body, not the left-side actions
    const mainContainer = document.getElementById("main-content-container") || document.body;
    if (!mainContainer) return;

    g_paletteToolbar = document.createElement("div");
    g_paletteToolbar.id = "connection-color-toolbar";
    g_paletteToolbar.title = "Connection Color";

    PRESET_COLORS.forEach((color) => {
      const swatch = document.createElement("div");
      swatch.className = "color-swatch";
      swatch.dataset.color = color;
      swatch.style.backgroundColor = color;
      swatch.title = `Set connection color (${color})`;

      swatch.addEventListener("click", () => {
        window.BoardAPI.setConnectionColor(color);
      });

      g_paletteToolbar.appendChild(swatch);
    });

    mainContainer.appendChild(g_paletteToolbar);
    updatePaletteUI(g_currentColor);
  }

  /**
   * Updates the visual state of the palette UI.
   * @param {string} newColor The color to set as active.
   */
  function updatePaletteUI(newColor) {
    if (!g_paletteToolbar) return;
    g_paletteToolbar.querySelectorAll(".color-swatch").forEach((swatch) => {
      swatch.classList.toggle("active", swatch.dataset.color === newColor);
    });
  }

  /**
   * Applies read-only state to the palette.
   * @param {boolean} isReadOnly
   */
  function applyReadOnly(isReadOnly) {
    if (g_paletteToolbar) {
      g_paletteToolbar.classList.toggle("disabled", isReadOnly);
    }
  }

  /**
   * Patches the BoardAPI with color-aware functions.
   */
  function patchBoardAPI() {
    const api = window.BoardAPI;
    if (!api) return;

    // 1. --- Add new color API functions ---
    api.getConnectionColor = () => g_currentColor;
    api.getConnectionColors = () => PRESET_COLORS;
    api.setConnectionColor = (color) => {
      if (window.__readOnly || !PRESET_COLORS.includes(color)) {
        return;
      }
      g_currentColor = color;
      localStorage.setItem(STORAGE_KEY, color);
      updatePaletteUI(color);
    };
    // 2. --- Patch connectItems (wrapped by undo-redo) ---
    const undoRedoWrappedConnect = api.connectItems;
    api.connectItems = function (a, b, colorOverride = null) {
      const manager = window.UndoRedoManager;
      const isReplay = manager && manager.isApplyingHistory;
      
      const color = colorOverride || api.getConnectionColor();

      // Call the original undo-redo wrapper
      undoRedoWrappedConnect(a, b);

      // Now, find the connection and action it just created
      const conn = api.getConnections().slice(-1)[0];
      if (conn && conn.path) {
        conn.color = color;
        conn.path.style.stroke = color;
        conn.path.dataset.color = color;

        updateHandleColor(conn.handle, color);
      }

      // Augment the undo stack entry
      const shouldRecord = manager && !isReplay && !window.__readOnly && !window.__RESTORING_FROM_SUPABASE && a && b;
      if (shouldRecord && manager.undoStack.length > 0) {
        const lastAction = manager.undoStack[manager.undoStack.length - 1];
        if (
          lastAction.kind === 'connection_add' &&
          lastAction.aKey === api.itemKey(a) &&
          lastAction.bKey === api.itemKey(b)
        ) {
          lastAction.color = color;
        }
      }
    };

    // 3. --- Patch disconnectLine (wrapped by undo-redo) ---
    const undoRedoWrappedDisconnect = api.disconnectLine;
    api.disconnectLine = function (path) {
      const manager = window.UndoRedoManager;
      const isReplay = manager && manager.isApplyingHistory;
      const shouldRecord = manager && !isReplay && !window.__readOnly && !window.__RESTORING_FROM_SUPABASE;

      let colorToSave = null;
      if (shouldRecord) {
        const conn = api.getConnections().find(c => c.path === path);
        if (conn) {
          colorToSave = conn.color || DEFAULT_COLOR;
        }
      }

      // Call the original undo-redo wrapper
      undoRedoWrappedDisconnect(path);

      // Augment the undo stack entry
      if (shouldRecord && colorToSave && manager.undoStack.length > 0) {
        const lastAction = manager.undoStack[manager.undoStack.length - 1];
        // Note: We can't easily check keys, so we just trust the last action
        if (lastAction.kind === 'connection_remove') {
          lastAction.color = colorToSave;
        }
      }
    };

    // 4. --- Patch serializeBoard ---
    // This patch is NOW RESPECTED by supabase-sync.js
    const originalSerialize = api.serializeBoard;
    api.serializeBoard = function () {
      const data = originalSerialize();
      if (!data) return null;

      // Add connection colors
      const liveConns = api.getConnections();
      const keyToConnMap = new Map();
      liveConns.forEach(c => {
        const k1 = api.itemKey(c.itemA);
        const k2 = api.itemKey(c.itemB);
        keyToConnMap.set(`${k1}|${k2}`, c);
        keyToConnMap.set(`${k2}|${k1}`, c);
      });

      if (data.connections) {
        data.connections.forEach(serialConn => {
          // Note: supabase-sync.js's internal serialize uses { a, b }
          // script.js's serialize uses { a, b }
          // My previous code used { aKey, bKey } - this was a bug.
          const connKey = serialConn.a && serialConn.b ? `${serialConn.a}|${serialConn.b}` : null;
          const liveConn = connKey ? keyToConnMap.get(connKey) : null;
          
          if (liveConn && liveConn.color) {
            serialConn.color = liveConn.color;
          } else {
            serialConn.color = DEFAULT_COLOR;
          }
        });
      }
      
      // Save current color choice
      data.settings = data.settings || {};
      data.settings.connectionColor = g_currentColor;

      return data;
    };

    // 5. --- Patch deserializeBoard ---
    // This patch is NOW RESPECTED by supabase-sync.js
    const originalDeserialize = api.deserializeBoard;
    api.deserializeBoard = function (data) {
      originalDeserialize(data);

      // After original deserialize, go back and apply colors
      if (data && data.connections) {
        const liveConns = api.getConnections();
        const keyToConnMap = new Map();
        liveConns.forEach(c => {
          const k1 = api.itemKey(c.itemA);
          const k2 = api.itemKey(c.itemB);
          keyToConnMap.set(`${k1}|${k2}`, c);
          keyToConnMap.set(`${k2}|${k1}`, c);
        });

        data.connections.forEach(serialConn => {
          const connKey = serialConn.a && serialConn.b ? `${serialConn.a}|${serialConn.b}` : null;
          const liveConn = connKey ? keyToConnMap.get(connKey) : null;
          const color = serialConn.color || DEFAULT_COLOR;
          
          if (liveConn) {
            liveConn.color = color;
            liveConn.path.style.stroke = color;
            liveConn.path.dataset.color = color;

            updateHandleColor(liveConn.handle, color);
          }
        });
      }
      
      // Restore selected color
      const savedColor = data?.viewport?.connectionColor || data?.settings?.connectionColor;
      if (savedColor && PRESET_COLORS.includes(savedColor)) {
        api.setConnectionColor(savedColor);
      }
    };
    
    // 6. --- Patch updateAllConnections ---
    const originalUpdateAll = api.updateAllConnections;
    api.updateAllConnections = function(...args) {
        originalUpdateAll.apply(this, args);
        // After positions are updated, re-apply colors
        try {
            const conns = api.getConnections();
            for (const conn of conns) {
                if (conn.color && conn.path) {
                    conn.path.style.stroke = conn.color;

                    updateHandleColor(conn.handle, conn.color);
                }
            }
        } catch (e) {
            console.warn("Color update failed in updateAllConnections", e);
        }
    }
  }

  /**
   * Patches the UndoRedoManager to pass colors during replay.
   */
  function patchUndoRedo() {
    const manager = window.UndoRedoManager;
    if (!manager) return;

    // 1. --- Patch handleUndo ---
    const originalHandleUndo = manager.handleUndo.bind(manager);
    manager.handleUndo = function () {
      const action = this.undoStack[this.undoStack.length - 1];

      if (action && action.kind === 'connection_remove' && action.color) {
        // Intercept and run our custom logic
        if (this.isApplyingHistory || window.__readOnly) return;
        
        this.isApplyingHistory = true;
        this.undoStack.pop();
        const elA = this.findElementByKey(action.aKey);
        const elB = this.findElementByKey(action.bKey);
        
        if (elA && elB) {
          // CALL WITH COLOR OVERRIDE
          window.BoardAPI.connectItems(elA, elB, action.color);
          this.redoStack.push(action);
        }
        
        this.isApplyingHistory = false;
        this.refreshUndoRedoButtons();
      } else {
        // Not our action, call original
        originalHandleUndo();
      }
    };

    // 2. --- Patch handleRedo ---
    const originalHandleRedo = manager.handleRedo.bind(manager);
    manager.handleRedo = function () {
      const action = this.redoStack[this.redoStack.length - 1];

      if (action && action.kind === 'connection_add' && action.color) {
        // Intercept and run our custom logic
        if (this.isApplyingHistory || window.__readOnly) return;

        this.isApplyingHistory = true;
        this.redoStack.pop();
        const elA = this.findElementByKey(action.aKey);
        const elB = this.findElementByKey(action.bKey);

        if (elA && elB) {
          // CALL WITH COLOR OVERRIDE
          window.BoardAPI.connectItems(elA, elB, action.color);
          this.undoStack.push(action);
        }
        
        this.isApplyingHistory = false;
        this.refreshUndoRedoButtons();
      } else {
        // Not our action, call original
        originalHandleRedo();
      }
    };
  }
  
  /**
   * Patches the read-only guard to also disable our UI.
   */
  function patchReadOnlyGuard() {
      if (!window.BoardAPI || !window.BoardAPI.applyReadOnlyGuards) return;
      
      const originalGuard = window.BoardAPI.applyReadOnlyGuards;
      window.BoardAPI.applyReadOnlyGuards = function(isReadOnly) {
          originalGuard(isReadOnly);
          // Also update our UI
          applyReadOnly(isReadOnly);
      }
  }

  /**
   * Polls until all APIs are ready, then initializes.
   */
  function startPoller() {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const api = window.BoardAPI;
      const manager = window.UndoRedoManager;

      if (api && manager && api.connectItems && manager.handleUndo && api.serializeBoard) {
        clearInterval(interval);
        
        // Load saved color
        const savedColor = localStorage.getItem(STORAGE_KEY);
        if (savedColor && PRESET_COLORS.includes(savedColor)) {
          g_currentColor = savedColor;
        }

        injectStyles();
        buildPalette();
        patchBoardAPI();
        patchUndoRedo();
        patchReadOnlyGuard();
        
        // Final check on read-only status in case it was set before we loaded
        if (window.__readOnly) {
            applyReadOnly(true);
        }
        
        console.log("✅ Connection Color module initialized.");
      } else if (attempts > 100) {
        clearInterval(interval);
        console.error("Connection Color module failed to initialize. BoardAPI or UndoRedoManager not found.");
      }
    }, 100);
  }

  function updateHandleColor(handle, color) {
    if (!handle) return;
    const circle = handle.querySelector('.handle-circle');
    if (circle) {
      circle.style.stroke = color;
    }
    // You could also color the 'X' lines if desired
    // const lines = handle.querySelectorAll('.handle-cross');
    // lines.forEach(line => line.style.stroke = color);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPoller);
  } else {
    startPoller();
  }

})();