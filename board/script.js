// ==================== Bible Book API Codes ====================
const bibleBookCodes = {
  "Genesis": "GEN", "Exodus": "EXO", "Leviticus": "LEV", "Numbers": "NUM", "Deuteronomy": "DEU",
  "Joshua": "JOS", "Judges": "JDG", "Ruth": "RUT", "1 Samuel": "1SA", "2 Samuel": "2SA",
  "1 Kings": "1KI", "2 Kings": "2KI", "1 Chronicles": "1CH", "2 Chronicles": "2CH", "Ezra": "EZR",
  "Nehemiah": "NEH", "Esther": "EST", "Job": "JOB", "Psalms": "PSA", "Proverbs": "PRO",
  "Ecclesiastes": "ECC", "Song of Solomon": "SNG", "Isaiah": "ISA", "Jeremiah": "JER",
  "Lamentations": "LAM", "Ezekiel": "EZK", "Daniel": "DAN", "Hosea": "HOS", "Joel": "JOL",
  "Amos": "AMO", "Obadiah": "OBA", "Jonah": "JON", "Micah": "MIC", "Nahum": "NAM", "Habakkuk": "HAB",
  "Zephaniah": "ZEP", "Haggai": "HAG", "Zechariah": "ZEC", "Malachi": "MAL", "Matthew": "MAT",
  "Mark": "MRK", "Luke": "LUK", "John": "JHN", "Acts": "ACT", "Romans": "ROM",
  "1 Corinthians": "1CO", "2 Corinthians": "2CO", "Galatians": "GAL", "Ephesians": "EPH",
  "Philippians": "PHP", "Colossians": "COL", "1 Thessalonians": "1TH", "2 Thessalonians": "2TH",
  "1 Timothy": "1TI", "2 Timothy": "2TI", "Titus": "TIT", "Philemon": "PHM", "Hebrews": "HEB",
  "James": "JAS", "1 Peter": "1PE", "2 Peter": "2PE", "1 John": "1JN", "2 John": "2JN", "3 John": "3JN",
  "Jude": "JUD", "Revelation": "REV"
};

// ==================== Central Autosave Trigger ====================
/**
 * Central handler for all board mutations.
 * This calls the debounced autosave hook provided by the persistence layer
 * and correctly respects the __RESTORING_FROM_SUPABASE flag.
 * @param {string} reason A debug-friendly reason for the mutation.
 */
function onBoardMutated(reason) {
  if (window.__RESTORING_FROM_SUPABASE) {
    // console.debug("Save skipped (restoring):", reason);
    return;
  }
  // console.debug("Mutation trigger:", reason);
  window.BoardAPI?.triggerAutosave?.(reason);
}


// ==================== Fetch Verse Text (KJV) ====================
async function fetchVerseText(book, chapter, verse) {
  const code = bibleBookCodes[book] || book;
  const apiUrl = `https://bible-api-5jrz.onrender.com/verse/KJV/${encodeURIComponent(code)}/${chapter}/${verse}`;
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(apiUrl)}`;

  try {
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error("Proxy fetch failed");
    const data = await resp.json();
    if (data.text) return data.text;
    if (data.verses) return data.verses.map(v => v.text).join(" ");
    return "Verse not found.";
  } catch {
    try {
      const resp = await fetch(apiUrl, { mode: "cors" });
      if (!resp.ok) throw new Error("Direct fetch failed");
      const data = await resp.json();
      if (data.text) return data.text;
      if (data.verses) return data.verses.map(v => v.text).join(" ");
      return "Verse not found.";
    } catch (err2) {
      console.error("❌ Error fetching verse:", err2);
      return "Error fetching verse.";
    }
  }
}

// ==================== DOM Refs ====================
const viewport = document.querySelector(".viewport");
const workspace = document.querySelector("#workspace");
const mainContentContainer = document.getElementById("main-content-container");
const searchQueryContainer = document.getElementById("search-query-container");
const searchQuery = document.getElementById("search-query");
const searchBar = document.getElementById("search-bar");
const didYouMeanText = document.getElementById("did-you-mean-text");
const searchQueryFullContainer = document.getElementById("search-query-full-container");
const loader = document.getElementById("loader");

// SONGS (present in index.html; populated by your search.js)
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

// ==================== Layout State ====================
let searchDrawerOpen = false;     // 300px
let interlinearOpen = false;     // 340px
let interlinearInFlight = null; // AbortController for in-flight fetch
let interlinearSeq = 0;       // Sequence number to prevent race conditions

function applyLayout(withTransition = true) {
  const offset = (searchDrawerOpen ? 300 : 0) + (interlinearOpen ? 340 : 0);

  if (withTransition) mainContentContainer.style.transition = ".25s";
  mainContentContainer.style.width = offset ? `calc(100% - ${offset}px)` : "100%";

  if (withTransition) searchQueryContainer.style.transition = ".25s";
  searchQueryContainer.style.left = searchDrawerOpen ? "calc(100% - 300px)" : "100%";

  interPanel.classList.toggle("open", interlinearOpen);

  if (withTransition) {
    setTimeout(() => {
      mainContentContainer.style.transition = "0s";
      searchQueryContainer.style.transition = "0s";
    }, 250);
  }
  updateAllConnections();
}

// ==================== State ====================
let isPanning = false;
let startX, startY, scrollLeft, scrollTop;
let active = null;
let offsetX, offsetY;
let scale = 1;
let currentIndex = 1;
const MIN_SCALE = 0.4, MAX_SCALE = 1.1, PINCH_SENS = 0.005, WHEEL_SENS = 0.001;

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
function isTouchInsideUI(el) {
  return !!(el.closest?.('#search-query-container') ||
    el.closest?.('#action-buttons-container') ||
    el.closest?.('#bible-whiteboard-title') ||
    el.closest?.('#search-container'));
}


function onGlobalMouseUp() {
  if (active) {
    try { active.style.cursor = "grab"; } catch { }
    onBoardMutated("item_move_end"); // AUTOSAVE
  }
  active = null;
  pendingMouseDrag = null;
  touchDragElement = null;
  isPanning = false;
}

// Make sure we always release, even if mouseup lands on another element/panel
window.addEventListener("mouseup", onGlobalMouseUp);               // normal bubble
document.addEventListener("mouseup", onGlobalMouseUp, true);       // capture phase
window.addEventListener("blur", onGlobalMouseUp);                  // lost focus (e.g., alt-tab)

function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
function itemKey(el) { if (!el?.dataset?.vkey) { el.dataset.vkey = "v_" + Math.random().toString(36).slice(2); } return el.dataset.vkey; }

function clampScroll(){
  // During restore, skip clamping until layout settles
  if (window.__RESTORING_FROM_SUPABASE) return;
  
  const maxLeft = Math.max(0, workspace.offsetWidth * scale - viewport.clientWidth);
  const maxTop  = Math.max(0, workspace.offsetHeight * scale - viewport.clientHeight);
  
  // Only clamp if values are valid (prevent snap to 0)
  if (maxLeft >= 0 && maxTop >= 0) {
    viewport.scrollLeft = clamp(viewport.scrollLeft, 0, maxLeft);
    viewport.scrollTop  = clamp(viewport.scrollTop, 0, maxTop);
  }
}

function applyZoom(e, deltaScale) {
  const old = scale, next = clamp(old + deltaScale, MIN_SCALE, MAX_SCALE);
  if (Math.abs(next - old) < 1e-9) return false;

  const vpRect = viewport.getBoundingClientRect();
  const vpX = e.clientX - vpRect.left, vpY = e.clientY - vpRect.top;

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
  updateAllConnections();
  onBoardMutated("zoom_end"); // AUTOSAVE on zoom
  return true;
}

// ==================== Pan / Zoom ====================
viewport.addEventListener("mousedown", (e) => {
  if (e.target.closest(".board-item")) return;
  isPanning = true; viewport.style.cursor = "grabbing";
  startX = e.clientX; startY = e.clientY;
  scrollLeft = viewport.scrollLeft; scrollTop = viewport.scrollTop;
});

window.addEventListener("mouseup", () => {
  viewport.style.cursor = "grab";
  onGlobalMouseUp();
});

window.addEventListener("mousemove", (e) => {
  if (!isPanning && !active) {
    if (pendingMouseDrag) {
      const dx = e.clientX - pendingMouseDrag.startX;
      const dy = e.clientY - pendingMouseDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        startDragMouse(pendingMouseDrag.item, {
          clientX: pendingMouseDrag.startX,
          clientY: pendingMouseDrag.startY
        }, pendingMouseDrag.offX, pendingMouseDrag.offY);
        pendingMouseDrag = null;
      }
    }
  }
  if (isPanning) {
    viewport.scrollLeft = scrollLeft - (e.clientX - startX);
    viewport.scrollTop = scrollTop - (e.clientY - startY);
    clampScroll(); updateAllConnections();
    onBoardMutated("pan"); // AUTOSAVE on pan (will be debounced)
  } else if (active) {
    dragMouseTo(e.clientX, e.clientY);
  }
});

viewport.addEventListener("wheel", (e) => {
  const pixels = (e.deltaMode === 1 ? e.deltaY * 16 : (e.deltaMode === 2 ? e.deltaY * viewport.clientHeight : e.deltaY));
  const changed = applyZoom(e, -pixels * (e.ctrlKey ? PINCH_SENS : WHEEL_SENS));
  if (changed) e.preventDefault();
}, { passive: false });

// Keep connection lines in sync when the viewport scrolls (wheel/trackpad/scrollbar)
viewport.addEventListener("scroll", () => {
  updateAllConnections();
  // Don't autosave on *every* scroll frame, but maybe on end?
  // Using mousemove/touchmove for pan-drag save is better.
  // Wheel zoom is handled in applyZoom.
}, { passive: true });


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
    if (updateAllConnections) updateAllConnections();
    if (updateActionButtonsEnabled) updateActionButtonsEnabled();
  }, 100);
});

window.addEventListener("resize", updateAllConnections);

// Touch pan + pinch
let touchStartDistance = 0, lastScale = 1;
function getTouchDistance(t) { const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.hypot(dx, dy); }
function getTouchMidpoint(t) { return { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 }; }

viewport.addEventListener("touchstart", (e) => {
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
}, { passive: false });



viewport.addEventListener("touchmove", (e) => {
  if (isTouchInsideUI?.(e.target)) return;

  // ✅ If an element is dragging or we're arming one (pendingTouchDrag),
  //    the viewport must NOT pan/zoom on this move.
  if (touchDragElement || pendingTouchDrag) return;

  if (e.touches.length === 1 && isTouchPanning && !isConnectMode) {
    e.preventDefault(); // only while panning the canvas
    viewport.scrollLeft = scrollLeft - (e.touches[0].clientX - startX);
    viewport.scrollTop = scrollTop - (e.touches[0].clientY - startY);
    clampScroll(); updateAllConnections();
  } else if (e.touches.length === 2) {
    e.preventDefault(); // pinch zoom
    const newDistance = getTouchDistance(e.touches);
    const scaleDelta = (newDistance - touchStartDistance) * PINCH_SENS;
    const newScale = clamp(lastScale + scaleDelta, MIN_SCALE, MAX_SCALE);
    const mid = getTouchMidpoint(e.touches);
    applyZoom({ clientX: mid.x, clientY: mid.y }, newScale - scale);
  }
}, { passive: false });


viewport.addEventListener("touchend", () => { 
  if (isTouchPanning) {
    onBoardMutated("pan_touch_end"); // AUTOSAVE on pan end
  }
  isTouchPanning = false; 
}, { passive: true });

workspace.addEventListener("touchstart", (e) => {
  if (isConnectMode) return;
  if (e.touches.length !== 1) return;           // element drag is 1-finger only
  if (isTouchInsideUI?.(e.target)) return;      // don’t hijack UI touches

  const item = e.target.closest(".board-item");
  if (!item) {
    // Touch on empty canvas should not arm an element drag
    pendingTouchDrag = null;
    return;
  }

  // Don’t preventDefault yet — we only do that once we actually start dragging
  touchDragElement = null;                       // clear any stale drag
  const t = e.touches[0];
  const rect = item.getBoundingClientRect();
  pendingTouchDrag = {
    item,
    startX: t.clientX,
    startY: t.clientY,
    offX: (t.clientX - rect.left) / scale,
    offY: (t.clientY - rect.top) / scale,
  };
}, { passive: false });

workspace.addEventListener("touchmove", (e) => {
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
      startDragTouch(pendingTouchDrag.item, t, pendingTouchDrag.offX, pendingTouchDrag.offY);
      pendingTouchDrag = null;
    }
  }
}, { passive: false });


workspace.addEventListener("touchend", () => {
  if (touchDragElement) {
    onBoardMutated("item_move_touch_end"); // AUTOSAVE
  }
  touchDragElement = null;
  pendingTouchDrag = null;
  touchMoved = false;
}, { passive: true });

workspace.addEventListener("touchcancel", () => {
  touchDragElement = null;
  pendingTouchDrag = null;
  touchMoved = false;
}, { passive: true });


// If touch ends anywhere (including over UI), ensure we’re not “stuck” in drag
window.addEventListener("touchend", () => {
  if (touchDragElement) {
    onBoardMutated("item_move_touch_end"); // AUTOSAVE
  }
  touchDragElement = null;
  pendingTouchDrag = null;
  touchMoved = false;
  isTouchPanning = false;
  active = null;
}, { passive: true });

window.addEventListener("touchcancel", () => {
  touchDragElement = null;
  pendingTouchDrag = null;
  touchMoved = false;
  isTouchPanning = false;
  active = null;
}, { passive: true });



// ==================== Drag helpers ====================
function startDragMouse(item, eOrPoint, offX, offY) {
  active = item; currentIndex += 1; item.style.zIndex = currentIndex; item.style.cursor = "grabbing";
  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    offsetX = (eOrPoint.clientX - rect.left) / scale;
    offsetY = (eOrPoint.clientY - rect.top) / scale;
  } else {
    offsetX = offX; offsetY = offY;
  }
}
function dragMouseTo(clientX, clientY) {
  const newLeft = (viewport.scrollLeft + clientX) / scale - offsetX;
  const newTop = (viewport.scrollTop + clientY) / scale - offsetY;
  const maxLeft = workspace.offsetWidth - active.offsetWidth;
  const maxTop = workspace.offsetHeight - active.offsetHeight;
  active.style.left = clamp(newLeft, 0, maxLeft) + "px";
  active.style.top = clamp(newTop, 0, maxTop) + "px";
  updateAllConnections();
}
function startDragTouch(item, touchPoint, offX, offY) {
  touchDragElement = item; touchMoved = false; isTouchPanning = false;
  currentIndex += 1; item.style.zIndex = currentIndex;
  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    touchDragOffset.x = (touchPoint.clientX - rect.left) / scale;
    touchDragOffset.y = (touchPoint.clientY - rect.top) / scale;
  } else {
    touchDragOffset.x = offX; touchDragOffset.y = offY;
  }
}
function dragTouchTo(touchPoint) {
  const vp = viewport.getBoundingClientRect();
  const x = (viewport.scrollLeft + (touchPoint.clientX - vp.left)) / scale - touchDragOffset.x;
  const y = (viewport.scrollTop + (touchPoint.clientY - vp.top)) / scale - touchDragOffset.y;
  const maxLeft = workspace.offsetWidth - touchDragElement.offsetWidth;
  const maxTop = workspace.offsetHeight - touchDragElement.offsetHeight;
  touchDragElement.style.left = `${clamp(x, 0, maxLeft)}px`;
  touchDragElement.style.top = `${clamp(y, 0, maxTop)}px`;
  updateAllConnections();
}

// ==================== Connections ====================
let connections = [];
function connectionExists(a, b) {
  const ka = itemKey(a), kb = itemKey(b);
  return connections.some(c => {
    const ca = itemKey(c.itemA), cb = itemKey(c.itemB);
    return (ca === ka && cb === kb) || (ca === kb && cb === ka);
  });
}
function updateConnection(path, el1, el2) {
  const vpRect = viewport.getBoundingClientRect();
  const r1 = el1.getBoundingClientRect(), r2 = el2.getBoundingClientRect();
  const p1 = {
    x: (viewport.scrollLeft + (r1.left - vpRect.left) + r1.width / 2) / scale,
    y: (viewport.scrollTop + (r1.top - vpRect.top) + r1.height / 2) / scale
  };
  const p2 = {
    x: (viewport.scrollLeft + (r2.left - vpRect.left) + r2.width / 2) / scale,
    y: (viewport.scrollTop + (r2.top - vpRect.top) + r2.height / 2) / scale
  };
  const dx = p2.x - p1.x, dy = p2.y - p1.y, absDx = Math.abs(dx), absDy = Math.abs(dy);
  if (absDx < 40 || absDy < 40) { path.setAttribute("d", `M${p1.x},${p1.y} L${p2.x},${p2.y}`); return; }
  const s = 0.7; let c1x = p1.x, c1y = p1.y, c2x = p2.x, c2y = p2.y;
  if (absDx > absDy) { c1x += dx * s; c2x -= dx * s; c1y += dy * 0.1; c2y -= dy * 0.1; }
  else { c1y += dy * s; c2y -= dy * s; c1x += dx * 0.1; c2x -= dx * 0.1; }
  path.setAttribute("d", `M${p1.x},${p1.y} C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`);
}
function updateAllConnections() { connections.forEach(({ path, itemA, itemB }) => updateConnection(path, itemA, itemB)); }
function connectItems(a, b) {
  if (!a || !b || a === b || connectionExists(a, b)) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.classList.add("connection-line"); path.style.pointerEvents = "stroke";
  path.addEventListener("click", (e) => { e.stopPropagation(); disconnectLine(path); });
  svg.appendChild(path); connections.push({ path, itemA: a, itemB: b }); updateConnection(path, a, b);
  onBoardMutated("connect_items"); // AUTOSAVE
}
function disconnectLine(path) {
  const idx = connections.findIndex(c => c.path === path);
  if (idx !== -1) { 
    try { svg.removeChild(connections[idx].path); } catch (_e) { } 
    connections.splice(idx, 1); 
    onBoardMutated("disconnect_line"); // AUTOSAVE
  }
}
function removeConnectionsFor(el) {
  let changed = false;
  connections = connections.filter(c => {
    if (c.itemA === el || c.itemB === el) {
      try { svg.removeChild(c.path); } catch (_e) { }
      changed = true;
      return false;
    }
    return true;
  });
  if (changed) onBoardMutated("remove_connections_for_item"); // AUTOSAVE
}

// ==================== Element Creation ====================
function addBibleVerse(reference, text, createdFromLoad = false) {
  const el = document.createElement("div");
  el.classList.add("board-item", "bible-verse");
  el.style.position = "absolute";

  // Add robust data attributes for serialization
  el.dataset.type = "verse";
  el.dataset.reference = reference;
  el.dataset.text = text;

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale, visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale, visibleH = vpRect.height / scale;
  const randX = visibleX + Math.random() * (visibleW - 300);
  const randY = visibleY + Math.random() * (visibleH - 200);
  el.style.left = `${randX}px`; el.style.top = `${randY}px`;

  // Use createdFromLoad flag to determine reference format
  const displayReference = createdFromLoad ? reference : `- ${reference}`;

  el.innerHTML = `
    <div id="bible-text-content">
      <div class="verse-text">VERSE</div>
      <div class="verse-text-content">${text}</div>
      <div class="verse-text-reference">${displayReference}</div>
    </div>
  `;

  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  el.addEventListener("mousedown", (e) => {
    if (isConnectMode || e.target.closest('[contenteditable="true"], textarea.text-content')) return;
    startDragMouse(el, e);
  });
  
  onBoardMutated("add_verse"); // AUTOSAVE (safe due to onBoardMutated restore check)
  return el;
}

function addTextNote(initial = "New note") {
  const el = document.createElement("div");
  el.classList.add("board-item", "text-note");
  el.dataset.type = "note"; // Add data attribute
  el.style.position = "absolute";

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale, visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale, visibleH = vpRect.height / scale;
  const x = visibleX + (visibleW - 300) / 2;
  const y = visibleY + (visibleH - 50) / 2;
  el.style.left = `${x}px`; el.style.top = `${y}px`;

  el.innerHTML = `
    <div class="note-content">
      <div class="verse-text note-label">NOTE</div>
      <div class="text-content" contenteditable="true" spellcheck="false">${initial}</div>
    </div>
  `;
  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  const header = el.querySelector(".note-label");
  const body = el.querySelector(".text-content");

  // AUTOSAVE on text edit
  body.addEventListener("input", () => {
    onBoardMutated("edit_note_text");
  });

  header.addEventListener("mousedown", (e) => { if (!isConnectMode) startDragMouse(el, e); });
  el.addEventListener("mousedown", (e) => {
    if (isConnectMode) return;
    if (e.target === body || e.target.closest(".text-content")) {
      const rect = el.getBoundingClientRect();
      pendingMouseDrag = {
        item: el, startX: e.clientX, startY: e.clientY,
        offX: (e.clientX - rect.left) / scale, offY: (e.clientY - rect.top) / scale
      };
      return;
    }
    startDragMouse(el, e);
  });

  el.addEventListener("touchstart", (e) => {
    if (isConnectMode || e.touches.length !== 1) return;
    const t = e.touches[0];
    const rect = el.getBoundingClientRect();
    pendingTouchDrag = {
      item: el, startX: t.clientX, startY: t.clientY,
      offX: (t.clientX - rect.left) / scale, offY: (t.clientY - rect.top) / scale
    };
  }, { passive: true });

  el.addEventListener("touchmove", (e) => {
    if (isConnectMode) return;
    const t = e.touches[0];
    if (pendingTouchDrag && !touchDragElement) {
      const dx = t.clientX - pendingTouchDrag.startX;
      const dy = t.clientY - pendingTouchDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        startDragTouch(pendingTouchDrag.item, t, pendingTouchDrag.offX, pendingTouchDrag.offY);
        pendingTouchDrag = null;
      }
    }
    if (!touchDragElement) return;
    e.preventDefault(); touchMoved = true;
    dragTouchTo(t);
  }, { passive: false });

  el.addEventListener("touchend", () => {
    if (touchDragElement) onBoardMutated("item_move_touch_end"); // AUTOSAVE
    if (!touchDragElement) { pendingTouchDrag = null; return; }
    touchDragElement = null;
    setTimeout(() => { touchMoved = false; }, 0);
  }, { passive: true });

  selectItem(el);
  
  // Only focus if this is a fresh add, not a restore
  if (!window.__RESTORING_FROM_SUPABASE) {
    setTimeout(() => { body.focus(); document.getSelection()?.selectAllChildren(body); }, 0);
  }

  onBoardMutated("add_note"); // AUTOSAVE (safe)
  return el;
}

/* ========== NEW: Dedicated Interlinear card element ========== */
function addInterlinearCard({ surface, english, translit, morph, strong, reference }) {
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
    const visibleX = viewport.scrollLeft / scale, visibleY = viewport.scrollTop / scale;
    const visibleW = vpRect.width / scale, visibleH = vpRect.height / scale;
    targetLeft = visibleX + (visibleW - 320) / 2;
    targetTop = visibleY + (visibleH - 120) / 2;
  }
  el.style.left = `${targetLeft}px`;
  el.style.top = `${targetTop}px`;

  // Build content
  const chips = [];
  if (translit) chips.push(`<span class="interlinear-chip">${translit}</span>`);
  if (morph) chips.push(`<span class="interlinear-chip">${morph}</span>`);
  if (strong) chips.push(`<span class="interlinear-chip">Strong: ${strong}</span>`);

  el.innerHTML = `
    <div class="interlinear-card-header">
      <div class="interlinear-card-badge">INTERLINEAR</div>
      <div class="interlinear-card-ref">${reference || ""}</div>
    </div>
    <div class="interlinear-card-body">
      <div class="interlinear-card-surface">${surface || ""}</div>
      ${english ? `<div class="interlinear-card-english">${english}</div>` : ""}
      ${chips.length ? `<div class="interlinear-card-meta">${chips.join(" ")}</div>` : ""}
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
  el.addEventListener("mousedown", (e) => {
    if (isConnectMode) return;
    startDragMouse(el, e);
  });
  el.addEventListener("touchstart", (e) => {
    if (isConnectMode || e.touches.length !== 1) return;
    const t = e.touches[0];
    const rect = el.getBoundingClientRect();
    pendingTouchDrag = {
      item: el, startX: t.clientX, startY: t.clientY,
      offX: (t.clientX - rect.left) / scale, offY: (t.clientY - rect.top) / scale
    };
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (isConnectMode) return;
    const t = e.touches[0];
    if (pendingTouchDrag && !touchDragElement) {
      const dx = t.clientX - pendingTouchDrag.startX;
      const dy = t.clientY - pendingTouchDrag.startY;
      if (Math.hypot(dx, dy) > DRAG_SLOP) {
        startDragTouch(pendingTouchDrag.item, t, pendingTouchDrag.offX, pendingTouchDrag.offY);
        pendingTouchDrag = null;
      }
    }
    if (!touchDragElement) return;
    e.preventDefault(); touchMoved = true;
    dragTouchTo(t);
  }, { passive: false });
  el.addEventListener("touchend", () => {
    if (touchDragElement) onBoardMutated("item_move_touch_end"); // AUTOSAVE
    if (!touchDragElement) { pendingTouchDrag = null; return; }
    touchDragElement = null;
    setTimeout(() => { touchMoved = false; }, 0);
  }, { passive: true });

  // Select on create (nice UX)
  selectItem(el);
  
  onBoardMutated("add_interlinear_card"); // AUTOSAVE (safe)
  return el;
}

// ==================== Search UI glue ====================
function searchForQueryFromSuggestion(reference) { searchBar.value = reference; searchForQuery(); }
function displaySearchVerseOption(reference, text) {
  const versesHeader = document.getElementById("search-query-verses-text");
  const verseContainer = document.getElementById("search-query-verse-container");

  // ✅ Always show the "Verses" header when we have a verse
  if (versesHeader) versesHeader.style.display = "block";

  if (verseContainer) {
    verseContainer.style.display = "block";
    verseContainer.innerHTML = "";

    const item = document.createElement("div");
    item.classList.add("search-query-verse-container");
    item.innerHTML = `
      <div class="search-query-verse-text">${text}</div>
      <div class="search-query-verse-reference">– ${reference} KJV</div>
      <button class="search-query-verse-add-button">add</button>
    `;
    item.querySelector(".search-query-verse-add-button")
      .addEventListener("click", () => addBibleVerse(`${reference} KJV`, text, false)); // Pass false for createdFromLoad

    verseContainer.appendChild(item);
  }
}

// ==================== Search (relies on findBibleVerseReference from search.js) ====================
async function searchForQuery(event) {
  const input = document.getElementById("search-bar");
  input && input.blur();
  if (event) event.preventDefault();

  // Hide sections; show loader; open panel
  if (typeof didYouMeanText !== "undefined") didYouMeanText.style.display = "none";
  if (typeof searchQueryFullContainer !== "undefined") searchQueryFullContainer.style.display = "none";
  if (typeof loader !== "undefined") loader.style.display = "flex";
  
  // NEW: Apply layout state
  searchDrawerOpen = true;
  if (interlinearOpen) closeInterlinearPanel(); // Close other panel
  applyLayout(true);


  const query = (document.getElementById("search-bar")?.value || "").trim();
  if (typeof searchQuery !== "undefined") searchQuery.textContent = `Search for "${query}"`;
  
  // Reset containers
  const verseContainer = document.getElementById("search-query-verse-container");
  if (verseContainer) verseContainer.innerHTML = "";
  if (songsContainer) songsContainer.innerHTML = "";
  const versesHeader = document.getElementById("search-query-verses-text");
  if (versesHeader) versesHeader.style.display = "none";
  if (songsHeader) songsHeader.style.display = "none";

  // Parse verse intent via your existing parser
  const result = (window.findBibleVerseReference) ? window.findBibleVerseReference(query) : null;

  if (result && result.didYouMean && typeof didYouMeanText !== "undefined") {
    didYouMeanText.style.display = "flex";
    didYouMeanText.innerHTML = `Did you mean: <div onclick="searchForQueryFromSuggestion('${result.reference}')">${result.reference}</div>?`;
  }

  // Prepare tasks: verse (if detected) + songs (always)
  const tasks = [];
  if (result && result.book) {
    const chap = result.chapter || 1;
    const vrse = result.verse || 1;
    tasks.push(
      fetchVerseText(result.book, chap, vrse)
        .then(text => ({ kind: "verse", payload: { ref: result.reference, text } }))
        .catch(() => ({ kind: "verse", payload: null }))
    );
  }
  tasks.push(
    fetchSongs(query, 8).then(list => ({ kind: "songs", payload: list || [] }))
  );

  const outputs = await Promise.all(tasks);

  // Render
  if (loader) loader.style.display = "none";
  if (searchQueryFullContainer) searchQueryFullContainer.style.display = "flex";

  const verseOut = outputs.find(o => o.kind === "verse");
  const songsOut = outputs.find(o => o.kind === "songs");

  if (verseOut && verseOut.payload) {
    // Keep your existing verse renderer if you have one:
    if (typeof displaySearchVerseOption === "function") {
      displaySearchVerseOption(verseOut.payload.ref, verseOut.payload.text);
    } else if (verseContainer) {
      // minimal fallback if your renderer name differs
      versesHeader && (versesHeader.style.display = "block");
      verseContainer.innerHTML = `
        <div class="search-query-verse-container">
          <div class="search-query-verse-text">${verseOut.payload.text}</div>
          <div class="search-query-verse-reference">– ${verseOut.payload.ref} KJV</div>
          <button class="search-query-verse-add-button">add</button>
        </div>`;
      verseContainer.querySelector(".search-query-verse-add-button")
        .addEventListener("click", () => addBibleVerse(`${verseOut.payload.ref} KJV`, verseOut.payload.text, false));
    }
  }

  // Songs
  displaySongResults(songsOut ? songsOut.payload : []);
}

function closeSearchQuery() {
  searchDrawerOpen = false;
  applyLayout(true);
  if (searchBar) searchQuery.textContent = `Search for "${searchBar.value}"`;
}

// ==================== Theme Toggle ====================
const toggle = document.getElementById("theme-toggle");
const body = document.body; const moonIcon = document.getElementById("moon-icon"); const sunIcon = document.getElementById("sun-icon");
function setTheme(isLight) {
  body.classList.toggle("light", isLight);
  localStorage.setItem("theme", isLight ? "light" : "dark");
  moonIcon.style.display = isLight ? "block" : "none";
  sunIcon.style.display = isLight ? "none" : "block";
}
setTheme(localStorage.getItem("theme") === "light");
toggle?.addEventListener("click", () => setTheme(!body.classList.contains("light")));

// ==================== Selection + Action buttons ====================
function updateActionButtonsEnabled() {
  const hasSelection = !!selectedItem;

  if (!hasSelection && isConnectMode) {
    isConnectMode = false;
  }

  if (connectBtn) {
    connectBtn.disabled = !hasSelection;
    connectBtn.style.background = hasSelection && isConnectMode ? "var(--accent)" : "var(--bg-seethroug)";
    const ic = connectBtn.querySelector(".action-icon");
    if (ic) ic.style.fill = (hasSelection && isConnectMode) ? "var(--bg)" : "var(--muted)";
  }

  if (deleteBtn) {
    deleteBtn.disabled = !hasSelection;
  }

  if (interlinearBtn) {
    const isVerse = !!selectedItem && selectedItem.classList.contains("bible-verse");
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
  if (touchMoved) return;
  const item = e.target.closest(".board-item");
  if (!item) { clearSelection(); return; }
  if (!isConnectMode) { selectItem(item); return; }
  if (selectedItem && item !== selectedItem) {
    connectItems(selectedItem, item);
    updateAllConnections();
    clearSelection();
  }
});
document.addEventListener("click", (e) => {
  const insideWorkspace = e.target.closest("#workspace");
  const insideAction = e.target.closest("#action-buttons-container");
  const insideSearch = e.target.closest("#search-container"); // Don't deselect when clicking search
  if (!insideWorkspace && !insideAction && !insideSearch) {
    // If click is *outside* search, close it
    if (!e.target.closest("#search-query-container") && !insideSearch) {
      closeSearchQuery();
    }
    clearSelection();
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { clearSelection(); closeInterlinearPanel(); closeSearchQuery(); } });

// ==================== Action buttons: Connect / Text / Delete ====================
connectBtn?.addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();
  if (!selectedItem) return;
  setConnectMode(!isConnectMode);
});
textBtn?.addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();
  addTextNote("New note");
});
deleteBtn?.addEventListener("click", (e) => {
  e.preventDefault(); e.stopPropagation();
  if (!selectedItem) return;
  removeConnectionsFor(selectedItem);
  try { selectedItem.remove(); } catch (_e) { }
  clearSelection();
  onBoardMutated("delete_item"); // AUTOSAVE
});

// ==================== Interlinear integration ====================
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
interClose?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); closeInterlinearPanel(); });

async function fetchInterlinear(book, chapter, verse, signal) {
  const base = `https://interlinear-api.onrender.com/interlinear/${encodeURIComponent(book)}/${chapter}/${verse}`;
  const prox = `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`;

  const ATTEMPTS = 3;
  const BASE_DELAY = 600; // 0ms, 600ms, 1200ms
  const TIMEOUT_PER_ATTEMPT = 6000; // 6 seconds

  let lastError = null;

  for (let i = 0; i < ATTEMPTS; i++) {
    if (signal.aborted) throw new Error("Fetch aborted by user");

    // Backoff delay
    if (i > 0) await new Promise(r => setTimeout(r, BASE_DELAY * i));

    // Create a signal that combines the overall abort with the per-attempt timeout
    const attemptController = new AbortController();
    const attemptSignal = attemptController.signal;
    const timeoutId = setTimeout(() => attemptController.abort(new Error('Fetch timeout')), TIMEOUT_PER_ATTEMPT);

    // Listen to the main signal to abort this attempt
    const abortListener = () => attemptController.abort(new Error('Fetch aborted by user'));
    signal.addEventListener('abort', abortListener);

    try {
      // --- Attempt 1: Direct Fetch (as requested) ---
      try {
        const r = await fetch(base, { method: "GET", mode: "cors", signal: attemptSignal });
        if (!r.ok) throw new Error(`Direct fetch bad status: ${r.status}`);
        const data = await r.json();
        clearTimeout(timeoutId); // Success
        signal.removeEventListener('abort', abortListener);
        return data;
      } catch (err) {
        lastError = err;
        if (signal.aborted || attemptSignal.aborted) throw err; // Don't retry if aborted
        console.warn(`Interlinear direct fetch failed (attempt ${i + 1}):`, err.message);
        // Fall through to proxy...
      }

      // --- Attempt 2: Proxy Fetch ---
      try {
        const r2 = await fetch(prox, { signal: attemptSignal });
        if (!r2.ok) throw new Error(`Proxy fetch bad status: ${r2.status}`);
        const data = await r2.json();
        clearTimeout(timeoutId); // Success
        signal.removeEventListener('abort', abortListener);
        return data;
      } catch (err2) {
        lastError = err2;
        if (signal.aborted || attemptSignal.aborted) throw err2; // Don't retry if aborted
        console.warn(`Interlinear proxy fetch failed (attempt ${i + 1}):`, err2.message);
        // Will loop to next attempt
      }

    } catch (attemptErr) {
      // This catches aborts
      lastError = attemptErr;
      if (signal.aborted) {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', abortListener);
        throw lastError; // Re-throw abort error
      }
      // Other errors will just let the loop continue
    } finally {
      // Clean up listeners for this attempt
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abortListener);
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
    reference = data.reference || `${data.book || ''} ${data.chapter || ''}:${data.verse || ''}`.trim();
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

  tokens.forEach(tok => {
    const surface = tok.surface || "";
    const english = tok.resolved_gloss || tok.translation || tok.gloss || "";
    const translit = tok.resolved_translit || tok.translit || "";
    const morph = tok.morph || "";
    const strongRaw = (tok.strong || "");
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
    row.querySelector(".interlinear-add").addEventListener("click", () => {
      addInterlinearCard({
        surface,
        english,
        translit,
        morph,
        strong,
        reference: interSubtitle.textContent
      });
    });

    frag.appendChild(row);
  });

  interList.innerHTML = "";
  interList.appendChild(frag);
}

// Parse selected verse reference ("– Genesis 1:1 KJV")
function parseSelectedVerseRef() {
  if (!selectedItem || !selectedItem.classList.contains("bible-verse")) return null;

  let rawRef = selectedItem.dataset.reference; // Prefer dataset

  if (!rawRef) {
    const refEl = selectedItem.querySelector(".verse-text-reference");
    if (!refEl) return null; // Guard against missing element
    rawRef = refEl.textContent || "";
  }
  
  // Sanitize text: remove leading dash, trailing version
  const cleanedRef = rawRef.replace("-", "").replace(/\s+KJV$/, "").trim();
  console.log(cleanedRef)

  if (!cleanedRef) return null;

  // Use robust parser from search.js
  const result = window.findBibleVerseReference ? window.findBibleVerseReference(cleanedRef) : null;

  if (result && result.book && result.chapter && result.verse) {
    return { book: result.book, chapter: result.chapter, verse: result.verse };
  }
  
  console.warn("Could not parse ref:", cleanedRef, result);
  return null;
}

// Button handler
interlinearBtn?.addEventListener("click", async (e) => {
  e.preventDefault(); e.stopPropagation();
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
    interError.textContent = "Couldn't parse verse reference from selected item.";
    interError.style.display = "block";
    interPanel.setAttribute("aria-busy", "false");
    interlinearInFlight = null;
    return;
  }

  try {
    const data = await fetchInterlinear(ref.book, ref.chapter, ref.verse, controller.signal);

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
async function fetchSongs(query, limit = 8) {
  if (!query) return [];
  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: query,
    entity: "song",
    limit: String(limit)
  }).toString()}`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("iTunes search failed");
    const data = await r.json();
    if (!Array.isArray(data.results)) return [];
    return data.results.map(x => ({
      id: x.trackId,
      title: x.trackName || "Unknown Title",
      artist: x.artistName || "Unknown Artist",
      album: x.collectionName || "",
      cover: (x.artworkUrl100 || "").replace("100x100bb", "200x200bb")
    }));
  } catch (e) {
    console.warn("Song search error:", e);
    return [];
  }
}

// ==================== Add song to whiteboard ====================
function addSongElement({ title, artist, cover }) {
  const el = document.createElement("div");
  el.classList.add("board-item", "song-item");
  el.style.position = "absolute";

  // Add robust data attributes for serialization
  el.dataset.type = "song";
  el.dataset.title = title || "";
  el.dataset.artist = artist || "";
  el.dataset.cover = cover || "";

  const vpRect = viewport.getBoundingClientRect();
  const visibleX = viewport.scrollLeft / scale, visibleY = viewport.scrollTop / scale;
  const visibleW = vpRect.width / scale, visibleH = vpRect.height / scale;
  const x = visibleX + (visibleW - 320) / 2;
  const y = visibleY + (visibleH - 90) / 2;
  el.style.left = `${x}px`; el.style.top = `${y}px`;

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
  el.dataset.vkey = (el.dataset.vkey || ("v_" + Math.random().toString(36).slice(2)));

  // keep your existing drag behavior
  el.addEventListener("mousedown", (e) => {
    if (typeof startDragMouse === "function") startDragMouse(el, e);
  });
  
  onBoardMutated("add_song"); // AUTOSAVE (safe)
  return el;
}

function displaySongResults(songs) {
  if (!songs || songs.length === 0) {
    if (songsHeader) songsHeader.style.display = "none";
    if (songsContainer) {
      songsContainer.style.display = "none";
      songsContainer.innerHTML = "";
    }
    return;
  }
  songsHeader.style.display = "block";
  songsContainer.style.display = "grid";
  songsContainer.innerHTML = "";
  songs.forEach(s => {
    const card = document.createElement("div");
    card.className = "song-card";
    card.innerHTML = `
      <img class="song-cover" src="${s.cover || ""}" alt="">
      <div class="song-meta">
        <div class="song-title">${s.title}</div>
        <div class="song-artist">${s.artist}</div>
      </div>
      <button class="song-add-btn">add</button>
    `;
    card.querySelector(".song-add-btn").addEventListener("click", () => {
      addSongElement(s);
    });
    songsContainer.appendChild(card);
  });
}

// ---------- AUTOSAVE: Wire title edit ----------
(function wireTitleAutosave(){
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
  
  const trigger = () => onBoardMutated("edit_title");
  
  el.addEventListener("input", trigger, { passive: true });
  el.addEventListener("change", trigger, { passive: true });
  if (el.isContentEditable) {
    el.addEventListener("keyup", trigger, { passive: true });
    el.addEventListener("blur", trigger, { passive: true });
  }
})();

// ---------- AUTOSAVE: MutationObserver Fallback ----------
(function initMutationObserver() {
  const observer = new MutationObserver((mutations) => {
    // Skip during restore or active drag
    if (window.__RESTORING_FROM_SUPABASE || active || touchDragElement) return;
    
    let needsSave = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        if (Array.from(m.addedNodes).some(n => n.classList?.contains('board-item')) ||
            Array.from(m.removedNodes).some(n => n.classList?.contains('board-item'))) {
           needsSave = true; break;
        }
      }
      if (m.type === 'attributes' && m.attributeName === 'style' && m.target.classList?.contains('board-item')) {
         // This catches programmatic style changes *not* done by user drag
         needsSave = true; break;
      }
    }
    if (needsSave) {
      onBoardMutated('observer_fallback');
    }
  });
  
  observer.observe(workspace, {
    childList: true,  // For .board-item adds/removes
    subtree: true,    // To catch .board-item anywhere under workspace
    attributes: true, // For style changes
    attributeFilter: ['style']
  });
})();


// ==================== Expose ====================
window.addBibleVerse = addBibleVerse;

// ==================== Serialization API ====================
function serializeBoard() {
  try {
    const items = Array.from(workspace.querySelectorAll(".board-item")).map(el => {
      const base = {
        vkey: itemKey(el),
        left: el.style.left,
        top: el.style.top,
        zIndex: el.style.zIndex || '10', // Default zIndex
        type: el.dataset.type || 'unknown'
      };

      // Grab all data attributes for type-specific data
      switch (base.type) {
        case 'verse':
          base.reference = el.dataset.reference;
          base.text = el.dataset.text;
          break;
        case 'note':
          base.text = el.querySelector('.text-content')?.innerHTML || ''; // Get live text
          break;
        case 'song':
          base.title = el.dataset.title;
          base.artist = el.dataset.artist;
          base.cover = el.dataset.cover;
          break;
        case 'interlinear':
          base.reference = el.dataset.reference;
          base.surface = el.dataset.surface;
          base.english = el.dataset.english;
          base.translit = el.dataset.translit;
          base.morph = el.dataset.morph;
          base.strong = el.dataset.strong;
          break;
      }
      return base;
    });

    const conns = connections.map(c => ({
      a: itemKey(c.itemA),
      b: itemKey(c.itemB)
    }));

    const title = document.getElementById("title-textbox")?.value || "";
    
    const viewportData = {
      scale,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop
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
    BoardAPI.clearBoard();

    // Restore title
    const titleEl = document.getElementById("title-textbox");
    if (titleEl) titleEl.value = data.title || "";

    // Restore items
    const itemEls = {}; // Map vkey -> element
    if (data.items) {
      data.items.forEach(item => {
        let el;
        try {
          switch (item.type) {
            case 'verse':
              el = addBibleVerse(item.reference, item.text, true); // Use true flag
              break;
            case 'note':
              el = addTextNote(item.text);
              break;
            case 'song':
              el = addSongElement(item); // Pass the whole item object
              break;
            case 'interlinear':
              el = addInterlinearCard(item); // Pass the whole item object
              break;
            default:
              console.warn("Unknown item type during restore:", item.type);
          }
          if (el) {
            el.style.left = item.left;
            el.style.top = item.top;
            el.style.zIndex = item.zIndex || '10';
            el.dataset.vkey = item.vkey; // CRITICAL: re-assign vkey
            itemEls[item.vkey] = el;
          }
        } catch (itemErr) {
          console.error("Failed to restore item:", item, itemErr);
        }
      });
    }

    // Restore connections
    if (data.connections) {
      data.connections.forEach(c => {
        const elA = itemEls[c.a];
        const elB = itemEls[c.b];
        if (elA && elB) connectItems(elA, elB);
      });
    }
    
    // Restore viewport *after* items are placed
    if (data.viewport) {
      BoardAPI.setScale(data.viewport.scale || 1);
      viewport.scrollLeft = data.viewport.scrollLeft || 0;
      viewport.scrollTop = data.viewport.scrollTop || 0;
      window.__restoredBoard = true; // Tell 'load' handler not to center
    }

    updateAllConnections();
    
  } catch (err) {
    console.error("❌ Error during board restore:", err);
    // Board is likely corrupt, clear it to be safe
    BoardAPI.clearBoard();
  } finally {
    window.__RESTORING_FROM_SUPABASE = false;
    // Trigger a 'soft' layout update
    setTimeout(() => {
        updateAllConnections();
        clampScroll();
    }, 50);
  }
}


// ===== expose a small API for the Supabase module (keep at end of script.js) =====
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
  addBibleVerse,        // (reference, text) => HTMLElement
  addTextNote,          // (text) => HTMLElement
  addInterlinearCard,   // ({surface, english, translit, morph, strong, reference}) => HTMLElement
  addSongElement,       // ({title, artist, cover}) => HTMLElement

  // connections management used during load/hydration
  getConnections: () => connections, // Expose for serialization
  connectItems,         // (aEl, bEl) => void
  disconnectLine,       // (svgPath) => void
  removeConnectionsFor, // (el) => void
  updateAllConnections, // () => void
  getElementByVKey: (key) => document.querySelector(`[data-vkey="${key}"]`),

  // stable key helper
  itemKey,              // (el) => string

  // Board clear for load/sign-out
  clearBoard: () => {
    // Clear elements
    workspace.querySelectorAll(".board-item").forEach(el => el.remove());
    // Clear connections
    svg.innerHTML = ''; // Fast way to remove all paths
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
  triggerAutosave: (reason) => console.warn("Persistence not initialized", reason),
  
  /**
   * (OVERWRITTEN BY persist-helper.js)
   * Triggers an immediate save, canceling any debounce.
   * @param {string} reason Why the save is being forced.
   */
  forceFlushSave: (reason) => console.warn("Persistence not initialized", reason),

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