// ==================== Bible Book API Codes ====================
const bibleBookCodes = {
  "Genesis":"GEN","Exodus":"EXO","Leviticus":"LEV","Numbers":"NUM","Deuteronomy":"DEU",
  "Joshua":"JOS","Judges":"JDG","Ruth":"RUT","1 Samuel":"1SA","2 Samuel":"2SA",
  "1 Kings":"1KI","2 Kings":"2KI","1 Chronicles":"1CH","2 Chronicles":"2CH","Ezra":"EZR",
  "Nehemiah":"NEH","Esther":"EST","Job":"JOB","Psalms":"PSA","Proverbs":"PRO",
  "Ecclesiastes":"ECC","Song of Solomon":"SNG","Isaiah":"ISA","Jeremiah":"JER",
  "Lamentations":"LAM","Ezekiel":"EZK","Daniel":"DAN","Hosea":"HOS","Joel":"JOL",
  "Amos":"AMO","Obadiah":"OBA","Jonah":"JON","Micah":"MIC","Nahum":"NAM","Habakkuk":"HAB",
  "Zephaniah":"ZEP","Haggai":"HAG","Zechariah":"ZEC","Malachi":"MAL","Matthew":"MAT",
  "Mark":"MRK","Luke":"LUK","John":"JHN","Acts":"ACT","Romans":"ROM",
  "1 Corinthians":"1CO","2 Corinthians":"2CO","Galatians":"GAL","Ephesians":"EPH",
  "Philippians":"PHP","Colossians":"COL","1 Thessalonians":"1TH","2 Thessalonians":"2TH",
  "1 Timothy":"1TI","2 Timothy":"2TI","Titus":"TIT","Philemon":"PHM","Hebrews":"HEB",
  "James":"JAS","1 Peter":"1PE","2 Peter":"2PE","1 John":"1JN","2 John":"2JN","3 John":"3JN",
  "Jude":"JUD","Revelation":"REV"
};

// ==================== Fetch Verse Text (uses KJV) ====================
async function fetchVerseText(book, chapter, verse) {
  // const proxy = "https://api.allorigins.win/raw?url=";
  // const code = bibleBookCodes[book] || book;
  // const apiUrl = `https://bible-api-5jrz.onrender.com/verse/KJV/${encodeURIComponent(code)}/${chapter}/${verse}`;
  // const url = proxy + encodeURIComponent(apiUrl);
  
  const proxy = "https://api.allorigins.win/raw?url=";
  const code = bibleBookCodes[book] || book;
  const url = `https://bible-api-5jrz.onrender.com/verse/KJV/${encodeURIComponent(code)}/${chapter}/${verse}`;
  // const url = encodeURIComponent(apiUrl);
  

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Network error");
    const data = await resp.json();
    if (data.text) return data.text;
    if (data.verses) return data.verses.map(v => v.text).join(" ");
    return "Verse not found.";
  } catch (err) {
    console.error("❌ Error fetching verse:", err);
    return "Error fetching verse.";
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

// Global action buttons
const connectBtn = document.getElementById("mobile-action-button");
const textBtn = document.getElementById("text-action-button");
const deleteBtn = document.getElementById("delete-action-button");

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
const DRAG_SLOP = 6; // px
let pendingMouseDrag = null;       // { item, startX, startY, offX, offY }
let pendingTouchDrag = null;       // { item, startX, startY, offX, offY }

// ==================== Helpers ====================
function clamp(v, a, b){ return Math.min(Math.max(v, a), b); }
function itemKey(el){ if(!el?.dataset?.vkey){ el.dataset.vkey = "v_"+Math.random().toString(36).slice(2);} return el.dataset.vkey; }

function clampScroll(){
  const maxLeft = Math.max(0, workspace.offsetWidth * scale - viewport.clientWidth);
  const maxTop  = Math.max(0, workspace.offsetHeight * scale - viewport.clientHeight);
  viewport.scrollLeft = clamp(viewport.scrollLeft, 0, maxLeft);
  viewport.scrollTop  = clamp(viewport.scrollTop, 0, maxTop);
}

function applyZoom(e, deltaScale){
  const old = scale, next = clamp(old + deltaScale, MIN_SCALE, MAX_SCALE);
  if (Math.abs(next - old) < 1e-9) return false;

  const vpRect = viewport.getBoundingClientRect();
  const vpX = e.clientX - vpRect.left, vpY = e.clientY - vpRect.top;
  const worldX = (viewport.scrollLeft + vpX) / old;
  const worldY = (viewport.scrollTop + vpY) / old;

  scale = next;
  workspace.style.transformOrigin = "top left";
  workspace.style.transform = `scale(${scale})`;
  viewport.scrollLeft = worldX * scale - vpX;
  viewport.scrollTop  = worldY * scale - vpY;
  clampScroll(); updateAllConnections();
  return true;
}

// ==================== Pan / Zoom ====================
viewport.addEventListener("mousedown", (e) => {
  if (e.target.closest(".board-item")) return;
  isPanning = true; viewport.style.cursor = "grabbing";
  startX = e.clientX; startY = e.clientY;
  scrollLeft = viewport.scrollLeft; scrollTop = viewport.scrollTop;
});
window.addEventListener("mouseup", () => { isPanning = false; viewport.style.cursor = "grab"; });
window.addEventListener("mousemove", (e) => {
  if (!isPanning && !active) {
    // Check for drag-from-text activation
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
    viewport.scrollTop  = scrollTop  - (e.clientY - startY);
    clampScroll(); updateAllConnections();
  } else if (active) {
    dragMouseTo(e.clientX, e.clientY);
  }
});

viewport.addEventListener("wheel", (e) => {
  const pixels = (e.deltaMode===1 ? e.deltaY*16 : (e.deltaMode===2 ? e.deltaY*viewport.clientHeight : e.deltaY));
  const changed = applyZoom(e, -pixels*(e.ctrlKey ? PINCH_SENS : WHEEL_SENS));
  if (changed) e.preventDefault();
},{passive:false});
window.addEventListener("load", () => {
  viewport.scrollLeft = (workspace.scrollWidth - viewport.clientWidth)/2;
  viewport.scrollTop  = (workspace.scrollHeight - viewport.clientHeight)/2;
  workspace.style.transformOrigin = "top left";
  workspace.style.transform = `scale(${scale})`;
  updateAllConnections();
  updateActionButtonsEnabled(); // start disabled where applicable
  // If browser ever selects inside contenteditable, prevent dragging side-effects
  document.addEventListener("mouseup", ()=>{ pendingMouseDrag = null; }, true);
});
window.addEventListener("resize", updateAllConnections);

// Touch pan + pinch
let touchStartDistance = 0, lastScale = 1;
function getTouchDistance(t){ const dx=t[0].clientX - t[1].clientX, dy=t[0].clientY - t[1].clientY; return Math.hypot(dx,dy); }
function getTouchMidpoint(t){ return { x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2 }; }

viewport.addEventListener("touchstart",(e)=>{
  if (e.touches.length===1){ isTouchPanning=true; startX=e.touches[0].clientX; startY=e.touches[0].clientY;
    scrollLeft=viewport.scrollLeft; scrollTop=viewport.scrollTop; }
  else if (e.touches.length===2){ isTouchPanning=false; touchStartDistance=getTouchDistance(e.touches); lastScale=scale; }
},{passive:false});
viewport.addEventListener("touchmove",(e)=>{
  if (e.touches.length===1 && isTouchPanning && !isConnectMode && !touchDragElement){
    viewport.scrollLeft = scrollLeft - (e.touches[0].clientX - startX);
    viewport.scrollTop  = scrollTop  - (e.touches[0].clientY - startY);
    clampScroll(); updateAllConnections();
  } else if (e.touches.length===2){
    e.preventDefault();
    const newDistance = getTouchDistance(e.touches);
    const scaleDelta = (newDistance - touchStartDistance) * PINCH_SENS;
    const newScale = clamp(lastScale + scaleDelta, MIN_SCALE, MAX_SCALE);
    const mid = getTouchMidpoint(e.touches);
    applyZoom({clientX:mid.x, clientY:mid.y}, newScale - scale);
  }
},{passive:false});
viewport.addEventListener("touchend",()=>{ isTouchPanning=false; },{passive:true});

// ==================== Drag board items (mouse) ====================
workspace.addEventListener("mousedown",(e)=>{
  if (isConnectMode) return;
  const item = e.target.closest(".board-item");
  if (!item) return;

  // If the press began on editable text, defer drag until the cursor moves beyond a slop.
  const onEditable = !!e.target.closest('[contenteditable="true"], textarea.text-content');
  if (onEditable) {
    const rect = item.getBoundingClientRect();
    pendingMouseDrag = {
      item,
      startX: e.clientX,
      startY: e.clientY,
      offX: (e.clientX - rect.left) / scale,
      offY: (e.clientY - rect.top ) / scale
    };
    return; // don't start drag yet
  }

  startDragMouse(item, e);
});

window.addEventListener("mouseup",()=>{
  if (active) active.style.cursor="grab";
  active=null;
  pendingMouseDrag = null;
});

// helpers for mouse drag
function startDragMouse(item, eOrPoint, offX, offY){
  active = item; currentIndex += 1; item.style.zIndex = currentIndex; item.style.cursor="grabbing";
  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    offsetX = (eOrPoint.clientX - rect.left) / scale;
    offsetY = (eOrPoint.clientY - rect.top)  / scale;
  } else {
    offsetX = offX; offsetY = offY;
  }
}
function dragMouseTo(clientX, clientY){
  const newLeft = (viewport.scrollLeft + clientX) / scale - offsetX;
  const newTop  = (viewport.scrollTop  + clientY) / scale - offsetY;
  const maxLeft = workspace.offsetWidth  - active.offsetWidth;
  const maxTop  = workspace.offsetHeight - active.offsetHeight;
  active.style.left = clamp(newLeft,0,maxLeft)+"px";
  active.style.top  = clamp(newTop,0,maxTop)+"px";
  updateAllConnections();
}

// ==================== Drag board items (touch) ====================
workspace.addEventListener("touchstart",(e)=>{
  if (isConnectMode || e.touches.length!==1) return;
  const item = e.target.closest(".board-item");
  if (!item) return;

  const onEditable = !!e.target.closest('[contenteditable="true"], textarea.text-content');
  const t = e.touches[0];
  const rect = item.getBoundingClientRect();
  pendingTouchDrag = {
    item,
    startX: t.clientX,
    startY: t.clientY,
    offX: (t.clientX - rect.left)/scale,
    offY: (t.clientY - rect.top )/scale
  };
},{passive:true});

workspace.addEventListener("touchmove",(e)=>{
  if (isConnectMode) return;
  const t = e.touches[0];
  // Activate deferred drag after threshold
  if (pendingTouchDrag && !touchDragElement) {
    const dx = t.clientX - pendingTouchDrag.startX;
    const dy = t.clientY - pendingTouchDrag.startY;
    if (Math.hypot(dx, dy) > DRAG_SLOP) {
      startDragTouch(pendingTouchDrag.item, t, pendingTouchDrag.offX, pendingTouchDrag.offY);
      pendingTouchDrag = null;
    }
  }
  if (!touchDragElement) return;
  e.preventDefault(); touchMoved=true;
  dragTouchTo(t);
},{passive:false});

workspace.addEventListener("touchend",()=>{
  if (!touchDragElement) { pendingTouchDrag = null; return; }
  touchDragElement=null;
  setTimeout(()=>{touchMoved=false;},0);
},{passive:true});

// helpers for touch drag
function startDragTouch(item, touchPoint, offX, offY){
  touchDragElement = item; touchMoved=false; isTouchPanning=false;
  currentIndex += 1; item.style.zIndex = currentIndex;
  if (offX == null || offY == null) {
    const rect = item.getBoundingClientRect();
    touchDragOffset.x = (touchPoint.clientX - rect.left)/scale;
    touchDragOffset.y = (touchPoint.clientY - rect.top )/scale;
  } else {
    touchDragOffset.x = offX; touchDragOffset.y = offY;
  }
}
function dragTouchTo(touchPoint){
  const vp=viewport.getBoundingClientRect();
  const x=(viewport.scrollLeft + (touchPoint.clientX - vp.left))/scale - touchDragOffset.x;
  const y=(viewport.scrollTop  + (touchPoint.clientY - vp.top ))/scale - touchDragOffset.y;
  const maxLeft = workspace.offsetWidth  - touchDragElement.offsetWidth;
  const maxTop  = workspace.offsetHeight - touchDragElement.offsetHeight;
  touchDragElement.style.left = `${clamp(x,0,maxLeft)}px`;
  touchDragElement.style.top  = `${clamp(y,0,maxTop)}px`;
  updateAllConnections();
}

// ==================== Connections ====================
let connections=[];
function connectionExists(a,b){
  const ka=itemKey(a), kb=itemKey(b);
  return connections.some(c=>{
    const ca=itemKey(c.itemA), cb=itemKey(c.itemB);
    return (ca===ka&&cb===kb)||(ca===kb&&cb===ka);
  });
}
function updateConnection(path, el1, el2){
  const vpRect = viewport.getBoundingClientRect();
  const r1 = el1.getBoundingClientRect(), r2 = el2.getBoundingClientRect();
  const p1 = { x:(viewport.scrollLeft + (r1.left - vpRect.left) + r1.width/2)/scale,
               y:(viewport.scrollTop  + (r1.top  - vpRect.top ) + r1.height/2)/scale };
  const p2 = { x:(viewport.scrollLeft + (r2.left - vpRect.left) + r2.width/2)/scale,
               y:(viewport.scrollTop  + (r2.top  - vpRect.top ) + r2.height/2)/scale };
  const dx=p2.x-p1.x, dy=p2.y-p1.y, absDx=Math.abs(dx), absDy=Math.abs(dy);
  if (absDx<40 || absDy<40){ path.setAttribute("d",`M${p1.x},${p1.y} L${p2.x},${p2.y}`); return; }
  const s=0.7; let c1x=p1.x, c1y=p1.y, c2x=p2.x, c2y=p2.y;
  if (absDx>absDy){ c1x+=dx*s; c2x-=dx*s; c1y+=dy*0.1; c2y-=dy*0.1; }
  else { c1y+=dy*s; c2y-=dy*s; c1x+=dx*0.1; c2x-=dx*0.1; }
  path.setAttribute("d",`M${p1.x},${p1.y} C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`);
}
function updateAllConnections(){ connections.forEach(({path,itemA,itemB})=>updateConnection(path,itemA,itemB)); }
function connectItems(a,b){
  if (!a || !b || a===b || connectionExists(a,b)) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg","path");
  path.classList.add("connection-line"); path.style.pointerEvents="stroke";
  path.addEventListener("click",(e)=>{ e.stopPropagation(); disconnectLine(path); });
  svg.appendChild(path); connections.push({ path, itemA:a, itemB:b }); updateConnection(path,a,b);
}
function disconnectLine(path){
  const idx = connections.findIndex(c=>c.path===path);
  if (idx!==-1){ try{ svg.removeChild(connections[idx].path);}catch(_e){} connections.splice(idx,1); }
}
function removeConnectionsFor(el){
  connections = connections.filter(c=>{
    if (c.itemA===el || c.itemB===el){
      try{ svg.removeChild(c.path);}catch(_e){}
      return false;
    }
    return true;
  });
}

// ==================== Element Creation ====================
function addBibleVerse(reference, text){
  const el = document.createElement("div");
  el.classList.add("board-item","bible-verse");
  el.style.position="absolute";

  const vpRect=viewport.getBoundingClientRect();
  const visibleX=viewport.scrollLeft/scale, visibleY=viewport.scrollTop/scale;
  const visibleW=vpRect.width/scale, visibleH=vpRect.height/scale;
  const randX = visibleX + Math.random()*(visibleW-300);
  const randY = visibleY + Math.random()*(visibleH-200);
  el.style.left=`${randX}px`; el.style.top=`${randY}px`;

  el.innerHTML = `
    <div id="bible-text-content">
      <div class="verse-text">VERSE</div>
      <div class="verse-text-content">${text}</div>
      <div class="verse-text-reference">– ${reference}</div>
    </div>
  `;
  workspace.appendChild(el);
  el.dataset.vkey = itemKey(el);

  // desktop drag (non-editable areas)
  el.addEventListener("mousedown",(e)=>{
    if (isConnectMode || e.target.closest('[contenteditable="true"], textarea.text-content')) return;
    startDragMouse(el, e);
  });

  return el;
}

function addTextNote(initial="New note"){
  const el = document.createElement("div");
  el.classList.add("board-item","text-note");
  el.style.position="absolute";

  const vpRect=viewport.getBoundingClientRect();
  const visibleX=viewport.scrollLeft/scale, visibleY=viewport.scrollTop/scale;
  const visibleW=vpRect.width/scale, visibleH=vpRect.height/scale;
  const x = visibleX + (visibleW-300)/2;
  const y = visibleY + (visibleH-50)/2;
  el.style.left=`${x}px`; el.style.top=`${y}px`;

  // Structure: NOTE header + editable body (contenteditable div)
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

  // --- Drag from header OR body with threshold ---
  header.addEventListener("mousedown",(e)=>{ if (!isConnectMode) startDragMouse(el, e); });
  el.addEventListener("mousedown",(e)=>{
    if (isConnectMode) return;
    // If clicking inside body, defer drag until movement exceeds slop
    if (e.target === body || e.target.closest(".text-content")) {
      const rect = el.getBoundingClientRect();
      pendingMouseDrag = {
        item: el,
        startX: e.clientX,
        startY: e.clientY,
        offX: (e.clientX - rect.left) / scale,
        offY: (e.clientY - rect.top ) / scale
      };
      return;
    }
    startDragMouse(el, e);
  });

  // Touch: start from anywhere and defer until slop exceeded
  el.addEventListener("touchstart",(e)=>{
    if (isConnectMode || e.touches.length!==1) return;
    const t = e.touches[0];
    const rect = el.getBoundingClientRect();
    pendingTouchDrag = {
      item: el,
      startX: t.clientX,
      startY: t.clientY,
      offX: (t.clientX - rect.left)/scale,
      offY: (t.clientY - rect.top )/scale
    };
  },{passive:true});

  el.addEventListener("touchmove",(e)=>{
    if (isConnectMode) return;
    const t = e.touches[0];
    if (pendingTouchDrag && !touchDragElement) {
      const dx = t.clientX - pendingTouchDrag.startX;
      const dy = t.clientY - pendingTouchDrag.startY;
      if (Math.hypot(dx,dy) > DRAG_SLOP) {
        startDragTouch(pendingTouchDrag.item, t, pendingTouchDrag.offX, pendingTouchDrag.offY);
        pendingTouchDrag = null;
      }
    }
    if (!touchDragElement) return;
    e.preventDefault(); touchMoved=true;
    dragTouchTo(t);
  },{passive:false});

  el.addEventListener("touchend",()=>{
    if (!touchDragElement) { pendingTouchDrag = null; return; }
    touchDragElement=null;
    setTimeout(()=>{touchMoved=false;},0);
  },{passive:true});

  // Select and focus for quick typing
  selectItem(el);
  setTimeout(()=>{ body.focus(); document.getSelection()?.selectAllChildren(body); }, 0);

  return el;
}

// ==================== Search UI glue ====================
function searchForQueryFromSuggestion(reference){ searchBar.value = reference; searchForQuery(); }
function displaySearchVerseOption(reference, text){
  searchQueryFullContainer.style.display="flex"; loader.style.display="none";
  const verseContainer=document.getElementById("search-query-verse-container");
  verseContainer.innerHTML=""; const version="KJV";
  const item=document.createElement("div"); item.classList.add("search-query-verse-container");
  item.innerHTML = `
    <div class="search-query-verse-text">${text}</div>
    <div class="search-query-verse-reference">– ${reference} ${version}</div>
    <button class="search-query-verse-add-button" onclick="closeSearchQuery()">add</button>`;
  item.querySelector(".search-query-verse-add-button").addEventListener("click",()=>{ addBibleVerse(`${reference} ${version}`, text); });
  verseContainer.appendChild(item);
}

// ==================== Search (relies on findBibleVerseReference from search.js) ====================
async function searchForQuery(event){
  const input=document.getElementById("search-bar"); input.blur();
  if (event) event.preventDefault();
  didYouMeanText.style.display="none"; searchQueryFullContainer.style.display="none"; loader.style.display="flex";
  mainContentContainer.style.transition=".25s"; mainContentContainer.style.width="calc(100% - 300px)";
  searchQueryContainer.style.transition=".25s"; searchQueryContainer.style.left="calc(100% - 300px)";

  const query=searchBar.value.trim();
  searchQuery.textContent=`Search for "${query}"`;
  setTimeout(()=>{ mainContentContainer.style.transition="0s"; searchQueryContainer.style.transition="0s"; },250);

  const result = findBibleVerseReference(query);
  if (result && result.didYouMean){
    didYouMeanText.style.display="flex";
    didYouMeanText.innerHTML = `Did you mean: <div onclick="searchForQueryFromSuggestion('${result.reference}')">${result.reference}</div>?`;
  }
  if (!result){ loader.style.display="none"; return false; }

  if (result.book){
    const verseText = await fetchVerseText(result.book, result.chapter||1, result.verse||1);
    displaySearchVerseOption(result.reference, verseText);
  }
  return false;
}
function closeSearchQuery(){
  mainContentContainer.style.transition=".25s"; mainContentContainer.style.width="100%";
  searchQueryContainer.style.transition=".25s"; searchQueryContainer.style.left="100%";
  searchQuery.textContent = `Search for "${searchBar.value}"`;
  setTimeout(()=>{ mainContentContainer.style.transition="0s"; searchQueryContainer.style.transition="0s"; },250);
}

// ==================== Theme Toggle ====================
const toggle=document.getElementById("theme-toggle");
const body=document.body; const moonIcon=document.getElementById("moon-icon"); const sunIcon=document.getElementById("sun-icon");
function setTheme(isLight){
  body.classList.toggle("light",isLight);
  localStorage.setItem("theme", isLight ? "light":"dark");
  moonIcon.style.display = isLight ? "block":"none";
  sunIcon.style.display  = isLight ? "none":"block";
}
setTheme(localStorage.getItem("theme")==="light");
toggle?.addEventListener("click",()=> setTheme(!body.classList.contains("light")));

// ==================== Selection + Action buttons ====================
function updateActionButtonsEnabled(){
  const hasSelection = !!selectedItem;

  // If nothing is selected, ensure connect mode is off WITHOUT causing recursion
  if (!hasSelection && isConnectMode) {
    isConnectMode = false; // do NOT call setConnectMode() here
  }

  if (connectBtn){
    connectBtn.disabled = !hasSelection;
    connectBtn.style.background = hasSelection && isConnectMode ? "var(--accent)" : "var(--bg-seethroug)";
    const ic = connectBtn.querySelector(".action-icon");
    if (ic) ic.style.fill = hasSelection && isConnectMode ? "var(--bg)" : "var(--muted)";
  }

  if (deleteBtn){
    deleteBtn.disabled = !hasSelection;
  }
}

// Replace your setConnectMode with this:
function setConnectMode(on){
  const next = !!on;
  if (isConnectMode === next) return; // guard: no-op if unchanged
  isConnectMode = next;
  updateActionButtonsEnabled();
}


function selectItem(el){
  if (!el) return;
  if (selectedItem && selectedItem !== el){
    selectedItem.classList.remove("selected-connection");
  }
  selectedItem = el;
  el.classList.add("selected-connection");
  updateActionButtonsEnabled();
}

function clearSelection(){
  if (selectedItem) selectedItem.classList.remove("selected-connection");
  selectedItem = null;
  setConnectMode(false);
  updateActionButtonsEnabled();
}

// Global click: selection / connection flow
workspace.addEventListener("click",(e)=>{
  if (touchMoved) return; // ignore click after touch drag
  const item = e.target.closest(".board-item");

  if (!item){
    clearSelection();
    return;
  }

  if (!isConnectMode){
    selectItem(item);
    return;
  }

  // If in connect mode and we have a selection, connect to the clicked item (if different)
  if (selectedItem && item !== selectedItem){
    connectItems(selectedItem, item);
    updateAllConnections();
    clearSelection(); // exit after connecting
  }
});

// Clicking outside workspace clears selection
document.addEventListener("click",(e)=>{
  const insideWorkspace = e.target.closest("#workspace");
  const insideAction = e.target.closest("#action-buttons-container");
  if (!insideWorkspace && !insideAction) clearSelection();
});

// Esc key cancels and clears selection
document.addEventListener("keydown",(e)=>{ if (e.key==="Escape") clearSelection(); });

// ==================== Action buttons: Connect / Text / Delete ====================
connectBtn?.addEventListener("click",(e)=>{
  e.preventDefault(); e.stopPropagation();
  if (!selectedItem) return; // disabled covers this
  setConnectMode(!isConnectMode);
});

textBtn?.addEventListener("click",(e)=>{
  e.preventDefault(); e.stopPropagation();
  addTextNote("New note");
});

deleteBtn?.addEventListener("click",(e)=>{
  e.preventDefault(); e.stopPropagation();
  if (!selectedItem) return;
  removeConnectionsFor(selectedItem);
  try{ selectedItem.remove(); } catch(_e){}
  clearSelection();
});

// ==================== Expose for other modules (optional) ====================
window.addBibleVerse = addBibleVerse;
