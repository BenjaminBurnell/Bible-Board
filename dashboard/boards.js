// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "../supabaseClient.js";

const BUCKET = "bible-boards";

// --- State ---
let currentUser = null;
let currentModalBoard = null; // Stores {id, path, title} for the modal
let activeMenu = null; // Stores the currently open three-dot menu
let activeDropdown = null; // <--- NEW: Required for the 3-dot menu

// --- DOM Refs ---
const signoutBtn = document.getElementById("signout-btn-sidebar");
const deleteModalBackdrop = document.getElementById("delete-modal-backdrop");
const confirmDeleteBtn = document.getElementById("confirm-delete-btn");
let boardToDelete = null; // <--- MAKE SURE THIS IS HERE
const boardGrid = document.getElementById("board-grid");
const filterInput = document.getElementById("board-filter");
const sortSelect = document.getElementById("board-sort");
const sidebarBoardsContainer = document.getElementById("sidebar-boards-container");
const hamburgerBtn = document.getElementById("hamburger-btn")

// Fix: Ensure button exists before using
// FIX: Look for the sidebar button if the main one doesn't exist
const newBoardBtn = document.getElementById("new-board-btn") || document.getElementById("new-board-btn-sidebar");

// Modal elements
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitleInput = document.getElementById("modal-title-input");
const modalSaveBtn = document.getElementById("modal-save-btn");
const modalDeleteBtn = document.getElementById("modal-delete-btn");

// Status tile (Created dynamically)
const statusTile = document.createElement("div");
statusTile.id = "status-message";
statusTile.className = "status-tile hidden"; 
// We don't append it here immediately, renderStatus handles it

// ==================== Theme Toggle ====================
const toggle = document.getElementById("theme-toggle");
const body = document.body;
const moonIcon = document.getElementById("moon-icon");
const sunIcon = document.getElementById("sun-icon");

function setTheme(isLight) {
  body.classList.toggle("light", isLight);
  localStorage.setItem("theme", isLight ? "light" : "dark");
  if (moonIcon) moonIcon.style.display = isLight ? "block" : "none";
  if (sunIcon) sunIcon.style.display = isLight ? "none" : "block";
}
setTheme(localStorage.getItem("theme") === "light");
toggle?.addEventListener("click", () =>
  setTheme(!body.classList.contains("light"))
);

/** Renders loading/empty/error states */
function renderStatus(msg) {
  const statusEl = document.getElementById("sidebar-status");

  if (!statusEl) return;

  if (!msg || msg.trim() === "") {
    statusEl.textContent = "";
    statusEl.style.display = "none";
    return;
  }

  statusEl.textContent = msg;
  statusEl.style.display = "block";
}


function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

function applySort(arr, sortKey) {
  const a = [...arr];
  switch (sortKey) {
    case "updatedAsc":
      return a.sort((x, y) => new Date(x.updatedAt) - new Date(y.updatedAt));
    case "titleAsc":
      return a.sort((x, y) => normalize(x.title).localeCompare(normalize(y.title)));
    case "titleDesc":
      return a.sort((x, y) => normalize(y.title).localeCompare(normalize(x.title)));
    case "updatedDesc":
    default:
      return a.sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
  }
}

function applyFilter(arr, query) {
  const q = normalize(query);
  if (!q) return arr;

  return arr.filter((b) => {
    const title = normalize(b.title);
    const desc = normalize(b.description || "");
    return title.includes(q) || desc.includes(q);
  });
}

function getDateGroup(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();

  const diffDays = (now - date) / (1000 * 60 * 60 * 24);

  if (diffDays < 1) return "Today";
  if (diffDays < 2) return "Yesterday";
  if (diffDays < 7) return "Last 7 Days";
  if (diffDays < 30) return "Last 30 Days";
  return "Older";
}

// --- NEW: Helper to switch boards without reloading ---
async function switchBoard(boardId, ownerId) {
  // 1. Update URL silently
  const newUrl = new URL(window.location);
  newUrl.searchParams.set('board', boardId);
  if (ownerId) newUrl.searchParams.set('owner', ownerId);
  window.history.pushState({}, "", newUrl);

  // 2. Update Sidebar Active State
  // FIX: Target .sidebar-board-item (the wrapper) instead of .sidebar-board
  const allItems = document.querySelectorAll('.sidebar-board-item');
  allItems.forEach(item => {
    if (item.dataset.id === boardId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // 3. Dispatch Custom Event for the Board Loader
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('bibleboard:load', { 
      detail: { boardId, ownerId } 
    }));
  }, 10);
  
  // Optional: close mobile sidebar if open
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  if (sidebar && sidebar.classList.contains("expanded") && window.innerWidth < 900) {
     sidebar.classList.remove("expanded");
     sidebar.classList.add("offscreen");
     if (overlay) overlay.classList.add("hidden");
  }
}



// Keep loaded boards in memory for filtering/sorting
let loadedBoards = [];

const navbar = document.getElementById("nav-bar");

window.addEventListener("scroll", () => {
  // Safety check
  if (!navbar) return;

  const scrollTop =
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0;

  // --- Configuration ---
  const START_FADE = 25;
  const END_FADE   = 125;

  // --- Calculate Strength (0 to 1) ---
  let strength = (scrollTop - START_FADE) / (END_FADE - START_FADE);
  strength = Math.min(Math.max(strength, 0), 1);

  // --- Apply Styles ---
  if (strength <= 0) {
    navbar.style.background     = "transparent";
    navbar.style.backdropFilter = "none";
    navbar.style.borderBottom   = "none"; 
  } else {
    const bgOpacity     = 0.5 * strength;
    const blurAmountRem = 1.5 * strength;
    const borderOpacity = 0.8 * strength;

    navbar.style.background     = `rgba(23, 23, 23, ${bgOpacity})`;
    navbar.style.backdropFilter = `blur(${blurAmountRem}rem)`;
    navbar.style.borderBottom   = `1px solid rgba(47, 47, 47, ${borderOpacity})`;
  }
});

// ==================== MENU & MODAL HELPERS ====================

function closeDropdown() {
  if (activeDropdown) {
    activeDropdown.classList.remove('show');
    activeDropdown = null;
  }
}

function openModal(board) {
  currentModalBoard = board;
  const titleInput = document.getElementById("modal-title-input");
  const backdrop = document.getElementById("modal-backdrop");
  
  if (titleInput) titleInput.value = board.title || "";
  if (backdrop) backdrop.classList.remove("hidden");
  if (titleInput) titleInput.focus();
  
  closeDropdown();
}

// Make globally available for the HTML 'Cancel' button
window.closeModal = function() {
  const backdrop = document.getElementById("modal-backdrop");
  if (backdrop) backdrop.classList.add("hidden");
  currentModalBoard = null;
};

// --- RENAME LOGIC ---
async function handleRename() {
  if (!currentModalBoard) return;
  const modalTitleInput = document.getElementById("modal-title-input");
  const modalSaveBtn = document.getElementById("modal-save-btn");

  const newTitle = modalTitleInput.value.trim();
  if (!newTitle) return;

  if (modalSaveBtn) {
    modalSaveBtn.textContent = "Saving...";
    modalSaveBtn.disabled = true;
  }

  try {
    const { id, path } = currentModalBoard;
    
    // 1. Download current JSON
    const { data: blob } = await sb.storage.from("bible-boards").download(path);
    const text = await blob.text();
    const json = JSON.parse(text);

    // 2. Update Title
    json.title = newTitle;
    json.updatedAt = new Date().toISOString();

    // 3. Upload back
    const newBlob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const { error } = await sb.storage.from("bible-boards").update(path, newBlob, {
       contentType: "application/json", cacheControl: "0", upsert: true 
    });

    if (error) throw error;

    // 4. Refresh UI
    await loadBoards(); 
    
    // Update title box immediately if this is the active board
    const params = new URLSearchParams(window.location.search);
    if (params.get('board') === id) {
       const titleBox = document.getElementById("title-textbox");
       if (titleBox) titleBox.value = newTitle;
    }

    window.closeModal();

  } catch (err) {
    console.error("Rename failed:", err);
    alert("Failed to rename board.");
  } finally {
    if (modalSaveBtn) {
      modalSaveBtn.textContent = "Save";
      modalSaveBtn.disabled = false;
    }
  }
}

// Renamed to performDelete to imply it does the work immediately
async function performDelete(board) {
  console.log("Starting delete for:", board); 

  const btn = document.getElementById("confirm-delete-btn");
  if (btn) {
    btn.textContent = "Deleting...";
    btn.disabled = true;
  }

  try {
    const { id, path } = board;

    // 1. Check if we are deleting the currently active board
    const params = new URLSearchParams(window.location.search);
    const isActiveBoard = (params.get('board') === id);
    
    // --- CRITICAL FIX: SWITCH AWAY FIRST ---
    // We must navigate away from this board BEFORE we delete it.
    // This ensures auto-savers save the *next* board, not the one we are killing.
    if (isActiveBoard) {
       console.log("Active board detected. Switching context first...");
       
       // Find a different board to switch to
       const nextBoard = loadedBoards.find(b => b.id !== id);
       
       if (nextBoard) {
         // Switch to the next available board immediately
         switchBoard(nextBoard.id, currentUser.id);
       } else {
         // If no boards left, clear the URL manually
         const newUrl = new URL(window.location);
         newUrl.searchParams.delete('board');
         newUrl.searchParams.delete('owner');
         window.history.pushState({}, "", newUrl);
         
         // Dispatch empty load event to kill active listeners
         window.dispatchEvent(new CustomEvent('bibleboard:load', { 
           detail: { boardId: null, ownerId: null } 
         }));
         
         // Clear the title box visually
         const titleBox = document.getElementById("title-textbox");
         if (titleBox) titleBox.value = "";
       }

       // WAIT: Give the auto-saver 500ms to realize we moved
       // This prevents the "Save on Unload" zombie effect
       await new Promise(resolve => setTimeout(resolve, 500));
    }
    // ---------------------------------------

    // 2. Supabase Delete (Now safe to run)
    const { error } = await sb.storage.from("bible-boards").remove([path]);
    if (error) throw error;

    console.log("Supabase delete success.");

    // 3. Update Memory & Sidebar
    loadedBoards = loadedBoards.filter(b => b.id !== id);
    renderSidebarBoards(loadedBoards);

    // 4. If we had no boards left and just deleted the last one, create a new one
    if (isActiveBoard && loadedBoards.length === 0) {
       await handleNewBoard();
    }

    closeDeleteModal();
    
    // 5. Background Refresh
    loadBoards(); 

  } catch (err) {
    console.error("Delete failed:", err);
    alert("Failed to delete board.");
    
    // If delete failed, reload to sync state
    window.location.reload();
  } finally {
    if (btn) {
      btn.textContent = "Delete";
      btn.disabled = false;
    }
  }
}

// ==================== GLOBAL CONTEXT MENU ====================

// Create the menu element once and append to body
const contextMenuEl = document.createElement('div');
contextMenuEl.id = 'board-context-menu';
contextMenuEl.innerHTML = `
  <button id="ctx-rename" class="menu-option">
    <span class="material-symbols-outlined" style="font-size:16px">edit</span> Rename
  </button>
  <button id="ctx-delete" class="menu-option delete">
    <span class="material-symbols-outlined" style="font-size:16px">delete</span> Delete
  </button>
`;
document.body.appendChild(contextMenuEl);

// Wire up the global buttons
document.getElementById('ctx-rename').addEventListener('click', (e) => {
  e.stopPropagation();
  closeContextMenu();
  if (currentModalBoard) openModal(currentModalBoard);
});

// In your Context Menu setup:
document.getElementById('ctx-delete').addEventListener('click', (e) => {
  e.stopPropagation();
  closeContextMenu();
  
  // CHANGE THIS LINE:
  // OLD: handleDelete(); 
  // NEW:
  if (currentModalBoard) openDeleteModal(currentModalBoard); 
});

function closeContextMenu() {
  contextMenuEl.classList.remove('show');
}

function openContextMenu(e, board) {
  e.preventDefault();
  e.stopPropagation();
  
  currentModalBoard = board; // Set the active board for actions

  // 1. Calculate Position
  const rect = e.currentTarget.getBoundingClientRect();
  let top = rect.bottom + 5;
  let left = rect.right - 130; // Align right edge (approx width)

  // 2. Boundary Check (Flip up if at bottom of screen)
  if (top + 100 > window.innerHeight) {
    top = rect.top - 90; // Move above button
  }

  // 3. Apply
  contextMenuEl.style.top = `${top}px`;
  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.classList.add('show');
}

// ... (Keep your existing Open/Close Modal functions below this) ...


window.closeModal = function() {
  const backdrop = document.getElementById("modal-backdrop");
  if (backdrop) backdrop.classList.add("hidden");
  currentModalBoard = null;
};

function renderSidebarBoards(boards) {
  const container = document.getElementById("sidebar-boards-container");
  if (!container) return;
  container.innerHTML = "";

  if (!boards || boards.length === 0) return;
  if (!currentUser) return;
  const ownerId = currentUser.id;

  const groups = {};
  boards.forEach(board => {
    const group = getDateGroup(board.updatedAt || board.createdAt);
    if (!groups[group]) groups[group] = [];
    groups[group].push(board);
  });

  const order = ["Today", "Yesterday", "Last 7 Days", "Last 30 Days", "Older"];

  order.forEach(group => {
    if (!groups[group] || groups[group].length === 0) return;

    const label = document.createElement("div");
    label.className = "sidebar-group-label";
    label.textContent = group;
    container.appendChild(label);

    groups[group].forEach(board => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "sidebar-board-item";
      itemDiv.dataset.id = board.id;

      const currentParams = new URLSearchParams(window.location.search);
      if (currentParams.get('board') === board.id) {
        itemDiv.classList.add('active');
      }

      const mainBtn = document.createElement("button");
      mainBtn.className = "sidebar-board-btn";
      mainBtn.textContent = board.title || "Untitled";
      mainBtn.title = board.title;
      mainBtn.onclick = (e) => {
        e.preventDefault();
        switchBoard(board.id, ownerId);
      };

      // 3-Dot Menu Button
      const menuBtn = document.createElement("button");
      menuBtn.className = "sidebar-menu-btn";
      menuBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="currentColor"><path d="M240-400q-33 0-56.5-23.5T160-480q0-33 23.5-56.5T240-560q33 0 56.5 23.5T320-480q0 33-23.5 56.5T240-400Zm240 0q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm240 0q-33 0-56.5-23.5T640-480q0-33 23.5-56.5T720-560q33 0 56.5 23.5T800-480q0 33-23.5 56.5T720-400Z"/></svg>`;
      
      // CLICK HANDLER: Opens the global menu
      menuBtn.onclick = (e) => {
        openContextMenu(e, board);
      };

      itemDiv.appendChild(mainBtn);
      itemDiv.appendChild(menuBtn);
      container.appendChild(itemDiv);
    });
  });
}

// --- Data Fetching ---
async function fetchBoardDetails(user, file) {
  const path = `${user.id}/boards/${file.name}`;
  try {
    const { data: blob, error } = await sb.storage.from(BUCKET).download(path);
    if (error) throw error;

    const text = await blob.text();
    const json = JSON.parse(text);

    // Try to build a preview snippet from the FIRST element on the board
    let previewSnippet = "";
    let items = [];

    // Check for 'elements' which is the standard key
    if (Array.isArray(json.elements)) {
      items = json.elements;
    }

    if (items.length > 0) {
      const first = items[0];

      if (first.type === "note" && first.html) {
        previewSnippet = first.html.toString().trim();
      } else if (first.type === "verse") {
        const body = first.text?.toString().trim() || "";
        const ref = first.reference?.toString().trim() || "";
        previewSnippet = ref && body ? `${ref} — ${body}` : body || ref;
      } else if (first.type === "song") {
        previewSnippet = first.title?.toString().trim() || "";
      }
    }

    const description = json.description || previewSnippet || "";
    
    return {
      id: json.id || file.name.replace(".json", ""),
      title: json.title || "Untitled Board",
      description,
      elements: json.elements || [], // <--- ADD THIS LINE (Stores content for search)
      createdAt: json.createdAt || file.created_at || null,
      updatedAt: json.updatedAt || file.updated_at || file.created_at || null,
      path,
    };
  } catch (err) {
    console.error("Failed to fetch details for", file.name, err);
    return null;
  }
}

async function loadBoards() {
  try {
    // 1. Capture the user LOCALLY. 
    // Even if 'currentUser' changes globally later, 'user' stays safe here.
    const user = currentUser;

    renderStatus("Loading boards…");

    if (!user) {
      renderStatus("Not signed in.");
      renderSidebarBoards([]);
      return;
    }

    // 2. Use 'user.id' instead of 'currentUser.id'
    const { data: files, error: listErr } = await sb.storage
      .from(BUCKET)
      .list(`${user.id}/boards`, { limit: 200, offset: 0 });

    if (listErr) {
      console.error("List error:", listErr);
      renderStatus("Error loading boards.");
      return;
    }

    if (!files || files.length === 0) {
      renderStatus("Creating your first board...");
      await handleNewBoard();
      return;
    }

    // 3. Pass the local 'user' variable to the fetch function
    const promises = files
      .filter(f => f.name.endsWith(".json"))
      .map(file => fetchBoardDetails(user, file));

    const boardResults = await Promise.all(promises);
    const boards = boardResults.filter(Boolean);

    if (boards.length === 0) {
      renderStatus("Creating your first board...");
      await handleNewBoard();
      return;
    }

    // Sort descending
    const sorted = boards.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt) -
        new Date(a.updatedAt || a.createdAt)
    );

    loadedBoards = sorted;
    renderSidebarBoards(sorted);
    renderStatus("");

    // Auto-open logic
    const params = new URLSearchParams(window.location.search);
    if (!params.get('board') && sorted.length > 0) {
        console.log("Auto-opening most recent board:", sorted[0].id);
        switchBoard(sorted[0].id, user.id);
    }

  } catch (err) {
    console.error("loadBoards error:", err);
    renderStatus("Error loading boards.");
  }
}


// --- New Board Creation ---
async function handleNewBoard() {
  if (!currentUser) {
    alert("Please sign in first.");
    return;
  }

  // 1. Save the original icon & text
  let originalContent = "";
  
  if (newBoardBtn) {
    originalContent = newBoardBtn.innerHTML; // <--- SAVES THE SVG
    newBoardBtn.disabled = true;
    newBoardBtn.textContent = "Creating..."; // Shows temporary text
  }

  const user = currentUser;

  try {
    // ... (Existing creation logic stays the same) ...
    const boardId = crypto.randomUUID();
    const path = `${user.id}/boards/${boardId}.json`;
    const now = new Date().toISOString();

    const defaultBoard = {
      id: boardId,
      title: "Untitled Board",
      description: "",
      createdAt: now,
      updatedAt: now,
      background: { type: "solid", color: "#020617" },
      elements: [], 
      connections: [],
    };

    const blob = new Blob([JSON.stringify(defaultBoard, null, 2)], {
      type: "application/json",
    });

    const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
      contentType: "application/json",
      cacheControl: "0",
      upsert: false,
    });
    if (error) throw error;

    await loadBoards();
    switchBoard(boardId, currentUser.id);

  } catch (error) {
    console.error("Failed to create new board:", error);
    alert(`Error creating board: ${error.message}`);
  } finally {
    // 2. Restore the original icon & text
    if (newBoardBtn) {
      newBoardBtn.disabled = false;
      // Check if we have original content to restore, otherwise fallback
      if (originalContent) {
        newBoardBtn.innerHTML = originalContent; // <--- RESTORES THE SVG
      } else {
        newBoardBtn.textContent = "New Board"; 
      }
    }
  }
}

function handleAuthChange(user) {
  currentUser = user;

  if (user) {
    loadBoards(user);
  }
}
// --- Init ---
async function init() {
  console.log("Initializing Board Logic...");

  // 1. Close Global Menu when clicking anywhere else
  document.addEventListener("click", (e) => {
    if (contextMenuEl && contextMenuEl.contains(e.target)) return;
    closeContextMenu();
  });

  // 2. Wire up the Confirm Delete Button (with Debugging)
  const deleteBtn = document.getElementById("confirm-delete-btn");
  if (deleteBtn) {
    console.log("Delete button found. Attaching listener.");
    // Remove old listeners by cloning (optional safety)
    const newDeleteBtn = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
    
    newDeleteBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      console.log("Delete button clicked!");
      console.log("Board to delete:", boardToDelete);

      if (!boardToDelete) {
        console.error("Error: No board selected for deletion.");
        return;
      }
      await performDelete(boardToDelete); 
    });
  } else {
    console.error("CRITICAL ERROR: Delete button (confirm-delete-btn) not found in DOM.");
  }

  // 3. Wire up Tour Button
  const tourBtn = document.getElementById("bb-tour-help-btn");
  if (tourBtn) {
    tourBtn.style.display = "block"; 
    tourBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof startTour === "function") {
        startTour();
      } else {
        console.warn("startTour function not found.");
      }
    });
  }
  
  // 4. Wire up Rename Modal Save Button
  if (modalSaveBtn) {
    modalSaveBtn.replaceWith(modalSaveBtn.cloneNode(true));
    document.getElementById("modal-save-btn").addEventListener("click", handleRename);
  }

  // 5. Sign Out Button
  if (signoutBtn) {
    signoutBtn.addEventListener("click", async () => {
      try {
        await sb.auth.signOut();
      } catch (err) { console.error(err); }
      window.location.href = "/";
    });
  }
  
  // 6. New Board Button
  if (newBoardBtn) {
      newBoardBtn.addEventListener("click", (e) => {
        e.preventDefault();
        handleNewBoard();
      });
  }

  // 7. Listeners for Auth & History
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const boardId = params.get('board');
    if (boardId && currentUser) {
       switchBoard(boardId, currentUser.id);
    }
  });

  sb.auth.onAuthStateChange((_event, data) => {
    const user = data?.session?.user || null;
    handleAuthChange(user);
  });

  try {
    const { data, error } = await sb.auth.getSession();
    if (error) console.error(error);
    const user = data?.session?.user || null;
    handleAuthChange(user);
  } catch (error) {
    console.error("Error getting session:", error);
    handleAuthChange(null);
  }
}

// hamburgerBtn logic (keep this if it was at the bottom)
hamburgerBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  const sidebar = document.getElementById("sidebar");
  if (sidebar && sidebar.classList.contains("offscreen")) {
      // Logic handled in script.js usually, but safety check here
      sidebar.classList.remove("offscreen");
      sidebar.classList.add("expanded");
  }
});

// Start the app
init();
















// ==================== ADVANCED SEARCH LOGIC ====================

const searchBackdrop = document.getElementById("search-modal-backdrop");
const searchInput = document.getElementById("board-search-input");
const searchResults = document.getElementById("board-search-results");
const searchBtnSidebar = document.getElementById("search-board-btn-sidebar");
const newChatSearchBtn = document.getElementById("new-chat-search-btn"); 

// 1. Open Modal
if (searchBtnSidebar) {
  searchBtnSidebar.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openSearchModal();
  });
}

function openSearchModal() {
  if (searchBackdrop) {
    searchBackdrop.style.display = "flex";
    searchBackdrop.classList.remove("hidden");
  }
  if (searchInput) {
    searchInput.value = "";
    searchInput.focus();
    
    // FIX: Call the correct function to reset the view
    handleBoardSearch(""); 
  }
  
  // Close mobile sidebar if open
  const sidebar = document.getElementById("sidebar");
  if (sidebar && window.innerWidth < 900) sidebar.classList.add("offscreen");
}

// Global Close Function
window.closeSearchModal = function() {
  if (searchBackdrop) {
    searchBackdrop.classList.add("hidden");
    setTimeout(() => { searchBackdrop.style.display = "none"; }, 200); 
  }
};

// 2. Search Listener
if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    handleBoardSearch(e.target.value);
  });
}

// 3. Helper: Group by Date
function getBoardGroup(board) {
  if (!board.updatedAt) return "Older"; 

  const now = new Date();
  const boardDate = new Date(board.updatedAt);

  // Check for today
  if (boardDate.getDate() === now.getDate() &&
      boardDate.getMonth() === now.getMonth() &&
      boardDate.getFullYear() === now.getFullYear()) {
    return "Today";
  }

  // Check for yesterday
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (boardDate.getDate() === yesterday.getDate() &&
      boardDate.getMonth() === yesterday.getMonth() &&
      boardDate.getFullYear() === yesterday.getFullYear()) {
    return "Yesterday";
  }

  return "Older"; 
}

// 4. The Main Logic
function handleBoardSearch(query) {
  if (!searchResults) return;
  searchResults.innerHTML = ""; // Clear results
  
  // Reset "New Chat" button visibility
  if (newChatSearchBtn) {
    newChatSearchBtn.style.display = "flex"; 
  }

  const term = query.toLowerCase().trim();

  // If empty, stop here (Result: "New Chat" is visible, results list is empty)
  if (!term) return;

  // If we have a term, hide the "New Chat" button
  if (newChatSearchBtn) {
    newChatSearchBtn.style.display = "none"; 
  }

  const matches = loadedBoards.map(board => {
    let snippetText = ""; 

    // A. Check Title
    if (board.title.toLowerCase().includes(term)) {
      snippetText = "Matches title";
    } 
    // B. Check Content (Notes, Verses, Songs)
    else if (board.elements && board.elements.length > 0) {
      for (const el of board.elements) {
        const content = extractTextFromElement(el);
        if (content.toLowerCase().includes(term)) {
          snippetText = getSnippet(content, term);
          break; 
        }
      }
    }

    if (snippetText) {
      return { board, snippetText };
    }
    return null;
  }).filter(Boolean); 

  // Group matches
  const groupedMatches = {
    "Today": [],
    "Yesterday": [],
    "Older": [],
  };

  matches.forEach(match => {
    const group = getBoardGroup(match.board);
    if (groupedMatches[group]) {
        groupedMatches[group].push(match);
    } else {
        groupedMatches["Older"].push(match); // Safety fallback
    }
  });
  
  // Sort within groups
  Object.keys(groupedMatches).forEach(groupName => {
      groupedMatches[groupName].sort((a, b) => {
          const dateA = new Date(a.board.updatedAt || 0);
          const dateB = new Date(b.board.updatedAt || 0);
          return dateB - dateA; 
      });
  });

  let hasResults = false;
  ["Today", "Yesterday", "Older"].forEach(groupName => {
    if (groupedMatches[groupName].length > 0) {
      hasResults = true;
      const groupHeader = document.createElement("div");
      groupHeader.className = "search-results-group-header";
      groupHeader.textContent = groupName;
      searchResults.appendChild(groupHeader);

      groupedMatches[groupName].forEach(match => {
        const div = document.createElement("div");
        div.className = "search-result-item";
        div.onclick = () => {
          switchBoard(match.board.id, currentUser.id);
          closeSearchModal();
        };

        div.innerHTML = `
          <span class="material-symbols-outlined">chat_bubble</span>
          <span class="search-result-title">${highlightText(match.board.title, term)}</span>
          ${match.snippetText && match.snippetText !== "Matches title" ? 
            `<span class="search-result-snippet">${highlightText(match.snippetText, term)}</span>` : ''}
        `;
        searchResults.appendChild(div);
      });
    }
  });

  if (!hasResults) {
    searchResults.innerHTML = `<div class="search-placeholder">No results found for "${term}".</div>`;
  }
}

// 5. Helper Functions
function extractTextFromElement(el) {
  if (!el) return "";
  if (el.type === "note" || el.type === "text") {
    return (el.html || el.text || "").replace(/<[^>]*>?/gm, ""); 
  }
  if (el.type === "verse") {
    return `${el.reference} ${el.text}` || "";
  }
  if (el.type === "song") {
    return `${el.title} ${el.lyrics}` || "";
  }
  return "";
}

function getSnippet(fullText, term) {
  const lower = fullText.toLowerCase();
  const index = lower.indexOf(term);
  if (index === -1) return fullText.substring(0, 50);

  const start = Math.max(0, index - 15); 
  const end = Math.min(fullText.length, index + term.length + 20);
  return fullText.substring(start, end);
}

function highlightText(text, term) {
  if (!term) return text;
  // Escape special regex chars in term
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeTerm})`, "gi");
  return text.replace(regex, `<span class="highlight-match">$1</span>`);
}




function openDeleteModal(board) {
  console.log("Opening delete modal for:", board); // Add this log
  boardToDelete = board;
  const nameEl = document.getElementById("delete-board-name");
  if (nameEl) nameEl.textContent = board.title || "Untitled Board";
  
  if (deleteModalBackdrop) {
    deleteModalBackdrop.classList.remove("hidden");
    deleteModalBackdrop.style.display = "flex"; // Ensure flex for centering
  }
}

window.closeDeleteModal = function() {
  if (deleteModalBackdrop) {
    deleteModalBackdrop.classList.add("hidden");
    setTimeout(() => { deleteModalBackdrop.style.display = "none"; }, 200);
  }
  boardToDelete = null;
};