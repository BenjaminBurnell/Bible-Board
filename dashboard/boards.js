// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "../supabaseClient.js";
import { SubscriptionService } from "../subscriptionService.js";

const BUCKET = "bible-boards";
const FREE_BOARD_LIMIT = 3; // The maximum number of boards for a free user
const FREE_ITEM_LIMIT_PER_BOARD = 100;

// --- State ---
let currentUser = null;
let currentModalBoard = null;
let activeMenu = null;
let activeDropdown = null; 
let loadedBoards = [];
let boardToDelete = null;

// New: track whether we've finished loading the user's boards
let boardsLoaded = false;

// Assume FREE until proved Pro
window.BIBLEBOARD_IS_PRO = false;

// Also keep your isCreatingBoard flag if you added one:
let isCreatingBoard = false;

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

  try {
    // 1) Preferred: if your SubscriptionService exposes a direct boolean method
    if (typeof SubscriptionService.hasActiveSubscription === "function") {
      const active = await SubscriptionService.hasActiveSubscription();
      return !!active;
    }

    // 2) Fallback: use initAndCheck but interpret its result
    const result = await SubscriptionService.initAndCheck();

    // If it literally returns a boolean, just use it.
    if (typeof result === "boolean") {
      return result;
    }

    // If it returns an object, look for common flags:
    if (result && typeof result === "object") {
      if (typeof result.isPro === "boolean") return result.isPro;
      if (typeof result.hasActiveSubscription === "boolean") return result.hasActiveSubscription;
      if (typeof result.active === "boolean") return result.active;
    }

    // If we reach here, we couldn't confidently say "Pro", so treat as free.
    return false;
  } catch (e) {
    console.error("isProUser: SubscriptionService error", e);
    return false;
  }
}

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

// Prefer to attach inside the scroll container so it moves with the list
if (sidebarBoardsContainer) {
  sidebarBoardsContainer.appendChild(contextMenuEl);
} else {
  document.body.appendChild(contextMenuEl);
}


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
  contextMenuEl.classList.remove('show');

  // Clear highlight + 3-dot state on the last item
  if (openBoardContextItem) {
    openBoardContextItem.classList.remove('context-open');
    const prevBtn = openBoardContextItem.querySelector('.sidebar-menu-btn');
    if (prevBtn) prevBtn.classList.remove('active');
    openBoardContextItem = null;
  }
}
window.closeContextMenu = closeContextMenu;


function openContextMenu(e, board, itemEl, menuBtn) {
  e.preventDefault();
  e.stopPropagation();
  currentModalBoard = board;

  const container = sidebarBoardsContainer || document.getElementById("sidebar-boards-container") || document.body;

  // Move menu into the correct container if needed
  if (contextMenuEl.parentElement !== container) {
    container.appendChild(contextMenuEl);
  }

  // Clear old item highlight / active dots
  if (openBoardContextItem && openBoardContextItem !== itemEl) {
    openBoardContextItem.classList.remove('context-open');
    const prevBtn = openBoardContextItem.querySelector('.sidebar-menu-btn');
    if (prevBtn) prevBtn.classList.remove('active');
  }

  // Track + highlight the current item and its 3-dots
  openBoardContextItem = itemEl;
  if (itemEl) itemEl.classList.add('context-open');
  if (menuBtn) menuBtn.classList.add('active');

  // Temporarily show menu (hidden) so we can measure its size
  contextMenuEl.style.visibility = "hidden";
  contextMenuEl.classList.add('show');

  requestAnimationFrame(() => {
    const containerRect = container.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const menuRect = contextMenuEl.getBoundingClientRect();
    const scrollY = container.scrollTop || 0;

    // Position relative to the scrolling container:
    //   - vertical: just under the item (with scroll offset)
    //   - horizontal: right-aligned inside the container
    let top = scrollY + (itemRect.bottom - containerRect.top) + 8;
    let left = container.clientWidth - menuRect.width - 8;
    if (left < 8) left = 8;

    contextMenuEl.style.top = `${top}px`;
    contextMenuEl.style.left = `${left}px`;
    contextMenuEl.style.visibility = "visible";
  });
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
        openContextMenu(e, board, itemDiv, menuBtn);
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

// --- Load all boards for the current user ---
async function loadBoards() {
  try {
    boardsLoaded = false;
    if (typeof updateBoardCreateButtonState === "function") {
      updateBoardCreateButtonState();
    }

    const user = currentUser;
    renderStatus("Loading boards…");

    if (!user) {
      renderStatus("Not signed in.");
      loadedBoards = [];
      renderSidebarBoards([]);
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }
      return;
    }

    const { data: files, error: listErr } = await sb.storage
      .from(BUCKET)
      .list(`${user.id}/boards`, { limit: 200, offset: 0 });

    if (listErr) {
      console.error("List error:", listErr);
      renderStatus("Error loading boards.");
      loadedBoards = [];
      renderSidebarBoards([]);
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }
      return;
    }

    // Only count files that are board JSONs
    const boardFiles = Array.isArray(files)
      ? files.filter((f) => f.name.endsWith(".json"))
      : [];

    if (!boardFiles || boardFiles.length === 0) {
      renderStatus("Creating your first board...");
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }
      // Fresh user → allow first board creation, then loadBoards will be called again
      await handleNewBoard(true);
      return;
    }

    // Download and parse all boards
    const boardResults = await Promise.all(
      boardFiles.map((file) => fetchBoardDetails(user, file))
    );
    const boards = boardResults.filter(Boolean);

    if (boards.length === 0) {
      renderStatus("Creating your first board...");
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }
      await handleNewBoard(true);
      return;
    }

    // Sort boards by most recently updated/created
    const sorted = boards.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt) -
        new Date(a.updatedAt || a.createdAt)
    );

    loadedBoards = sorted;
    renderSidebarBoards(sorted);
    renderStatus("");

    boardsLoaded = true;
    if (typeof updateBoardCreateButtonState === "function") {
      updateBoardCreateButtonState();
    }

    // Auto-open board from URL if present, otherwise open most recent
    const params = new URLSearchParams(window.location.search);
    const targetBoardId = params.get("board");
    const ownerFromUrl = params.get("owner");

    if (targetBoardId) {
      const owner = ownerFromUrl || user.id;
      console.log("Opening board from URL params:", targetBoardId, owner);
      switchBoard(targetBoardId, owner);
    } else if (sorted.length > 0) {
      console.log("Auto-opening most recent board:", sorted[0].id);
      switchBoard(sorted[0].id, user.id);
    }
  } catch (err) {
    console.error("Failed to load boards:", err);
    renderStatus("Error loading boards.");
    loadedBoards = [];
    renderSidebarBoards([]);
    boardsLoaded = true;
    if (typeof updateBoardCreateButtonState === "function") {
      updateBoardCreateButtonState();
    }
  }
}


// --- New Board Creation ---

/**
 * Handles the user action to create a new board.
 * @param {boolean} isInitialLoad (true only when called from loadBoards() for first-time users)
 */
/**
 * Handles the user action to create a new board.
 * @param {boolean} isInitialLoad (true only when called from loadBoards() for first-time users)
 */
async function handleNewBoard(isInitialLoad = false) {
  // 1) For manual clicks, require BOTH:
  //    - subscription check done
  //    - boards list fully loaded
  if (!isInitialLoad) {
    if (!hasProCheckCompleted || !boardsLoaded) {
      console.log(
        "Blocking new board: plan/boards not ready yet",
        { hasProCheckCompleted, boardsLoaded }
      );
      return;
    }
  }

  // 2) Don’t allow spamming while a create is in-flight
  if (isCreatingBoard) {
    return;
  }

  isCreatingBoard = true;
  updateBoardCreateButtonState();

  try {
    // 3) Robust auth check: use cached user first, then Supabase
    let user = currentUser;

    if (!user) {
      try {
        const { data, error } = await sb.auth.getSession();
        if (error) {
          console.error("handleNewBoard: getSession error", error);
        }
        user = data?.session?.user || null;

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

    // Still no user → not signed in
    if (!user) {
      alert("Please sign in first.");
      return;
    }

    // 4) Use known Pro/Free flag + loadedBoards length
    const isPro = !!window.BIBLEBOARD_IS_PRO;
    const status = isPro ? "PRO" : "FREE";
    const currentCount = loadedBoards.length;

    console.log(
      `User Subscription Status: ${status} (Boards: ${currentCount})`
    );

    // 5) Enforce FREE board limit using *loadedBoards*
    if (!isPro && currentCount >= FREE_BOARD_LIMIT) {
      // Auto-creation for truly new users is handled by loadBoards + isInitialLoad
      // so if we get here with currentCount >= FREE_BOARD_LIMIT, block.
      console.warn("LIMIT REACHED: Showing upgrade modal.");
      openUpgradeModal();
      return;
    }

    // 6) Actually create the board file in Supabase
    await createBoardFile(crypto.randomUUID());
  } finally {
    isCreatingBoard = false;
    updateBoardCreateButtonState();
  }
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
function openUpgradeModal(reason) {
    if (upgradeModalBackdrop) {
        upgradeModalBackdrop.classList.remove("hidden");
        upgradeModalBackdrop.style.display = "flex";
        // you can optionally use `reason` inside the modal later
    }
}

// Make it callable from script.js (board workspace)
window.openUpgradeModal = openUpgradeModal;

window.closeUpgradeModal = function() {
    if (upgradeModalBackdrop) {
        upgradeModalBackdrop.classList.add("hidden");
        setTimeout(() => { upgradeModalBackdrop.style.display = "none"; }, 200);
    }
}


async function handleUpgrade() {
  // Close the nice modal first
  closeUpgradeModal();

  try {
    // Only using monthly right now, so hard-code monthly
    await SubscriptionService.subscribe("monthly");
    // RevenueCat SDK / your SubscriptionService should handle
    // opening the hosted pay page or Stripe checkout.
  } catch (err) {
    console.error("Error starting subscription:", err);
    // Optional: show a small toast or alert if you want
    // alert("Something went wrong starting your subscription. Please try again.");
  }
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

    hasProCheckCompleted = false;
    boardsLoaded = false;
    updateBoardCreateButtonState?.();

    const isPro = await isProUser();
    window.BIBLEBOARD_IS_PRO = !!isPro;

    await loadBoards();          // 👈 important: wait for boardsLoaded

    hasProCheckCompleted = true;
    updateBoardCreateButtonState?.();
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

  // Initialize create button state (will show "Checking plan…" at first)
  updateBoardCreateButtonState();
  
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

function updateBoardCreateButtonState() {
  // This is the label span in your sidebar button
  const btn = document.getElementById("new-board-btn-sidebar-text");

  if (!btn) return;

  // While a board is actively being created
  if (isCreatingBoard) {
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Creating…";
    return;
  }

  // NEW: require BOTH plan + boards list to be ready
  if (!hasProCheckCompleted || !boardsLoaded) {
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "Loading boards…";
    return;
  }

  // Ready for normal use
  btn.disabled = false;
  btn.classList.remove("busy");
  btn.textContent = "New Board"; // or whatever label you want
}












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


/**
 * Counts how many items are currently on the open board.
 * It assumes each board item has the class .board-item
 */
function getCurrentBoardItemCount() {
  const workspace = document.getElementById("workspace");
  if (!workspace) return 0;
  return workspace.querySelectorAll(".board-item").length;
}

/**
 * Enforces the per-board item limit for FREE users.
 * Returns true if the batch is allowed, false if we should block.
 *
 * This is used by the floating “Add N items” button.
 */
async function ensureCanAddBatch(batchSize) {
  // If user is Pro, no limit.
  if (window.BIBLEBOARD_IS_PRO) {
    return true;
  }

  const FREE_BOARD_ITEM_LIMIT = 100;
  const currentCount = getCurrentBoardItemCount();
  const projectedCount = currentCount + batchSize;

  if (projectedCount <= FREE_BOARD_ITEM_LIMIT) {
    return true;
  }

  // Over limit → show modal / block
  if (typeof window.openUpgradeModal === "function") {
    window.openUpgradeModal("board-items-limit");
  } else {
    // Fallback in case modal isn't available for some reason
    alert(
      `On the free plan, you can have up to ${FREE_BOARD_ITEM_LIMIT} items per board.\n` +
      `You currently have ${currentCount} items and are trying to add ${batchSize} more.`
    );
  }

  return false;
}


// 4. Master Flush Function
// Takes items from all queues and adds them to the board
async function handleFloatingAddClick() {
  // Hide UI immediately
  if (typeof clearSelection === "function") clearSelection();
  if (typeof closeInterlinearPanel === "function") closeInterlinearPanel();
  if (typeof closeSearchQuery === "function") closeSearchQuery();

  const verses = Array.from(window.pendingVerseAdds.values());
  const songs = Array.from(window.pendingSongAdds.values());
  const interlinear = Array.from(window.pendingInterlinearAdds.values());

  const totalToAdd = verses.length + songs.length + interlinear.length;
  if (totalToAdd === 0) return;

  // 🔒 Enforce free-plan limit ONLY on this bulk add
  const canAdd = await ensureCanAddBatch(totalToAdd);
  if (!canAdd) {
    // Do NOT clear the queues; let the user upgrade and then click again.
    return;
  }

  // Clear State (we're definitely adding them now)
  window.pendingVerseAdds.clear();
  window.pendingSongAdds.clear();
  window.pendingInterlinearAdds.clear();

  // Immediately hide the floating button
  updateFloatingAddButton();

  let delay = 0;

  // --- ADD VERSES ---
  if (verses.length > 0) {
    // Sort by reference to make grouping predictable
    verses.sort((a, b) => {
      const pa = parseFullRef(a.reference);
      const pb = parseFullRef(b.reference);

      if (pa.book !== pb.book) return pa.book.localeCompare(pb.book);
      if (pa.chapter !== pb.chapter) return pa.chapter - pb.chapter;
      return pa.verse - pb.verse;
    });

    // Group continuous verses
    let groups = [[verses[0]]];

    for (let i = 1; i < verses.length; i++) {
      const prevGroup = groups[groups.length - 1];
      const prev = prevGroup[prevGroup.length - 1];
      const curr = verses[i];

      const prevData = parseFullRef(prev.reference);
      const currData = parseFullRef(curr.reference);

      // Same Version + Book + Chapter + next verse?
      if (
        prev.version === curr.version &&
        prevData.book === currData.book &&
        prevData.chapter === currData.chapter &&
        currData.verse === prevData.verse + 1
      ) {
        prevGroup.push(curr);
      } else {
        groups.push([curr]);
      }
    }

    // Add Groups to Board
    groups.forEach((group) => {
      if (group.length === 1) {
        // Single Verse
        const v = group[0];
        window.BoardAPI.addBibleVerse(
          v.reference,
          v.text,
          false,
          v.version,
          delay
        );
      } else {
        // Verse Range
        const first = group[0];
        const last = group[group.length - 1];

        const firstData = parseFullRef(first.reference);
        const baseRef = `${firstData.book} ${firstData.chapter}`;

        const startV = firstData.verse;
        const endV = parseFullRef(last.reference).verse;

        const combinedText = group.map((v) => v.text).join(" ");

        window.BoardAPI.addBibleVerse(
          `${baseRef}:${startV}-${endV}`,
          combinedText,
          false,
          first.version,
          delay
        );
      }
      delay += 0.15;
    });
  }

  // --- ADD SONGS ---
  songs.forEach((song) => {
    window.BoardAPI.addSongElement(song, delay);
    delay += 0.15;
  });

  // --- ADD INTERLINEAR ---
  interlinear.forEach((item) => {
    window.BoardAPI.addInterlinearCard(item, delay);
    delay += 0.15;
  });

  // Cleanup Visuals
  document
    .querySelectorAll(".selected-for-add")
    .forEach((el) => el.classList.remove("selected-for-add"));
  document
    .querySelectorAll(".search-query-verse-add-button.selected")
    .forEach((el) => el.classList.remove("selected"));
}


// Helper: figure out if the user is Pro and enforce the limit for batch adds
async function canAddMoreBoardItems(batchSize) {
  try {
    // If you have a global SubscriptionService from your RevenueCat integration,
    // try to use it to detect Pro users.
    if (window.SubscriptionService) {
      // 1) Preferred: async check
      if (typeof window.SubscriptionService.hasActiveSubscription === "function") {
        const hasSub = await window.SubscriptionService.hasActiveSubscription();
        if (hasSub) return true; // Pro → no limit
      }

      // 2) Fallbacks: common flags/properties you might be using
      if (
        window.SubscriptionService.isProUser === true ||
        window.SubscriptionService.hasProAccess === true ||
        window.SubscriptionService.currentPlan === "pro" ||
        window.SubscriptionService.currentPlan === "plus"
      ) {
        return true; // Pro → no limit
      }
    }

    // 3) Optional: simple global flag you can set yourself after checking entitlements
    if (window.BIBLEBOARD_PRO_ENABLED === true) {
      return true; // Pro → no limit
    }
  } catch (err) {
    console.warn("Error checking subscription status:", err);
    // If we can't verify, we fall through and treat them as free
  }

  // At this point, we treat the user as FREE and enforce the 100-item limit.
  const workspace = document.getElementById("workspace");
  const currentCount = workspace
    ? workspace.querySelectorAll(".board-item").length
    : 0;

  const projected = currentCount + batchSize;

  if (currentCount >= FREE_BOARD_ITEM_LIMIT || projected > FREE_BOARD_ITEM_LIMIT) {
    // Show your nice upgrade modal if available, otherwise fall back to alert
    if (typeof window.openUpgradeModal === "function") {
      // You can pass a reason string if your modal cares, or just call with no args.
      window.openUpgradeModal("board-items-limit");
    } else {
      alert(
        `Board item limit reached.\n\n` +
        `On the free plan you can have up to ${FREE_BOARD_ITEM_LIMIT} items per board.\n` +
        `You currently have ${currentCount} item${currentCount !== 1 ? "s" : ""}. ` +
        `Remove some items or upgrade to Pro to add more.`
      );
    }
    return false;
  }

  return true;
}