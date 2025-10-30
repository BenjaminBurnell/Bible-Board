// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "./supabaseClient.js"; // Import shared client (in root)

const BUCKET = "bible-boards";

// --- State ---
let currentUser = null;
let currentModalBoard = null; // Stores {id, path, title} for the modal
let activeMenu = null;        // Stores the currently open three-dot menu

// --- DOM Refs ---
const authContainer = document.getElementById("auth-container");
const signinBtn = document.getElementById("signin-btn");
const dashboardContainer = document.getElementById("dashboard-container");
const signoutBtn = document.getElementById("signout-btn");
const boardGrid = document.getElementById("board-grid");
const filterInput = document.getElementById("board-filter");
const sortSelect  = document.getElementById("board-sort");

// Modal Refs
const modalBackdrop   = document.getElementById("modal-backdrop");
const modalTitleInput = document.getElementById("modal-title-input");
const modalSaveBtn    = document.getElementById("modal-save-btn");
const modalCancelBtn  = document.getElementById("modal-cancel-btn");
const modalDeleteBtn  = document.getElementById("modal-delete-btn");

// 🔧 Status tile lives *inside* the grid
const statusTile = document.createElement("div");
statusTile.id = "status-message";
statusTile.className = "status-tile hidden"; // hidden by default
boardGrid.appendChild(statusTile);           // attach once

// ==================== Theme Toggle ====================
const toggle   = document.getElementById("theme-toggle");
const body     = document.body;
const moonIcon = document.getElementById("moon-icon");
const sunIcon  = document.getElementById("sun-icon");

function setTheme(isLight) {
  body.classList.toggle("light", isLight);
  localStorage.setItem("theme", isLight ? "light" : "dark");
  if (moonIcon) moonIcon.style.display = isLight ? "block" : "none";
  if (sunIcon)  sunIcon.style.display  = isLight ? "none"  : "block";
}
setTheme(localStorage.getItem("theme") === "light");
toggle?.addEventListener("click", () =>
  setTheme(!body.classList.contains("light"))
);

// In-memory boards cache (full set from Supabase)
let loadedBoards = [];

// --- Create the "New Board" button ---
const newBoardBtn = document.createElement("button");
newBoardBtn.id = "new-board-btn";
newBoardBtn.className = "dash-btn primary";
newBoardBtn.textContent = "+ New Board";

// --- Helpers ---
function formatDate(isoString) {
  if (!isoString) return "unknown";
  try {
    const date = new Date(isoString);
    const dateOptions = { day: "numeric", month: "short", year: "numeric" };
    const timeOptions = { hour: "numeric", minute: "numeric", hour12: true };
    const formattedDate = date.toLocaleDateString("en-US", dateOptions);
    const formattedTime = date.toLocaleTimeString("en-US", timeOptions);
    return `${formattedDate} · ${formattedTime}`;
  } catch (e) {
    console.warn("Could not parse date:", isoString, e);
    return "unknown";
  }
}

/**
 * Builds the HTML for a single board card.
 * Footer is LAST so CSS can pin it to the bottom-left via margin-top:auto.
 */
function buildCardHTML(board) {
  const formattedDate = formatDate(board.updatedAt);
  const menuId = `menu-${board.id}`;
  const description = board.description || "—";

  return `
    <div class="board-card" 
         data-id="${board.id}" 
         data-path="${board.path}" 
         data-title="${board.title}">
      
      <button class="card-main" type="button">
        <h3 class="card-title">${board.title || "Untitled Board"}</h3>
        <p class="card-desc">${description}</p>
        <div class="card-footer">
          <span class="card-date">
            <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
            </svg>
            ${formattedDate}
          </span>
        </div>
      </button>

      <div class="card-more">
        <button class="more-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
          <svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>
        <ul id="${menuId}" class="more-menu hidden" role="menu">
          <li><button class="menu-item menu-rename" role="menuitem" type="button">Rename</button></li>
          <li><button class="menu-item menu-delete" role="menuitem" type="button">Delete</button></li>
        </ul>
      </div>
    </div>
  `;
}

/** Ensure the status tile sits right after the New Board button */
function placeStatusTile() {
  if (!statusTile.isConnected) boardGrid.appendChild(statusTile);
  if (boardGrid.firstElementChild === newBoardBtn) {
    boardGrid.insertBefore(statusTile, newBoardBtn.nextSibling);
  } else {
    boardGrid.prepend(newBoardBtn);
    boardGrid.insertBefore(statusTile, newBoardBtn.nextSibling);
  }
}

/** Render dashboard states, with status tile inside the grid */
function renderStatus(state, message = "") {
  // Clear grid, add New Board, then position status tile
  boardGrid.innerHTML = "";
  boardGrid.prepend(newBoardBtn);
  placeStatusTile();

  // default visibility
  statusTile.classList.remove("hidden");
  statusTile.innerHTML = "";

  switch (state) {
    case "loading": {
      // hide tile; show skeletons as grid items
      statusTile.classList.add("hidden");
      for (let i = 0; i < 6; i++) {
        const skeleton = document.createElement("div");
        skeleton.className = "skeleton-card";
        boardGrid.appendChild(skeleton);
      }
      break;
    }
    case "empty": {
      statusTile.textContent = "No boards yet. Create one to get started!";
      break;
    }
    case "error": {
      statusTile.innerHTML = `
        <div class="error-message">
          <strong>Error:</strong> ${message || "Could not load boards."}
          <button id="retry-load-btn" class="dash-btn" type="button">Retry</button>
        </div>`;
      document
        .getElementById("retry-load-btn")
        ?.addEventListener("click", () => loadBoards(currentUser));
      break;
    }
    case "clear":
    default: {
      statusTile.classList.add("hidden");
      statusTile.innerHTML = "";
      break;
    }
  }
}

function normalize(str) {
  return (str || "").toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
}

function applySort(arr, sortKey) {
  const a = [...arr];
  switch (sortKey) {
    case "updatedAsc":
      return a.sort((x, y) => new Date(x.updatedAt) - new Date(y.updatedAt));
    case "titleAsc":
      return a.sort((x, y) => (x.title || "").localeCompare(y.title || ""));
    case "titleDesc":
      return a.sort((x, y) => (y.title || "").localeCompare(x.title || ""));
    case "updatedDesc":
    default:
      return a.sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
  }
}

function applyFilter(arr, q) {
  const qn = normalize(q);
  if (!qn) return arr;
  return arr.filter((b) => {
    const title = normalize(b.title);
    const desc  = normalize(b.description);
    return title.includes(qn) || desc.includes(qn);
  });
}

/** Applies current UI filter+sort and renders */
function refreshGridFromUI() {
  const q = filterInput?.value || "";
  const sortKey = sortSelect?.value || "updatedDesc";
  const filtered = applyFilter(loadedBoards, q);
  const sorted   = applySort(filtered, sortKey);
  renderGrid(sorted);
}
// expose for HTML that calls window.refreshGridFromUI()
window.refreshGridFromUI = refreshGridFromUI;

function renderGrid(boards) {
  renderStatus("clear"); // clears grid AND keeps button/tile placement
  if (boards.length === 0) {
    renderStatus("empty");
    return;
  }

  // Build a single HTML string for efficiency
  let gridHTML = "";
  boards.forEach((board) => {
    gridHTML += buildCardHTML(board);
  });

  // Insert after "New Board" and (hidden) status tile
  boardGrid.insertAdjacentHTML("beforeend", gridHTML);
}

// --- Menu Logic ---
function closeActiveMenu() {
  if (activeMenu) {
    activeMenu.classList.add("hidden");
    const button = activeMenu.closest(".card-more")?.querySelector(".more-btn");
    if (button) button.setAttribute("aria-expanded", "false");
    activeMenu = null;
  }
}

function toggleMenu(menuButton) {
  const menu = document.getElementById(menuButton.getAttribute("aria-controls"));
  if (!menu) return;
  const isOpening = menu.classList.contains("hidden");

  // Close any other open menu first
  closeActiveMenu();

  if (isOpening) {
    menu.classList.remove("hidden");
    menuButton.setAttribute("aria-expanded", "true");
    activeMenu = menu;
  }
}

// --- Modal Logic ---
function openModal(board) {
  currentModalBoard = board;
  modalTitleInput.value = board.title;
  modalBackdrop.classList.remove("hidden");
  modalTitleInput.focus();
}
function closeModal() {
  currentModalBoard = null;
  modalBackdrop.classList.add("hidden");
}

async function handleRename() {
  if (!currentModalBoard) return;
  const newTitle = modalTitleInput.value.trim() || "Untitled Bible Board";
  const { id, path } = currentModalBoard;

  modalSaveBtn.disabled = true;
  modalSaveBtn.textContent = "Saving...";

  try {
    // 1. Download existing board
    const { data: blob, error: downloadError } = await sb.storage
      .from(BUCKET)
      .download(path);
    if (downloadError) throw downloadError;

    const text = await blob.text();
    const json = JSON.parse(text || "{}");

    // 2. Patch title and update timestamp
    json.title = newTitle;
    json.updatedAt = new Date().toISOString();

    // 3. Upload/Update
    const newBlob = new Blob([JSON.stringify(json, null, 2)], {
      type: "application/json",
    });
    const { error: updateError } = await sb.storage
      .from(BUCKET)
      .update(path, newBlob, {
        contentType: "application/json",
        cacheControl: "0",
        upsert: true,
      });
    if (updateError) throw updateError;

    // 4. Success: update DOM and close
    const card = boardGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.querySelector(".card-title").textContent = newTitle;
      card.dataset.title = newTitle;
      card.querySelector(".card-date").innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 20 20" fill="currentColor">
          <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
        </svg>
        ${formatDate(json.updatedAt)}
      `;
    }
    closeModal();
  } catch (error) {
    console.error("Failed to rename:", error);
    alert(`Error renaming board: ${error.message}`);
  } finally {
    modalSaveBtn.disabled = false;
    modalSaveBtn.textContent = "Save";
  }
}

async function handleDelete() {
  if (!currentModalBoard) return;
  const { id, path, title } = currentModalBoard;

  if (!confirm(`Are you sure you want to permanently delete "${title}"?\nThis cannot be undone.`)) {
    return;
  }

  modalDeleteBtn.disabled = true;
  modalDeleteBtn.textContent = "Deleting...";

  try {
    const { error } = await sb.storage.from(BUCKET).remove([path]);
    if (error) throw error;

    // Success: remove from DOM and close
    boardGrid.querySelector(`[data-id="${id}"]`)?.remove();
    closeModal();

    // If grid (excluding the New Board button + status tile) is empty, show empty state
    const remainingCards = [...boardGrid.children].filter(
      el => ![newBoardBtn, statusTile].includes(el)
    );
    if (remainingCards.length === 0) renderStatus("empty");
  } catch (error) {
    console.error("Failed to delete:", error);
    alert(`Error deleting board: ${error.message}`);
  } finally {
    modalDeleteBtn.disabled = false;
    modalDeleteBtn.textContent = "Delete";
  }
}

// --- Data Fetching ---
async function fetchBoardDetails(user, file) {
  const path = `${user.id}/boards/${file.name}`;
  try {
    const { data: blob, error } = await sb.storage.from(BUCKET).download(path);
    if (error) throw error;

    const text = await blob.text();
    const json = JSON.parse(text || "{}");

    // Try to find a description
    const firstNote = (json.elements || []).find((el) => el.type === "note");
    let description = null;
    if (firstNote && firstNote.html) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = firstNote.html;
      description = (tempDiv.textContent || tempDiv.innerText || "").trim();
      if (description === "") description = null;
    }

    return {
      id: file.name.replace(".json", ""),
      path: path,
      title: json.title || "Untitled Board",
      updatedAt: json.updatedAt || file.updated_at, // Fallback to file meta
      description: description, // Will be null or a string
    };
  } catch (err) {
    console.warn(`Failed to download details for ${file.name}:`, err);
    return {
      id: file.name.replace(".json", ""),
      path: path,
      title: "Error: Could not load title",
      updatedAt: file.updated_at,
      description: "Could not load details.",
    };
  }
}

async function loadBoards(user) {
  if (!user) return;
  renderStatus("loading");

  try {
    const { data: files, error } = await sb.storage
      .from(BUCKET)
      .list(`${user.id}/boards`, {
        limit: 100,
        sortBy: { column: "updated_at", order: "desc" },
      });

    if (error) throw error;

    const detailPromises = (files || [])
      .filter((f) => f.name.endsWith(".json"))
      .map((file) => fetchBoardDetails(user, file));

    loadedBoards = await Promise.all(detailPromises);
    refreshGridFromUI();
  } catch (error) {
    console.error("Error loading boards:", error);
    renderStatus("error", error.message);
  }
}

// --- Event Handlers ---
async function handleNewBoard() {
  if (!currentUser) return;

  newBoardBtn.disabled = true;
  newBoardBtn.textContent = "Creating...";

  try {
    const boardId = crypto.randomUUID();
    const path = `${currentUser.id}/boards/${boardId}.json`;
    const defaultBoard = {
      version: 1,
      updatedAt: new Date().toISOString(),
      title: "Untitled Bible Board",
      viewport: { scrollLeft: 3500, scrollTop: 3500, scale: 1 },
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

    window.location.href = `board/index.html?board=${boardId}&owner=${currentUser.id}`;
  } catch (error) {
    console.error("Failed to create new board:", error);
    alert(`Error creating board: ${error.message}`);
  } finally {
    newBoardBtn.disabled = false;
    newBoardBtn.textContent = "+ New Board";
  }
}

function handleAuthChange(user) {
  currentUser = user;
  if (user) {
    authContainer.style.display = "none";
    dashboardContainer.style.display = "block";
    loadBoards(user);
  } else {
    authContainer.style.display = "flex";
    dashboardContainer.style.display = "none";
    renderStatus("clear");
  }
}

// --- Init ---
async function init() {
  // --- Auth Listeners ---
  let redirectURL = window.location.origin;
  if (window.location.href === "https://benjaminburnell.github.io/Bible-Board/") {
    redirectURL = "https://benjaminburnell.github.io/Bible-Board/";
  }

  signinBtn.addEventListener("click", () => {
    sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectURL },
    });
  });

  signoutBtn.addEventListener("click", () => {
    sb.auth.signOut();
  });

  // --- Board Action Listeners ---
  newBoardBtn.addEventListener("click", handleNewBoard);

  // Delegated click handling for the grid
  boardGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".board-card");
    if (!card) return;

    // 1) If click is on the MORE button → toggle menu (no navigation)
    const moreBtn = e.target.closest(".more-btn");
    if (moreBtn) {
      e.stopPropagation();
      toggleMenu(moreBtn);
      return;
    }

    // 2) If click is on a MENU ITEM → action (no navigation)
    if (e.target.closest(".menu-rename") || e.target.closest(".menu-delete")) {
      const board = {
        id: card.dataset.id,
        path: card.dataset.path,
        title: card.dataset.title,
      };

      if (e.target.closest(".menu-rename")) {
        closeActiveMenu();
        openModal(board);
      } else if (e.target.closest(".menu-delete")) {
        closeActiveMenu();
        currentModalBoard = board;
        handleDelete();
      }
      return;
    }

    // 3) If click is on the MENU container or inside card-more → do nothing
    if (e.target.closest(".card-more") || e.target.closest(".more-menu")) {
      return;
    }

    // 4) Otherwise, if user clicks the card body (.card-main) → navigate
    if (e.target.closest(".card-main")) {
      closeActiveMenu();
      const board = {
        id: card.dataset.id,
        path: card.dataset.path,
        title: card.dataset.title,
      };
      window.location.href = `board/index.html?board=${board.id}&owner=${currentUser.id}`;
    }
  });

  // --- Modal Listeners ---
  modalCancelBtn.addEventListener("click", closeModal);
  modalSaveBtn.addEventListener("click", handleRename);
  modalDeleteBtn.addEventListener("click", handleDelete);
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  // --- Global Listeners for Menu ---
  document.addEventListener("click", (e) => {
    // Close if clicking outside any open menu
    if (!activeMenu) return;
    if (!e.target.closest(".card-more")) {
      closeActiveMenu();
    }
  });

  // --- Filter & Sort ---
  filterInput?.addEventListener("input", refreshGridFromUI);
  sortSelect?.addEventListener("change", refreshGridFromUI);

  // --- Keyboard shortcuts ---
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea";
    if (!typing && e.key === "/") {
      e.preventDefault();
      filterInput?.focus();
    }
    if (!typing && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      newBoardBtn?.click();
    }
  });

  // Close menu on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeActiveMenu();
  });

  // --- Auth State ---
  sb.auth.onAuthStateChange((event, session) => {
    handleAuthChange(session?.user || null);
  });

  // Check initial session *immediately*
  try {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    handleAuthChange(data.session?.user || null);
  } catch (error) {
    console.error("Error getting session:", error);
    handleAuthChange(null);
  }
}

// Start the app
init();
