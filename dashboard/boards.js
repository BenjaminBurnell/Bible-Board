// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "../supabaseClient.js";
import { SubscriptionService } from "../subscriptionService.js";

const BUCKET = "bible-boards";
const FREE_BOARD_LIMIT = 3; // The maximum number of boards for a free user

// --- State ---
let currentUser = null;
let currentModalBoard = null;
let activeMenu = null;
let activeDropdown = null; 
let loadedBoards = [];
let boardToDelete = null; // Global variable for deletion

// Track the currently open context menu + its parent sidebar-board-item
let openBoardContextMenu = null;
let openBoardContextItem = null;

// ✅ NEW: tracks whether we've finished a Pro check
let hasProCheckCompleted = false;

// --- ASYNCHRONOUS PRO STATUS CHECK ---
// Returns true if the current user is Pro (RevenueCat / SubscriptionService)
async function isProUser() {
  // If we somehow don't have currentUser yet, try to fetch it from Supabase
  if (!currentUser) {
    try {
      const { data, error } = await sb.auth.getSession();
      if (error) {
        console.error("isProUser: getSession error", error);
        return false;
      }
      const user = data?.session?.user || null;
      if (!user) return false;
      currentUser = user;
      try {
        updateUserProfileUI(user);
      } catch (e) {
        console.warn("isProUser: updateUserProfileUI failed", e);
      }
    } catch (e) {
      console.error("isProUser: unexpected auth error", e);
      return false;
    }
  }

  // Calls the SubscriptionService which performs the RevenueCat check
  return await SubscriptionService.initAndCheck();
}

// --------------------------------------

// --- DOM Refs ---
const deleteModalBackdrop = document.getElementById("delete-modal-backdrop");
const confirmDeleteBtn = document.getElementById("confirm-delete-btn");
const sidebarBoardsContainer = document.getElementById("sidebar-boards-container");
const hamburgerBtn = document.getElementById("hamburger-btn");

// New DOM Refs for Upgrade Modal
const upgradeModalBackdrop = document.getElementById("upgrade-modal-backdrop");
const upgradeNowBtn = document.getElementById("upgrade-now-btn");

// Fix: Ensure button exists before using
const newBoardBtn = document.getElementById("new-board-btn") || document.getElementById("new-board-btn-sidebar");

// Modal elements
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitleInput = document.getElementById("modal-title-input");
const modalSaveBtn = document.getElementById("modal-save-btn");

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
toggle?.addEventListener("click", () => setTheme(!body.classList.contains("light")));

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
  return (str || "").toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
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

// --- Helper to switch boards without reloading ---
async function switchBoard(boardId, ownerId) {
  const newUrl = new URL(window.location);
  newUrl.searchParams.set('board', boardId);
  if (ownerId) newUrl.searchParams.set('owner', ownerId);
  window.history.pushState({}, "", newUrl);

  const allItems = document.querySelectorAll('.sidebar-board-item');
  allItems.forEach(item => {
    if (item.dataset.id === boardId) item.classList.add('active');
    else item.classList.remove('active');
  });

  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('bibleboard:load', { 
      detail: { boardId, ownerId } 
    }));
  }, 10);
  
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  if (sidebar && sidebar.classList.contains("expanded") && window.innerWidth < 900) {
     sidebar.classList.remove("expanded");
     sidebar.classList.add("offscreen");
     if (overlay) overlay.classList.add("hidden");
  }
}

// --- Scroll Fade Logic ---
const navbar = document.getElementById("nav-bar");
window.addEventListener("scroll", () => {
  if (!navbar) return;
  const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  const START_FADE = 25;
  const END_FADE = 125;
  let strength = (scrollTop - START_FADE) / (END_FADE - START_FADE);
  strength = Math.min(Math.max(strength, 0), 1);

  if (strength <= 0) {
    navbar.style.background = "transparent";
    navbar.style.backdropFilter = "none";
    navbar.style.borderBottom = "none"; 
  } else {
    const bgOpacity = 0.5 * strength;
    const blurAmountRem = 1.5 * strength;
    const borderOpacity = 0.8 * strength;
    navbar.style.background = `rgba(23, 23, 23, ${bgOpacity})`;
    navbar.style.backdropFilter = `blur(${blurAmountRem}rem)`;
    navbar.style.borderBottom = `1px solid rgba(47, 47, 47, ${borderOpacity})`;
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
    
    const { data: blob } = await sb.storage.from(BUCKET).download(path);
    const text = await blob.text();
    const json = JSON.parse(text);

    json.title = newTitle;
    json.updatedAt = new Date().toISOString();

    const newBlob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const { error } = await sb.storage.from(BUCKET).update(path, newBlob, {
       contentType: "application/json", cacheControl: "0", upsert: true 
    });

    if (error) throw error;

    await loadBoards(); 
    
    const params = new URLSearchParams(window.location.search);
    if (params.get('board') === id) {
       const titleBox = document.getElementById("title-textbox");
       if (titleBox) titleBox.value = newTitle;
    }

    window.closeModal();

  } catch (err) {
    console.error("Rename failed:", err);
    alert("Failed to rename board: " + err.message);
  } finally {
    if (modalSaveBtn) {
      modalSaveBtn.textContent = "Save";
      modalSaveBtn.disabled = false;
    }
  }
}

// --- DELETE LOGIC (FIXED) ---
function openDeleteModal(board) {
  boardToDelete = board;
  const nameEl = document.getElementById("delete-board-name");
  if (nameEl) nameEl.textContent = board.title || "Untitled Board";
  
  if (deleteModalBackdrop) {
    deleteModalBackdrop.classList.remove("hidden");
    deleteModalBackdrop.style.display = "flex";
  }
}

window.closeDeleteModal = function() {
  if (deleteModalBackdrop) {
    deleteModalBackdrop.classList.add("hidden");
    setTimeout(() => { deleteModalBackdrop.style.display = "none"; }, 200);
  }
  boardToDelete = null;
};

// FIXED: Safely capture ID before clearing state
async function performDelete() {
  if (!boardToDelete) {
    console.error("No board selected for deletion.");
    return;
  }

  // Capture values locally before `boardToDelete` is nulled
  const idToDelete = boardToDelete.id;
  const pathToDelete = boardToDelete.path;
  const titleToDelete = boardToDelete.title;

  const btn = document.getElementById("confirm-delete-btn");
  if (btn) {
    btn.textContent = "Deleting...";
    btn.disabled = true;
  }

  try {
    // 1. Delete from Supabase Storage
    const { error } = await sb.storage.from(BUCKET).remove([pathToDelete]);
    if (error) throw error;

    // 2. Update Local State
    loadedBoards = loadedBoards.filter(b => b.id !== idToDelete);
    
    // 3. Refresh UI
    renderSidebarBoards(loadedBoards);
    closeDeleteModal(); // This sets boardToDelete = null

    // 4. If we deleted the active board, redirect home
    // Use the captured `idToDelete` instead of `boardToDelete.id`
    const params = new URLSearchParams(window.location.search);
    if (params.get('board') === idToDelete) {
       window.location.replace("../dashboard/");
    }

  } catch (err) {
    console.error("Delete failed:", err);
    alert("Failed to delete board: " + err.message);
  } finally {
    if (btn) {
      btn.textContent = "Delete";
      btn.disabled = false;
    }
    boardToDelete = null;
  }
}

// ==================== GLOBAL CONTEXT MENU ====================

const contextMenuEl = document.createElement('div');
contextMenuEl.id = 'board-context-menu';
contextMenuEl.innerHTML = `
  <button id="ctx-rename" class="menu-option">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-pencil">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/>
        <path d="M13.5 6.5l4 4"/>
      </svg>
    Rename
  </button>
  <div class="menu-divider"></div>
  <button id="ctx-delete" class="menu-option delete">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#AD1C1C" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-trash">
        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
        <path d="M4 7l16 0" fill="none"/>
        <path d="M10 11l0 6" fill="none"/>
        <path d="M14 11l0 6" fill="none"/>
        <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" fill="none"/>
        <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" fill="none"/>
      </svg>
      Delete
  </button>
`;
document.body.appendChild(contextMenuEl);

document.getElementById('ctx-rename').addEventListener('click', (e) => {
  e.stopPropagation();
  closeContextMenu();
  if (currentModalBoard) openModal(currentModalBoard);
});

document.getElementById('ctx-delete').addEventListener('click', (e) => {
  e.stopPropagation();
  closeContextMenu();
  if (currentModalBoard) openDeleteModal(currentModalBoard); 
});

function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.classList.remove('show');
  }

  // remove highlight from whichever sidebar-board-item had the menu
  if (openBoardContextItem) {
    openBoardContextItem.classList.remove('context-open');
    openBoardContextItem = null;
  }
}



window.closeContextMenu = closeContextMenu; 

function openContextMenu(e, board) {
  e.preventDefault();
  e.stopPropagation();
  currentModalBoard = board;

  const itemDiv = e.currentTarget.closest(".sidebar-board-item");
  if (!itemDiv) return;

  const container = document.getElementById("sidebar-boards-container");
  if (!container) return;

  // 🔹 move the menu into the scrollable container so it scrolls with the list
  if (contextMenuEl.parentElement !== container) {
    container.appendChild(contextMenuEl);
  }

  // 🔹 highlight the item that owns this menu
  if (openBoardContextItem && openBoardContextItem !== itemDiv) {
    openBoardContextItem.classList.remove("context-open");
  }
  openBoardContextItem = itemDiv;
  itemDiv.classList.add("context-open");

  const itemRect = itemDiv.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // vertical: just below the row, relative to the container
  let top = itemRect.top - containerRect.top + itemDiv.offsetHeight + 6;

  // horizontal: align to right side of the container
  const menuWidth = contextMenuEl.offsetWidth || 160;
  let left = 10;
  // if (left < 8) left = 8;

  contextMenuEl.style.top = `${top}px`;
  contextMenuEl.style.right = `${left}px`;

  contextMenuEl.classList.add("show");
}


// ==================== SIDEBAR RENDERING ====================

function renderSidebarBoards(boards) {
  const container = document.getElementById("sidebar-boards-container");
  if (!container) return;
  container.innerHTML = "";

  if (!boards || boards.length === 0) return;
  const ownerId = currentUser ? currentUser.id : null;

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

      const menuBtn = document.createElement("button");
      menuBtn.className = "sidebar-menu-btn";
      menuBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:20px">more_horiz</span>`;
      
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

    let previewSnippet = "";
    let items = Array.isArray(json.elements) ? json.elements : [];

    if (items.length > 0) {
      const first = items[0];
      if (first.type === "note" && first.html) {
        previewSnippet = first.html.toString().trim();
      } else if (first.type === "verse") {
        previewSnippet = first.text?.toString().trim() || first.reference || "";
      } else if (first.type === "song") {
        previewSnippet = first.title?.toString().trim() || "";
      }
    }

    return {
      id: json.id || file.name.replace(".json", ""),
      title: json.title || "Untitled Board",
      description: json.description || previewSnippet || "",
      elements: items,
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
    const user = currentUser;
    renderStatus("Loading boards…");

    if (!user) {
      renderStatus("Not signed in.");
      renderSidebarBoards([]);
      return;
    }

    const { data: files, error: listErr } = await sb.storage
      .from(BUCKET)
      .list(`${user.id}/boards`, { limit: 200, offset: 0 });

    if (listErr) {
      console.error("List error:", listErr);
      renderStatus("Error loading boards.");
      return;
    }

    // Only count files that are board JSONs
    const boardFiles = files.filter(f => f.name.endsWith(".json"));

    if (!boardFiles || boardFiles.length === 0) {
      renderStatus("Creating your first board...");
      // This is the case where a user is starting fresh, so we allow creation.
      await handleNewBoard(true); 
      return;
    }

    const promises = boardFiles
      .map(file => fetchBoardDetails(user, file));

    const boardResults = await Promise.all(promises);
    const boards = boardResults.filter(Boolean);

    if (boards.length === 0) {
      renderStatus("Creating your first board...");
      // Should not happen, but if it does, allow initial creation.
      await handleNewBoard(true); 
      return;
    }

    const sorted = boards.sort(
      (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
    );

    loadedBoards = sorted;
    renderSidebarBoards(sorted);
    renderStatus("");

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

/**
 * Handles the user action to create a new board.
 * @param {boolean} isInitialLoad (kept for compatibility; logic no longer relies on it)
 */
async function handleNewBoard(isInitialLoad = false) {
  // 1. Robust auth check: try cached user first
  let user = currentUser;

  // If our cache is empty, ask Supabase directly
  if (!user) {
    try {
      const { data, error } = await sb.auth.getSession();
      if (error) {
        console.error("handleNewBoard: getSession error", error);
      }
      user = data?.session?.user || null;

      // If we found a user, update the cache + UI
      if (user) {
        currentUser = user;
        try {
          updateUserProfileUI(user);
        } catch (e) {
          console.warn("handleNewBoard: updateUserProfileUI failed", e);
        }
      }
    } catch (e) {
      console.error("handleNewBoard: unexpected auth error", e);
    }
  }

  // If we *still* don't have a user, they are genuinely not signed in
  if (!user) {
    alert("Please sign in first.");
    return;
  }

  // 2. Subscription status
  const isPro = await isProUser();
  const status = isPro ? "PRO" : "FREE";
  const currentCount = loadedBoards.length;
  console.log(
    `User Subscription Status: ${status} (Boards: ${currentCount})`
  );

  // 3. Enforce FREE limit using your existing logic
  if (!isPro && currentCount >= FREE_BOARD_LIMIT) {
    if (currentCount === 0 && isInitialLoad) {
      // Allow very first board on initial bootstrap if you still want this special case
    } else {
      console.warn("LIMIT REACHED: Showing upgrade modal.");
      openUpgradeModal();
      return;
    }
  }

  // 4. Proceed with creation
  await createBoardFile(crypto.randomUUID());
}





/**
 * Performs the actual Supabase Storage file creation.
 * @param {string} boardId The ID for the new board.
 */
async function createBoardFile(boardId) {
    let originalContent = "";
    if (newBoardBtn) {
        originalContent = newBoardBtn.innerHTML;
        newBoardBtn.disabled = true;
        newBoardBtn.textContent = "Creating...";
    }
    
    try {
        const path = `${currentUser.id}/boards/${boardId}.json`;
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

        return true;
        
    } catch (error) {
        console.error("Failed to create new board file:", error);
        throw error;
    } finally {
        if (newBoardBtn) {
            newBoardBtn.disabled = false;
            if (originalContent) newBoardBtn.innerHTML = originalContent;
            else newBoardBtn.textContent = "New Board"; 
        }
    }
}


// --- Upgrade Modal Logic (NEW) ---
function openUpgradeModal() {
    if (upgradeModalBackdrop) {
        upgradeModalBackdrop.classList.remove("hidden");
        upgradeModalBackdrop.style.display = "flex";
    }
}

window.closeUpgradeModal = function() {
    if (upgradeModalBackdrop) {
        upgradeModalBackdrop.classList.add("hidden");
        setTimeout(() => { upgradeModalBackdrop.style.display = "none"; }, 200);
    }
}

function handleUpgrade() {
    closeUpgradeModal();
    // Redirect to your paywall/checkout page
    window.location.href = "../paywall.html";
}


// ==================== USER PROFILE LOGIC (ChatGPT Style) ====================

function updateUserProfileUI(user) {
  if (!user) return;

  const nameEl = document.getElementById('user-profile-name');
  const emailEl = document.getElementById('user-profile-email');
  const avatarEl = document.getElementById('user-avatar-img');

  // Extract data safely
  const email = user.email || "";
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || email.split('@')[0] || "User";
  const avatar = meta.avatar_url || meta.picture || "../assets/logo_no_bg.png";

  if (nameEl) nameEl.textContent = name;
  if (emailEl) emailEl.textContent = email;
  if (avatarEl) avatarEl.src = avatar;
}

function setupProfileMenu() {
  const triggerBtn = document.getElementById('user-profile-btn');
  const menu = document.getElementById('user-profile-menu');
  
  if (!triggerBtn || !menu) return;

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = !menu.classList.contains('show');
    
    if (typeof closeContextMenu === 'function') closeContextMenu();

    if (isHidden) {
      menu.classList.remove('hidden');
      requestAnimationFrame(() => {
        menu.classList.add('show');
        triggerBtn.classList.add('active');
      });
    } else {
      closeProfileMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !triggerBtn.contains(e.target)) {
      closeProfileMenu();
    }
  });
}

function closeProfileMenu() {
  const menu = document.getElementById('user-profile-menu');
  const triggerBtn = document.getElementById('user-profile-btn');
  if (menu) {
    menu.classList.remove('show');
    triggerBtn?.classList.remove('active');
    setTimeout(() => menu.classList.add('hidden'), 150);
  }
}

// ==================== AUTH GATEKEEPER ====================
async function handleAuthChange(user, valid = false) {
  currentUser = user;

  if (user) {
    updateUserProfileUI(user);

    await SubscriptionService.initAndCheck();
    hasProCheckCompleted = true;        // ✅ we have now “checked” Pro status

    loadBoards();
  } else if (valid) {
    window.location = "../";
  }
}


// ==================== ADVANCED SEARCH LOGIC ====================
const searchBackdrop = document.getElementById("search-modal-backdrop");
const searchInput = document.getElementById("board-search-input");
const searchResults = document.getElementById("board-search-results");
const searchBtnSidebar = document.getElementById("search-board-btn-sidebar");
const newChatSearchBtn = document.getElementById("new-chat-search-btn"); 

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
    handleBoardSearch(""); 
  }
  const sidebar = document.getElementById("sidebar");
  if (sidebar && window.innerWidth < 900) sidebar.classList.add("offscreen");
}

window.closeSearchModal = function() {
  if (searchBackdrop) {
    searchBackdrop.classList.add("hidden");
    setTimeout(() => { searchBackdrop.style.display = "none"; }, 200); 
  }
};

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    handleBoardSearch(e.target.value);
  });
}

function getBoardGroup(board) {
  if (!board.updatedAt) return "Older"; 
  const now = new Date();
  const boardDate = new Date(board.updatedAt);

  if (boardDate.getDate() === now.getDate() &&
      boardDate.getMonth() === now.getMonth() &&
      boardDate.getFullYear() === now.getFullYear()) {
    return "Today";
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (boardDate.getDate() === yesterday.getDate() &&
      boardDate.getMonth() === yesterday.getMonth() &&
      boardDate.getFullYear() === yesterday.getFullYear()) {
    return "Yesterday";
  }

  return "Older"; 
}

function handleBoardSearch(query) {
  if (!searchResults) return;
  searchResults.innerHTML = ""; 
  
  if (newChatSearchBtn) newChatSearchBtn.style.display = "flex"; 

  const term = query.toLowerCase().trim();
  if (!term) return;

  if (newChatSearchBtn) newChatSearchBtn.style.display = "none"; 

  const matches = loadedBoards.map(board => {
    let snippetText = ""; 
    if (board.title.toLowerCase().includes(term)) {
      snippetText = "Matches title";
    } 
    else if (board.elements && board.elements.length > 0) {
      for (const el of board.elements) {
        const content = extractTextFromElement(el);
        if (content.toLowerCase().includes(term)) {
          snippetText = getSnippet(content, term);
          break; 
        }
      }
    }

    if (snippetText) return { board, snippetText };
    return null;
  }).filter(Boolean); 

  const groupedMatches = { "Today": [], "Yesterday": [], "Older": [] };

  matches.forEach(match => {
    const group = getBoardGroup(match.board);
    if (groupedMatches[group]) groupedMatches[group].push(match);
    else groupedMatches["Older"].push(match); 
  });
  
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
          const ownerId = currentUser ? currentUser.id : match.board.path.split('/')[0];
          switchBoard(match.board.id, ownerId);
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
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeTerm})`, "gi");
  return text.replace(regex, `<span class="highlight-match">$1</span>`);
}

// ==================== APP INIT ====================

async function init() {
  console.log("Initializing Dashboard...");

  // 1. Close menus on outside click
  document.addEventListener("click", (e) => {
    if (contextMenuEl && contextMenuEl.contains(e.target)) return;
    closeContextMenu();
  });

  // 2. Setup Auth
  sb.auth.onAuthStateChange((_event, data) => handleAuthChange(data?.session?.user));
  const { data } = await sb.auth.getSession();
  handleAuthChange(data?.session?.user, true);

  // 3. Setup Profile Menu
  setupProfileMenu();

  // 4. Wire up Profile Menu Actions
  const manageBtn = document.getElementById('manage-sub-btn');
  if (manageBtn) {
    manageBtn.onclick = (e) => {
        e.preventDefault();
        closeProfileMenu();
        // console.log(SubscriptionService)
        SubscriptionService.manage();
    };
  }

  const signoutBtn = document.getElementById('signout-btn-sidebar');
  if (signoutBtn) {
    signoutBtn.onclick = async (e) => {
        e.preventDefault();
        closeProfileMenu();
        await SubscriptionService.logout();
    };
  }

  // 5. Buttons
  if (newBoardBtn) newBoardBtn.onclick = handleNewBoard;
  
  // Wire up new upgrade button
  if (upgradeNowBtn) upgradeNowBtn.onclick = handleUpgrade;
  
  // --- FIX IS HERE ---
  const delConfirm = document.getElementById("confirm-delete-btn");
  if (delConfirm) {
    delConfirm.onclick = (e) => {
      if (e) e.preventDefault(); // <--- This stops the refresh
      performDelete();
    };
  }
  // -------------------

  if (modalSaveBtn) {
    const newSaveBtn = modalSaveBtn.cloneNode(true);
    modalSaveBtn.parentNode.replaceChild(newSaveBtn, modalSaveBtn);
    newSaveBtn.addEventListener("click", handleRename);
  }

  // 6. Hamburger
  hamburgerBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    const sidebar = document.getElementById("sidebar");
    if (sidebar && sidebar.classList.contains("offscreen")) {
        sidebar.classList.remove("offscreen");
        sidebar.classList.add("expanded");
    }
  });
}

init();








/* ==================== UNIFIED SELECTION FIX ==================== */

// 1. Ensure Global Queues Exist
window.pendingVerseAdds = window.pendingVerseAdds || new Map();
window.pendingSongAdds = window.pendingSongAdds || new Map();
window.pendingInterlinearAdds = window.pendingInterlinearAdds || new Map();

// 2. Unified Verse Toggle (Fixes the split-brain issue)
// This replaces the old 'toggleVerseSelection' that used verseSelectionQueue
function toggleVerseSelection(verseData, btnElement) {
  // Create a unique key including version to prevent collisions
  const key = `${verseData.reference}::${verseData.version}`;

  if (window.pendingVerseAdds.has(key)) {
    // REMOVE
    window.pendingVerseAdds.delete(key);
    if (btnElement) btnElement.classList.remove("selected");
    
    // Also find the row and remove highlighting
    const row = btnElement ? btnElement.closest('.search-query-verse-container') : null;
    if (row) row.classList.remove("selected-for-add");
    
  } else {
    // ADD
    window.pendingVerseAdds.set(key, verseData);
    if (btnElement) btnElement.classList.add("selected");
    
    const row = btnElement ? btnElement.closest('.search-query-verse-container') : null;
    if (row) row.classList.add("selected-for-add");
  }

  // Trigger the master button update
  updateFloatingAddButton();
}

// 3. Unified "Add to Board" Button Update
// Counts items from ALL three maps (Verses + Songs + Interlinear)
function updateFloatingAddButton() {
  const floatBtn = document.getElementById("floating-add-to-board-btn");
  if (!floatBtn) return;

  const vCount = window.pendingVerseAdds.size;
  const sCount = window.pendingSongAdds.size;
  const iCount = window.pendingInterlinearAdds.size;
  
  const total = vCount + sCount + iCount;

  if (total > 0) {
    floatBtn.style.display = "inline-flex";
    
    // Clear and rebuild button content
    floatBtn.replaceChildren ? floatBtn.replaceChildren() : (floatBtn.innerHTML = "");
    
    // Icon
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.textContent = "add_circle";
    icon.style.marginRight = "6px";
    
    // Text
    const text = document.createElement("span");
    text.textContent = `Add ${total} Item${total !== 1 ? "s" : ""}`;
    
    floatBtn.appendChild(icon);
    floatBtn.appendChild(text);

    // Rebind click to the master flush function (clone to strip old listeners)
    const newBtn = floatBtn.cloneNode(true);
    floatBtn.parentNode.replaceChild(newBtn, floatBtn);
    newBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleFloatingAddClick();
    };
  } else {
    floatBtn.style.display = "none";
  }
}

// 4. Master Flush Function
// Takes items from all queues and adds them to the board
function handleFloatingAddClick() {
  // Hide UI
  clearSelection();
  closeInterlinearPanel();
  closeSearchQuery();

  const verses = Array.from(window.pendingVerseAdds.values());
  const songs = Array.from(window.pendingSongAdds.values());
  const interlinear = Array.from(window.pendingInterlinearAdds.values());

  if (verses.length === 0 && songs.length === 0 && interlinear.length === 0) return;

  // Clear Queues
  window.pendingVerseAdds.clear();
  window.pendingSongAdds.clear();
  window.pendingInterlinearAdds.clear();
  
  updateFloatingAddButton(); // Hide button immediately

  let delay = 0.05;

  // --- PROCESS VERSES (Group continuous ranges) ---
  if (verses.length > 0) {
    // Sort
    const parseRef = (ref) => {
      const m = ref.match(/:(\d+)$/);
      return m ? parseInt(m[1]) : 0;
    };
    verses.sort((a, b) => parseRef(a.reference) - parseRef(b.reference));

    // Group
    let groups = [[verses[0]]];
    for (let i = 1; i < verses.length; i++) {
        const prev = groups[groups.length-1][groups[groups.length-1].length-1];
        const curr = verses[i];
        const prevNum = parseRef(prev.reference);
        const currNum = parseRef(curr.reference);
        
        // Check if same book/chapter and sequential verse
        const prevBase = prev.reference.split(":")[0];
        const currBase = curr.reference.split(":")[0];
        
        if (prevBase === currBase && currNum === prevNum + 1) {
            groups[groups.length-1].push(curr);
        } else {
            groups.push([curr]);
        }
    }

    // Add Groups
    groups.forEach(group => {
        if (group.length === 1) {
            const v = group[0];
            window.BoardAPI.addBibleVerse(v.reference, v.text, false, v.version, delay);
        } else {
            // Range
            const first = group[0];
            const last = group[group.length - 1];
            const baseRef = first.reference.split(":")[0];
            const startV = first.reference.split(":")[1];
            const endV = last.reference.split(":")[1];
            
            // Combine text: Ensure [N] spacing
            const combinedText = group.map(v => {
                const vNum = v.reference.split(":")[1];
                // Strip existing [N] to avoid double brackets
                const clean = v.text.replace(/^\[\d+\]\s*/, "").replace(/^\d+\s+/, "");
                return `[${vNum}] ${clean}`;
            }).join(" ");
            
            window.BoardAPI.addBibleVerse(`${baseRef}:${startV}-${endV}`, combinedText, false, first.version, delay);
        }
        delay += 0.15;
    });
  }

  // --- PROCESS SONGS ---
  songs.forEach(song => {
    window.BoardAPI.addSongElement(song, delay);
    delay += 0.15;
  });

  // --- PROCESS INTERLINEAR ---
  interlinear.forEach(item => {
    window.BoardAPI.addInterlinearCard(item, delay);
    delay += 0.15;
  });

  // Cleanup Visuals
  document.querySelectorAll(".selected-for-add").forEach(el => el.classList.remove("selected-for-add"));
  document.querySelectorAll(".search-query-verse-add-button.selected").forEach(el => el.classList.remove("selected"));
}