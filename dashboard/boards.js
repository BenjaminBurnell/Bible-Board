// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "../supabaseClient.js";

const BUCKET = "bible-boards";

// --- State ---
let currentUser = null;
let currentModalBoard = null; // Stores {id, path, title} for the modal
let activeMenu = null; // Stores the currently open three-dot menu

// --- DOM Refs ---
const signoutBtn = document.getElementById("signout-btn");
const boardGrid = document.getElementById("board-grid");
const filterInput = document.getElementById("board-filter");
const sortSelect = document.getElementById("board-sort");

// Fix: Ensure button exists before using
const newBoardBtn = document.getElementById("new-board-btn");

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
function renderStatus(state, message = "") {
  // 1. Clear the grid of all cards
  boardGrid.innerHTML = "";
  
  // 2. Re-attach the status tile (since innerHTML="" removed it)
  boardGrid.appendChild(statusTile);

  // default visibility
  statusTile.classList.remove("hidden");
  statusTile.innerHTML = "";

  switch (state) {
    case "loading": {
      // hide tile; show skeletons as grid items
      statusTile.classList.add("hidden");
      for (let i = 0; i < 10; i++) {
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

/** Builds the HTML for one board card */
function buildCardHTML(board) {
  const description =
    board.description || "Double-click this board to start adding verses and notes.";
  const updatedAt = board.updatedAt
    ? new Date(board.updatedAt)
    : new Date(board.createdAt || Date.now());
  const formattedDate = updatedAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const menuId = `menu-${board.id}`;

  return `
    <div class="board-card" data-id="${board.id}" data-path="${board.path}" data-title="${board.title}">
      <button class="card-main" type="button">
        <div class="card-text-block">
          <h3 class="card-title">${board.title || "Untitled Board"}</h3>
          <p class="card-desc">${description}</p>
        </div>

        <div class="card-footer">
          </div>
      </button>

      <div class="card-more">
        <span class="card-date">
          ${formattedDate}
        </span>

        <button class="more-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
          <svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>

        <ul id="${menuId}" class="more-menu hidden" role="menu">
          <li><button class="menu-item menu-share" role="menuitem" type="button">Share link</button></li>
          <li><button class="menu-item menu-rename" role="menuitem" type="button">Rename</button></li>
          <li><button class="menu-item menu-delete" role="menuitem" type="button">Delete</button></li>
        </ul>
      </div>
    </div>
  `;
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

/** Applies current UI filter+sort and renders */
function refreshGridFromUI() {
  const q = filterInput?.value || "";
  const sortKey = sortSelect?.value || "updatedDesc";
  const filtered = applyFilter(loadedBoards, q);
  const sorted = applySort(filtered, sortKey);
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
  if (!activeMenu) return;
  activeMenu.classList.add("hidden");
  const button = activeMenu.closest(".card-more")?.querySelector(".more-btn");
  if (button) button.setAttribute("aria-expanded", "false");
  activeMenu = null;
}

function openMenu(menuEl) {
  if (activeMenu === menuEl) {
    closeActiveMenu();
    return;
  }
  closeActiveMenu();
  activeMenu = menuEl;
  activeMenu.classList.remove("hidden");
  const button = activeMenu.closest(".card-more")?.querySelector(".more-btn");
  if (button) button.setAttribute("aria-expanded", "true");
}

/** Opens modal pre-filled with board info */
function openModal(board) {
  currentModalBoard = board;
  modalTitleInput.value = board.title || "";
  modalBackdrop.classList.remove("hidden");
  modalTitleInput.focus();
}

function closeModal() {
  modalBackdrop.classList.add("hidden");
  currentModalBoard = null;
}

// --- Rename ---
async function handleRename() {
  if (!currentModalBoard) return;
  const oldTitle = currentModalBoard.title || "";
  const newTitle = modalTitleInput.value.trim();
  if (!newTitle || newTitle === oldTitle) {
    closeModal();
    return;
  }

  modalSaveBtn.disabled = true;
  modalSaveBtn.textContent = "Saving...";

  const { id, path } = currentModalBoard;

  try {
    const user = currentUser;
    if (!user) throw new Error("Not signed in");

    // Download current board JSON
    const { data: blob, error: downloadErr } = await sb.storage
      .from(BUCKET)
      .download(path);
    if (downloadErr) throw downloadErr;

    const text = await blob.text();
    const boardJson = JSON.parse(text);

    boardJson.title = newTitle;
    boardJson.updatedAt = new Date().toISOString();

    const newBlob = new Blob([JSON.stringify(boardJson, null, 2)], {
      type: "application/json",
    });

    const { error: uploadErr } = await sb.storage
      .from(BUCKET)
      .upload(path, newBlob, {
        cacheControl: "0",
        upsert: true,
      });

    if (uploadErr) throw uploadErr;

    // Update local list & re-render
    const idx = loadedBoards.findIndex((b) => b.id === id);
    if (idx >= 0) {
      loadedBoards[idx].title = newTitle;
      loadedBoards[idx].updatedAt = boardJson.updatedAt;
    }

    // Update the card in place (avoid full re-render)
    const card = boardGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.querySelector(".card-title").textContent = newTitle;
      const updated = new Date(boardJson.updatedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      // We update date but preserve SVG icon
      const dateEl = card.querySelector(".card-date");
      if(dateEl) {
          dateEl.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V17h6.828l7.586-7.586a2 2 0 000-2.828zM3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
          </svg>
          ${updated}
        `;
      }
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

// --- Delete ---
async function handleDelete() {
  if (!currentModalBoard) return;
  const { id, path } = currentModalBoard;

  if (!confirm("Delete this board permanently?")) return;

  modalDeleteBtn.disabled = true;
  modalDeleteBtn.textContent = "Deleting...";

  try {
    const { error } = await sb.storage.from(BUCKET).remove([path]);
    if (error) throw error;

    // Success: remove from DOM and close
    boardGrid.querySelector(`[data-id="${id}"]`)?.remove();
    
    // Remove from local array
    loadedBoards = loadedBoards.filter(b => b.id !== id);

    closeModal();

    if (loadedBoards.length === 0) renderStatus("empty");
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
      createdAt: json.createdAt || file.created_at || null,
      updatedAt: json.updatedAt || file.updated_at || file.created_at || null,
      path,
    };
  } catch (err) {
    console.error("Failed to fetch details for", file.name, err);
    return null;
  }
}


async function loadBoards(user) {
  if (!user) return;
  renderStatus("loading");

  try {
    const { data, error } = await sb.storage.from(BUCKET).list(user.id + "/boards", {
      limit: 1000,
    });
    if (error) throw error;

    if (!data || data.length === 0) {
      loadedBoards = [];
      renderStatus("empty");
      return;
    }

    const boardPromises = data
      .filter((file) => file.name.endsWith(".json"))
      .map((file) => fetchBoardDetails(user, file));

    const results = await Promise.all(boardPromises);
    loadedBoards = results.filter(Boolean);

    if (loadedBoards.length === 0) {
      renderStatus("empty");
      return;
    }

    const sorted = applySort(loadedBoards, sortSelect?.value || "updatedDesc");
    renderGrid(sorted);
  } catch (error) {
    console.error("Error loading boards:", error);
    renderStatus("error", error.message);
  }
}

// --- New Board Creation ---
async function handleNewBoard() {
  if (!currentUser) {
    alert("Please sign in first.");
    return;
  }

  newBoardBtn.disabled = true;
  newBoardBtn.textContent = "Creating...";

  const user = currentUser;

  try {
    const boardId = crypto.randomUUID();
    const path = `${user.id}/boards/${boardId}.json`;

    const now = new Date().toISOString();

    // FIX: Changed 'items' to 'elements' to match reading logic
    const defaultBoard = {
      id: boardId,
      title: "Untitled Board",
      description: "",
      createdAt: now,
      updatedAt: now,
      background: {
        type: "solid",
        color: "#020617",
      },
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

    // IMPORTANT: from /dashboard/, go up one level to /board/index.html
    window.location.href = `../board/index.html?board=${boardId}&owner=${currentUser.id}`;
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
    loadBoards(user);
  }
}


// --- Init ---
async function init() {
  // --- SIGN OUT BUTTON (still allowed on dashboard) ---
  if (signoutBtn) {
    signoutBtn.addEventListener("click", async () => {
      try {
        await sb.auth.signOut();
      } catch (err) {
        console.error("Sign out failed:", err);
        alert(`Sign out failed: ${err.message || err}`);
      }

      // After sign-out, send them back to the landing page explicitly
      const landingUrl = `${window.location.origin}/`;
      window.location.href = landingUrl;
    });
  }

  // --- NEW BOARD BUTTON ---
  // Fix: Check if button exists before adding listener
  if (newBoardBtn) {
      newBoardBtn.addEventListener("click", handleNewBoard);
  }

  // --- BOARD GRID CLICKS (open board, menu actions) ---
  boardGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".board-card");
    if (!card) return;

    // 1) Clicking the 3-dot "more" button
    const moreBtn = e.target.closest(".more-btn");
    if (moreBtn) {
      const menuId = moreBtn.getAttribute("aria-controls");
      const menu = document.getElementById(menuId);
      if (menu) {
        openMenu(menu);
      }
      return;
    }

    // 2) Clicking the card main body (to open)
    // We check if we clicked specific parts, or just bubbling up
    if(e.target.closest('.card-main') || e.target.className == "card-footer" || e.target.className == "card-date") {
      closeActiveMenu();
      const boardId = card.dataset.id;
      if (boardId && currentUser) {
        // From /dashboard/ go up to /board/index.html
        window.location.href = `../board/index.html?board=${boardId}&owner=${currentUser.id}`;
      }
      return;
    }

    // 3) Menu item actions (rename / delete / share)
    const menuItem = e.target.closest(".menu-item");
    if (!menuItem) return;

    const board = {
      id: card.dataset.id,
      path: card.dataset.path,
      title: card.dataset.title,
    };

    if (menuItem.classList.contains("menu-rename")) {
      closeActiveMenu();
      openModal(board);
    } else if (menuItem.classList.contains("menu-delete")) {
      closeActiveMenu();
      currentModalBoard = board;
      handleDelete();
    } else if (menuItem.classList.contains("menu-share")) {
      closeActiveMenu();
      if (currentUser) {
        const url = new URL(window.location.origin + "/board/index.html");
        url.searchParams.set("board", board.id);
        url.searchParams.set("owner", currentUser.id);
        const shareUrl = url.toString();

        try {
          navigator.clipboard.writeText(shareUrl);
          alert("Link copied!");
        } catch (err) {
          console.error("Failed to copy link: ", err);
          alert("Could not copy link. Check the console for your link.");
          console.log("Share link:", shareUrl);
        }
      }
    }
  });

  // --- MODAL SAVE/DELETE ---
  modalSaveBtn.addEventListener("click", handleRename);
  modalDeleteBtn.addEventListener("click", handleDelete);
  document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);

  // --- CLOSE 3-DOT MENU WHEN CLICKING OUTSIDE ---
  document.addEventListener("click", (e) => {
    if (!activeMenu) return;
    if (!e.target.closest(".card-more")) {
      closeActiveMenu();
    }
  });

  // --- FILTER & SORT ---
  filterInput?.addEventListener("input", refreshGridFromUI);
  sortSelect?.addEventListener("change", refreshGridFromUI);

  // --- KEYBOARD SHORTCUTS ---
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea";

    if (!typing && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      newBoardBtn?.click();
    }

    if (e.key === "Escape") {
      closeActiveMenu();
      closeModal();
    }
  });

  // --- AUTH: PROTECT THIS PAGE ---
  sb.auth.onAuthStateChange((_event, data) => {
    const user = data?.session?.user || null;
    handleAuthChange(user);
  });

  try {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    const user = data.session?.user || null;
    handleAuthChange(user); 
  } catch (error) {
    console.error("Error getting session:", error);
    handleAuthChange(null);
  }
}

// Start the app
init();