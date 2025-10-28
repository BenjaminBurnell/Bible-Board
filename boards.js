// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "./supabaseClient.js"; // Import shared client (in root)

const BUCKET = "bible-boards";

// --- State ---
let currentUser = null;
let currentModalBoard = null; // Stores {id, path, title} for the modal
let activeMenu = null; // Stores the currently open three-dot menu

// --- DOM Refs ---
const authContainer = document.getElementById("auth-container");
const signinBtn = document.getElementById("signin-btn");
const dashboardContainer = document.getElementById("dashboard-container");
const signoutBtn = document.getElementById("signout-btn");
const statusMessage = document.getElementById("status-message");
const boardGrid = document.getElementById("board-grid");
// Modal Refs
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitleInput = document.getElementById("modal-title-input");
const modalSaveBtn = document.getElementById("modal-save-btn");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const modalDeleteBtn = document.getElementById("modal-delete-btn");

// --- Create the "New Board" button ---
const newBoardBtn = document.createElement("button");
newBoardBtn.id = "new-board-btn";
newBoardBtn.className = "dash-btn primary";
newBoardBtn.textContent = "+ New Board";

// --- Helpers ---

/**
 * Formats an ISO string into a more readable date and time.
 * e.g., "5 Dec 2023 · 4:58 PM"
 */
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
 * Builds the HTML for a single board card based on the new design.
 */
function buildCardHTML(board) {
  const formattedDate = formatDate(board.updatedAt);
  const menuId = `menu-${board.id}`;

  // Use em dash as fallback for description
  const description = board.description || "—";

  // Note: Tag is omitted as requested if not present in board data
  // <span class="card-tag">School Related</span>

  return `
    <div class="board-card" 
         data-id="${board.id}" 
         data-path="${board.path}" 
         data-title="${board.title}">
      
      <button class="card-main">
        <h3 class="card-title">${board.title || "Untitled Board"}</h3>
        <p class="card-desc">${description}</p>
        <div class="card-footer">
          <span class="card-date">
            <svg xmlns="http://www.w3.org/2000/svg" height="14" width="14" viewBox="0 0 20 20" fill="currentColor">
              <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828zM3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" />
            </svg>
            ${formattedDate}
          </span>
          
        </div>
      </button>

      <div class="card-more">
        <button class="more-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
          <svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
          </svg>
        </button>
        <ul id="${menuId}" class="more-menu hidden" role="menu">
          <li>
            <button class="menu-item menu-rename" role="menuitem">Rename</button>
          </li>
          <li>
            <button class="menu-item menu-delete" role="menuitem">Delete</button>
          </li>
        </ul>
      </div>
    </div>
  `;
}

function renderStatus(state, message = "") {
  boardGrid.innerHTML = ""; // Clear grid
  // ALWAYS ADD THE BUTTON BACK TO THE START
  boardGrid.prepend(newBoardBtn);

  switch (state) {
    case "loading":
      statusMessage.innerHTML = "";
      // Show 6 skeletons
      for (let i = 0; i < 6; i++) {
        const skeleton = document.createElement("div");
        skeleton.className = "skeleton-card";
        // Use appendChild so they appear AFTER the prepended button
        boardGrid.appendChild(skeleton);
      }
      break;
    case "empty":
      statusMessage.innerHTML = "No boards yet. Create one to get started!";
      break;
    case "error":
      statusMessage.innerHTML = `<div class="error-message">
        <strong>Error:</strong> ${message || "Could not load boards."}
        <button id="retry-load-btn" class="dash-btn">Retry</button>
      </div>`;
      document
        .getElementById("retry-load-btn")
        ?.addEventListener("click", () => loadBoards(currentUser));
      break;
    case "clear":
      statusMessage.innerHTML = "";
      break;
  }
}

function renderGrid(boards) {
  renderStatus("clear"); // This now clears the grid AND adds the button
  if (boards.length === 0) {
    renderStatus("empty"); // This also adds the button
    return;
  }

  // Build a single HTML string for efficiency
  let gridHTML = "";
  boards.forEach((board) => {
    gridHTML += buildCardHTML(board);
  });
  
  // INSTEAD of replacing innerHTML, we insert the
  // grid HTML at the end, AFTER the button.
  boardGrid.insertAdjacentHTML("beforeend", gridHTML);
}

// --- Menu Logic ---
function closeActiveMenu() {
  if (activeMenu) {
    activeMenu.classList.add("hidden");
    const button = activeMenu
      .closest(".card-more")
      ?.querySelector(".more-btn");
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
        upsert: true, // Use upsert:true as a fallback
      });
    if (updateError) throw updateError;

    // 4. Success: update DOM and close
    const card = boardGrid.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.querySelector(".card-title").textContent = newTitle;
      card.dataset.title = newTitle; // Update dataset for next action
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

  if (
    !confirm(
      `Are you sure you want to permanently delete "${title}"?\nThis cannot be undone.`
    )
  ) {
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
    // Check if grid is now empty
    if (boardGrid.children.length === 0) {
      renderStatus("empty");
    }
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
      // Simple HTML strip
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
    // 1. List all files in the user's /boards directory
    const { data: files, error } = await sb.storage
      .from(BUCKET)
      .list(`${user.id}/boards`, {
        limit: 100,
        sortBy: { column: "updated_at", order: "desc" },
      });

    if (error) throw error;

    // 2. Fetch details (title, updatedAt) for each file
    const detailPromises = files
      .filter((f) => f.name.endsWith(".json")) // Ensure we only get json
      .map((file) => fetchBoardDetails(user, file));

    const boards = await Promise.all(detailPromises);

    // 3. Render the grid
    renderGrid(boards);
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
      viewport: {
        scrollLeft: 3500,
        scrollTop: 3500,
        scale: 1,
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
      upsert: false, // Create only
    });

    if (error) throw error;

    // UPDATED: Navigate to editor in board/ subfolder
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
    authContainer.style.display = "flex"; // Use flex for centering
    dashboardContainer.style.display = "none";
    renderStatus("clear");
  }
}

// --- Init ---
async function init() {
  // --- Auth Listeners ---
  var redirectURL = window.location.origin; 
  if(window.location.href == "https://benjaminburnell.github.io/Bible-Board/"){
    redirectURL = "https://benjaminburnell.github.io/Bible-Board/"
  }
  signinBtn.addEventListener("click", () => {
    sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectURL }, // Return to dashboard
    });
  });
  signoutBtn.addEventListener("click", () => {
    sb.auth.signOut();
  });

  // --- Board Action Listeners ---
  newBoardBtn.addEventListener("click", handleNewBoard);

  // Global click delegate for the board grid
  boardGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".board-card");
    if (!card) return;

    // Get board data from the card's dataset
    const board = {
      id: card.dataset.id,
      path: card.dataset.path,
      title: card.dataset.title,
    };

    // Case 1: Click the main card body
    if (e.target.closest(".card-main")) {
      closeActiveMenu();
      window.location.href = `board/index.html?board=${board.id}&owner=${currentUser.id}`;
    }
    // Case 2: Click the three-dots button
    else if (e.target.closest(".more-btn")) {
      toggleMenu(e.target.closest(".more-btn"));
    }
    // Case 3: Click the "Rename" menu item
    else if (e.target.closest(".menu-rename")) {
      closeActiveMenu();
      currentModalBoard = board; // Set state for the modal
      openModal(board);
    }
    // Case 4: Click the "Delete" menu item
    else if (e.target.closest(".menu-delete")) {
      closeActiveMenu();
      currentModalBoard = board; // Set state for the delete handler
      handleDelete(); // This function will ask for confirmation
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
  // Close menu on outside click
  document.addEventListener("click", (e) => {
    if (!activeMenu) return;
    if (!e.target.closest(".card-more")) {
      closeActiveMenu();
    }
  });
  // Close menu on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeActiveMenu();
    }
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