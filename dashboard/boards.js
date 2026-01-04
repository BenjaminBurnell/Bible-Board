// boards.js
// This file controls the dashboard page (index.html)
import { sb } from "../supabaseClient.js";
import { SubscriptionService } from "../subscriptionService.js";

/* =========================
   Toast helper
   ========================= */

function ensureToastContainer() {
  let container = document.getElementById("bb-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "bb-toast-container";
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, { variant = "success", duration = 4500 } = {}) {
  const container = ensureToastContainer();

  const toast = document.createElement("div");
  toast.className = `bb-toast bb-toast-${variant}`;

  toast.innerHTML = `
    <div class="bb-toast-icon">
      <span class="material-symbols-rounded">
        ${
          variant === "success"
            ? "check_circle"
            : variant === "error"
            ? "error"
            : "info"
        }
      </span>
    </div>
    <div class="bb-toast-message">${message}</div>
    <button class="bb-toast-close" aria-label="Dismiss notification">
      <span class="material-symbols-rounded">close</span>
    </button>
  `;

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add("bb-toast-show");
  });

  const remove = () => {
    toast.classList.remove("bb-toast-show");
    setTimeout(() => toast.remove(), 200);
  };

  // Close button
  const closeBtn = toast.querySelector(".bb-toast-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", remove);
  }

  // Auto-hide
  const timeoutId = setTimeout(remove, duration);

  // Optional: pause hide on hover
  toast.addEventListener("mouseenter", () => clearTimeout(timeoutId));
}

const BUCKET = "bible-boards";
const FREE_BOARD_LIMIT = 3; // The maximum number of boards for a free user
const FREE_ITEM_LIMIT_PER_BOARD = 100;

// Pre-made template boards shown in the "get started" hero
const TEMPLATE_BOARDS = [
  {
    id: "no-condemnation",
    title: "No Condemnation",
    subtitle: "Romans 8:1 with assurance-focused passages.",
    templateFile: "91625a1c-efc3-4b4d-8e2b-6a1d67d8c670.json",
  },
  {
    id: "abiding-fruit",
    title: "Abiding & Fruit",
    subtitle: "John 15 with fruit-bearing cross references.",
    templateFile: "a1f23dd2-4879-486b-801a-b5a63a332224.json",
  },
  {
    id: "peace-anxiety",
    title: "Peace in the Middle of Anxiety",
    subtitle: "Philippians 4 with comfort & trust passages.",
    templateFile: "eca9d93c-d009-435b-b96c-9ff40e4b8086.json",
  },
];


// ==================== PROMO CODE LOGIC (client-side hashes) ====================

const PROMO_CODE_HASHES = new Set([
  // Example placeholder: replace with your real hashes
  "d82059ecd1edd9d58d10bda74e5486dbd480bd6fadb7e8ab6f56f2defcf26c7c",
]);

/**
 * Hashes a promo code using SHA-256 and returns a lowercase hex string.
 * Normalizes the input by trimming + uppercasing first.
 */
async function hashPromoInput(rawCode) {
  const normalized = (rawCode || "").trim().toUpperCase();
  if (!normalized) return null;

  if (!window.crypto?.subtle) {
    console.error(
      "Web Crypto API not available; cannot hash promo codes safely."
    );
    // Last-resort fallback: plain string (NOT ideal)
    return normalized;
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setPromoMessage(text, type = "error") {
  const msgEl = document.querySelector(".promo-plan-message");
  if (!msgEl) return;

  msgEl.textContent = text || "";
  msgEl.classList.remove("error", "success");
  if (text) {
    msgEl.classList.add(type);
  }
}

/**
 * Handles clicking the "Redeem" button or pressing Enter in the promo input.
 */
async function redeemPromoCodeFromUI() {
  const input = document.querySelector(".promo-plan-input");
  const button = document.querySelector(".redeem-code-button");
  if (!input || !button) return;

  const code = input.value;
  if (!code || !code.trim()) {
    // alert("Please enter a promo code first.");
    setPromoMessage("Please enter a promo code.", "error");
    return;
  }

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Checking…";

  try {
    const hash = await hashPromoInput(code);
    const isValid = hash && PROMO_CODE_HASHES.has(hash);

    if (!isValid) {
      setPromoMessage(
        "That promo code isn’t valid. Please double-check it.",
        "error"
      );
      // alert("That promo code isn’t valid. Please double-check it and try again.");
      return;
    }

    closeUpgradeModal();

    // ✅ Valid code — run the special RevenueCat promo flow
    if (typeof SubscriptionService?.redeemStudentPromo === "function") {
      await SubscriptionService.redeemStudentPromo();
    } else {
      // Fallback, just in case
      await SubscriptionService.subscribe();
    }

    // ✅ Promo success toast
    showToast(
      "Student promo applied — you now have BibleBoard Pro for 3 months 🎓",
      {
        variant: "success",
      }
    );

    // Optional: clear input on success attempt
    input.value = "";
  } catch (err) {
    console.error("Error redeeming promo code:", err);
    setPromoMessage(
      "Something went wrong while applying your promo. Please refresh and try again.",
      "error"
    );

    showToast("Something went wrong applying your promo. Please try again.", {
      variant: "error",
    });
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

// --- State ---
let currentUser = null;
let currentModalBoard = null;
let activeMenu = null;
let activeDropdown = null;
let loadedBoards = [];
let boardToDelete = null;

// New: track whether we've finished loading the user's boards
let boardsLoaded = false;

// When true, the next Bible reader render will NOT force-scroll to the top.
// Used so closing the reader with ESC doesn't reset scroll position.
let suppressNextReaderScroll = false;

// Assume FREE until proved Pro
window.BIBLEBOARD_IS_PRO = false;

// Also keep your isCreatingBoard flag if you added one:
let isCreatingBoard = false;

// Track the currently open context menu + its parent sidebar-board-item
let openBoardContextMenu = null;
let openBoardContextItem = null;

// ✅ NEW: tracks whether we've finished a Pro check
let hasProCheckCompleted = false;

// Local overrides for board titles to work around storage caching
let boardTitleOverrides = {};

function loadBoardTitleOverrides() {
  try {
    const raw = localStorage.getItem("bb-board-title-overrides");
    boardTitleOverrides = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn("[Boards][overrides] Failed to load overrides", err);
    boardTitleOverrides = {};
  }
}

function saveBoardTitleOverrides() {
  try {
    localStorage.setItem(
      "bb-board-title-overrides",
      JSON.stringify(boardTitleOverrides)
    );
  } catch (err) {
    console.warn("[Boards][overrides] Failed to save overrides", err);
  }
}

// Call this once at startup
loadBoardTitleOverrides();

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
      if (typeof result.hasActiveSubscription === "boolean")
        return result.hasActiveSubscription;
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
const sidebarBoardsContainer = document.getElementById(
  "sidebar-boards-container"
);
const hamburgerBtn = document.getElementById("hamburger-btn");

// New DOM Refs for Upgrade Modal
const upgradeModalBackdrop = document.getElementById("upgrade-modal-backdrop");
const upgradeModal = document.querySelector(".upgrade-modal");
const upgradeNowBtn = document.getElementById("upgrade-now-btn");

// Promo code DOM refs
const promoInputEl = document.querySelector(".promo-plan-input");
const promoBtnEl = document.querySelector(".redeem-code-button");

if (promoBtnEl && promoInputEl) {
  promoBtnEl.addEventListener("click", (e) => {
    e.preventDefault();
    redeemPromoCodeFromUI();
  });

  promoInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      redeemPromoCodeFromUI();
    }
  });
}

// Fix: Ensure button exists before using
const newBoardBtn =
  document.getElementById("new-board-btn") ||
  document.getElementById("new-board-btn-sidebar");

// Modal elements
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitleInput = document.getElementById("modal-title-input");
const modalSaveBtn = document.getElementById("modal-save-btn");

// ==================== Theme Toggle ====================
const toggle = document.getElementById("theme-toggle");
const body = document.body;
const moonIcon = document.getElementById("moon-icon");
const sunIcon = document.getElementById("sun-icon");

async function ensureUser() {
  if (currentUser) return currentUser;

  try {
    const { data, error } = await sb.auth.getSession();
    if (error) {
      console.error("ensureUser: getSession error", error);
      return null;
    }
    let user = data?.session?.user || null;

    // If we have no active session but do have a refresh token, try to refresh once.
    if (!user) {
      try {
        const { data: refreshed, error: refreshErr } =
          await sb.auth.refreshSession();
        if (refreshErr) {
          console.error("ensureUser: refreshSession error", refreshErr);
        } else {
          user = refreshed?.session?.user || null;
        }
      } catch (refreshCatch) {
        console.error("ensureUser: unexpected refresh error", refreshCatch);
      }
    }

    if (user) {
      currentUser = user;
      try {
        updateUserProfileUI(user);
      } catch (e) {
        console.warn("ensureUser: failed to update profile UI", e);
      }
    }
    return user;
  } catch (e) {
    console.error("ensureUser: unexpected error", e);
    return null;
  }
}

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
  newUrl.searchParams.set("board", boardId);
  if (ownerId) newUrl.searchParams.set("owner", ownerId);
  window.history.pushState({}, "", newUrl);

  const allItems = document.querySelectorAll(".sidebar-board-item");
  allItems.forEach((item) => {
    if (item.dataset.id === boardId) item.classList.add("active");
    else item.classList.remove("active");
  });

  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("bibleboard:load", {
        detail: { boardId, ownerId },
      })
    );
  }, 10);

  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  if (
    sidebar &&
    sidebar.classList.contains("expanded") &&
    window.innerWidth < 900
  ) {
    sidebar.classList.remove("expanded");
    sidebar.classList.add("offscreen");
    if (overlay) overlay.classList.add("hidden");
  }
}

// --- Scroll Fade Logic ---
const navbar = document.getElementById("nav-bar");
window.addEventListener("scroll", () => {
  if (!navbar) return;
  const scrollTop =
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0;
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
    activeDropdown.classList.remove("show");
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

window.closeModal = function () {
  const backdrop = document.getElementById("modal-backdrop");
  if (backdrop) backdrop.classList.add("hidden");
  currentModalBoard = null;
};

// --- RENAME LOGIC ---

// Generic helper that actually updates the JSON in storage
async function renameBoard(board, newTitle) {
  if (!board || !newTitle) return;

  const { id, path } = board;

  // Download current JSON
  const { data: blob, error: downloadError } = await sb.storage
    .from(BUCKET)
    .download(path);
  if (downloadError) throw downloadError;

  const text = await blob.text();
  const json = JSON.parse(text);

  json.title = newTitle;
  json.updatedAt = new Date().toISOString();

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

  // Re-render sidebar with new title
  await loadBoards();

  // If this board is currently open in the viewer, update the title textbox
  const params = new URLSearchParams(window.location.search);
  if (params.get("board") === id) {
    const titleBox = document.getElementById("title-textbox");
    if (titleBox) titleBox.value = newTitle;
  }
}

// --- Shared rename helper used by modal + inline rename ---
async function renameBoardOnStorage(board, newTitle) {
  if (!board || !newTitle) return;

  const { id, path } = board;

  const { data: blob, error: downloadError } = await sb.storage
    .from(BUCKET)
    .download(path);
  if (downloadError) throw downloadError;

  const text = await blob.text();
  const json = JSON.parse(text);

  json.title = newTitle;
  json.updatedAt = new Date().toISOString();

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

  // Re-render sidebar
  await loadBoards();

  // If this board is open in the main viewer, update that title too
  const params = new URLSearchParams(window.location.search);
  if (params.get("board") === id) {
    const titleBox = document.getElementById("title-textbox");
    if (titleBox) titleBox.value = newTitle;
  }
}

// --- Shared helper for renaming a board ---
async function saveBoardTitle(board, newTitle) {
  if (!board || !newTitle) return;

  const { id, path } = board;
  // console.log("[Boards] Saving new title", { id, path, newTitle });

  const { data: blob, error: downloadError } = await sb.storage
    .from(BUCKET)
    .download(path);

  if (downloadError) {
    console.error("[Boards] download error during rename:", downloadError);
    throw downloadError;
  }

  const text = await blob.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (parseErr) {
    console.error("[Boards] JSON parse error during rename:", parseErr);
    throw parseErr;
  }

  json.title = newTitle;
  json.updatedAt = new Date().toISOString();

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

  if (updateError) {
    console.error("[Boards] update error during rename:", updateError);
    throw updateError;
  }

  // console.log("[Boards] Title saved OK for", id);

  // Always reload sidebar from storage so we see the actual saved value
  await loadBoards();

  // If this board is open in the main view, update that title box too
  const params = new URLSearchParams(window.location.search);
  if (params.get("board") === id) {
    const titleBox = document.getElementById("title-textbox");
    if (titleBox) titleBox.value = newTitle;
  }
}

// --- Canonical helper: rename a board in storage + update local UI ---
// Canonical + DEBUGGY helper: rename a board in storage
// and update the in-memory list + sidebar.
async function renameBoardAndUpdateUI(boardId, newTitle) {
  if (!boardId || !newTitle) {
    console.warn("[Boards][rename] missing boardId/newTitle", {
      boardId,
      newTitle,
    });
    return;
  }

  // Find the board in our current in-memory list
  const idx = loadedBoards.findIndex((b) => b.id === boardId);
  if (idx === -1) {
    console.warn(
      "[Boards][rename] board not found in loadedBoards",
      boardId,
      loadedBoards.map((b) => ({ id: b.id, title: b.title }))
    );
    return;
  }

  const board = loadedBoards[idx];
  const path = board.path;

  // console.log("[Boards][rename] START", {
  //   boardId,
  //   path,
  //   oldTitle: board.title,
  //   newTitle,
  // });

  try {
    // 1) Download existing JSON
    const { data: blob, error: downloadError } = await sb.storage
      .from(BUCKET)
      .download(path);

    if (downloadError) {
      console.error(
        "[Boards][rename] download error before rename",
        downloadError
      );
      throw downloadError;
    }

    const text = await blob.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      console.error("[Boards][rename] JSON parse error before rename", {
        parseErr,
        textSnippet: text.slice(0, 200),
      });
      throw parseErr;
    }

    // console.log("[Boards][rename] JSON BEFORE", {
    //   jsonTitle: json.title,
    //   jsonUpdatedAt: json.updatedAt,
    // });

    // 2) Mutate JSON
    const nowIso = new Date().toISOString();
    json.title = newTitle;
    json.updatedAt = nowIso;

    const serialized = JSON.stringify(json, null, 2);
    // console.log("[Boards][rename] JSON AFTER (about to save)", {
    //   jsonTitle: json.title,
    //   length: serialized.length,
    // });

    // 3) Save back to Supabase
    const newBlob = new Blob([serialized], {
      type: "application/json",
    });

    const { error: updateError } = await sb.storage
      .from(BUCKET)
      .update(path, newBlob, {
        contentType: "application/json",
        cacheControl: "0",
        upsert: true,
      });

    if (updateError) {
      console.error("[Boards][rename] UPDATE error", updateError);
      throw updateError;
    }

    // console.log("[Boards][rename] UPDATE OK, verifying from storage…");

    // 4) Immediately re-download to see what’s *actually* stored
    try {
      const { data: verifyBlob, error: verifyError } = await sb.storage
        .from(BUCKET)
        .download(path);

      if (verifyError) {
        console.error("[Boards][rename] VERIFY download error", verifyError);
      } else {
        const verifyText = await verifyBlob.text();
        const verifyJson = JSON.parse(verifyText);
        // console.log("[Boards][rename] VERIFY JSON FROM STORAGE", {
        //   jsonTitle: verifyJson.title,
        //   jsonUpdatedAt: verifyJson.updatedAt,
        // });
      }
    } catch (verifyThrow) {
      console.error("[Boards][rename] VERIFY step threw", verifyThrow);
    }

    // 5) Update in-memory list
    loadedBoards[idx] = {
      ...board,
      title: newTitle,
      updatedAt: nowIso,
    };

    // 5.5) Store a local override so we don't trust stale cached JSON on reload
    boardTitleOverrides[boardId] = {
      title: newTitle,
      updatedAt: nowIso,
      stampedAt: Date.now(),
    };

    saveBoardTitleOverrides();

    // console.log(`[Boards][rename] override stored`, {
    //   boardId,
    //   override: boardTitleOverrides[boardId],
    // });

    // Keep the same sort as loadBoards()
    loadedBoards.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt) -
        new Date(a.updatedAt || a.createdAt)
    );

    // console.log(
    //   "[Boards][rename] loadedBoards AFTER local update",
    //   loadedBoards.map((b) => ({
    //     id: b.id,
    //     title: b.title,
    //     updatedAt: b.updatedAt,
    //   }))
    // );

    // 6) Re-render sidebar from updated in-memory state
    renderSidebarBoards(loadedBoards);

    // 7) If this board is open in the main editor, update textbox too
    const params = new URLSearchParams(window.location.search);
    if (params.get("board") === boardId) {
      const titleBox = document.getElementById("title-textbox");
      if (titleBox) titleBox.value = newTitle;
    }

    // console.log("[Boards][rename] DONE for", boardId);
  } catch (err) {
    console.error("[Boards][rename] FAILED", err);
    throw err;
  }
}

// Existing modal-based rename now just calls renameBoard()
// --- RENAME LOGIC (with debug) ---
async function handleRename() {
  if (!currentModalBoard) {
    console.warn("[Boards][rename] called with no currentModalBoard");
    return;
  }

  const modalTitleInput = document.getElementById("modal-title-input");
  const modalSaveBtn = document.getElementById("modal-save-btn");

  const newTitle = modalTitleInput.value.trim();
  const { id, path, title: oldTitle } = currentModalBoard;

  // console.log("[Boards][rename] start", {
  //   id,
  //   path,
  //   oldTitle,
  //   newTitle,
  // });

  if (!newTitle) {
    console.warn("[Boards][rename] empty newTitle, aborting");
    return;
  }

  if (newTitle === oldTitle) {
    // console.log("[Boards][rename] title unchanged, closing modal");
    window.closeModal();
    return;
  }

  if (modalSaveBtn) {
    modalSaveBtn.textContent = "Saving...";
    modalSaveBtn.disabled = true;
  }

  try {
    // 1️⃣ Download existing JSON
    const { data: blob, error: downloadError } = await sb.storage
      .from(BUCKET)
      .download(path);

    if (downloadError) {
      console.error("[Boards][rename] download error", downloadError);
      throw downloadError;
    }

    const text = await blob.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      console.error("[Boards][rename] JSON parse error", parseErr);
      throw parseErr;
    }

    // console.log("[Boards][rename] JSON before change", {
    //   jsonTitle: json.title,
    //   jsonUpdatedAt: json.updatedAt,
    // });

    // 2️⃣ Mutate JSON
    json.title = newTitle;
    json.updatedAt = new Date().toISOString();

    const serialized = JSON.stringify(json, null, 2);
    // console.log("[Boards][rename] JSON after change (about to save)", {
    //   jsonTitle: json.title,
    //   length: serialized.length,
    // });

    // 3️⃣ Save back to Supabase
    const newBlob = new Blob([serialized], {
      type: "application/json",
    });

    const { error: updateError } = await sb.storage
      .from(BUCKET)
      .update(path, newBlob, {
        contentType: "application/json",
        cacheControl: "0",
        upsert: true,
      });

    if (updateError) {
      console.error("[Boards][rename] update error", updateError);
      throw updateError;
    }

    // console.log(
    //   "[Boards][rename] Supabase update OK, calling loadBoards() next"
    // );

    // 4️⃣ Reload list from server (this is what might be racing)
    await loadBoards();

    // 5️⃣ Immediately re-download the JSON to see what's actually stored
    try {
      const { data: verifyBlob, error: verifyError } = await sb.storage
        .from(BUCKET)
        .download(path);

      if (verifyError) {
        console.error("[Boards][rename] verify download error", verifyError);
      } else {
        const verifyText = await verifyBlob.text();
        const verifyJson = JSON.parse(verifyText);
        // console.log("[Boards][rename] verify JSON after save", {
        //   jsonTitle: verifyJson.title,
        //   jsonUpdatedAt: verifyJson.updatedAt,
        // });
      }
    } catch (verifyErr) {
      console.error("[Boards][rename] verify step threw", verifyErr);
    }

    // 6️⃣ If this board is open, update the main title box
    const params = new URLSearchParams(window.location.search);
    if (params.get("board") === id) {
      const titleBox = document.getElementById("title-textbox");
      if (titleBox) titleBox.value = newTitle;
    }

    window.closeModal();
  } catch (err) {
    console.error("[Boards][rename] FAILED", err);
    alert("Failed to rename board: " + (err.message || err));
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

window.closeDeleteModal = function () {
  if (deleteModalBackdrop) {
    deleteModalBackdrop.classList.add("hidden");
    setTimeout(() => {
      deleteModalBackdrop.style.display = "none";
    }, 200);
  }
  boardToDelete = null;
};

// Safely delete a board, with a small delay when deleting the currently open one
async function performDelete() {
  if (!boardToDelete) {
    return;
  }

  const idToDelete = boardToDelete.id;
  const pathToDelete = boardToDelete.path;

  const btn = document.getElementById("confirm-delete-btn");
  if (btn) {
    btn.textContent = "Deleting...";
    btn.disabled = true;
  }

  try {
    // 1. Make sure we are actually signed in before deleting
    const user = await ensureUser();

    if (!user) {
      // Don't touch sidebar status here; just throw so we can show an alert.
      throw new Error("NOT_SIGNED_IN");
    }

    // 2. Figure out which board is currently open
    const params = new URLSearchParams(window.location.search);
    const currentBoardIdFromUrl = params.get("board");
    const currentOwnerFromUrl = params.get("owner");

    const activeSidebarItem = document.querySelector(
      ".sidebar-board-item.active"
    );
    const currentBoardIdFromSidebar = activeSidebarItem
      ? activeSidebarItem.dataset.id
      : null;

    const deletingCurrentBoard =
      currentBoardIdFromUrl === idToDelete ||
      currentBoardIdFromSidebar === idToDelete;

    // 3. If we're deleting the current board, SWITCH AWAY FIRST and wait a bit
    if (deletingCurrentBoard) {
      const fallbackBoard =
        loadedBoards.find((b) => b.id !== idToDelete) || null;

      if (fallbackBoard) {
        const ownerId =
          (currentUser && currentUser.id) || currentOwnerFromUrl || user.id;

        // Update URL to point at fallback
        const newUrl = new URL(window.location);
        newUrl.searchParams.set("board", fallbackBoard.id);
        newUrl.searchParams.set("owner", ownerId);
        window.history.replaceState({}, "", newUrl.toString());

        // Tell supabase-sync / viewport to switch context NOW
        if (typeof switchBoard === "function") {
          switchBoard(fallbackBoard.id, ownerId);
        }

        // 🔑 Important: give the board viewer + supabase-sync
        // a tiny moment to fully detach from the board we're deleting
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    // 4. Delete the file in Supabase Storage
    const { data, error } = await sb.storage
      .from(BUCKET)
      .remove([pathToDelete]);

    if (error) {
      throw error;
    }

    // 5. Close the delete modal
    closeDeleteModal();

    // 6. Reload boards from Supabase and let loadBoards() drive sidebar + URL
    await loadBoards();
  } catch (err) {
    if (err?.message === "NOT_SIGNED_IN") {
      alert(
        "Your session has expired. Please sign in again before deleting boards."
      );
    } else {
      alert("Failed to delete board: " + (err?.message || err));
    }
  } finally {
    if (btn) {
      btn.textContent = "Delete";
      btn.disabled = false;
    }
    boardToDelete = null;
  }
}

// ==================== GLOBAL CONTEXT MENU ====================

const contextMenuEl = document.createElement("div");
contextMenuEl.id = "board-context-menu";
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

document.getElementById("ctx-rename").addEventListener("click", (e) => {
  e.stopPropagation();

  const targetBoard = currentModalBoard;
  const targetItem = openBoardContextItem;

  closeContextMenu();

  if (targetBoard && targetItem) {
    startInlineRename(targetBoard, targetItem);
  } else if (targetBoard) {
    // Fallback: open modal
    openModal(targetBoard);
  }
});

document.getElementById("ctx-delete").addEventListener("click", (e) => {
  e.stopPropagation();
  closeContextMenu();
  if (currentModalBoard) openDeleteModal(currentModalBoard);
});

function closeContextMenu() {
  contextMenuEl.classList.remove("show");

  // Clear highlight + 3-dot state on the last item
  if (openBoardContextItem) {
    openBoardContextItem.classList.remove("context-open");
    const prevBtn = openBoardContextItem.querySelector(".sidebar-menu-btn");
    if (prevBtn) prevBtn.classList.remove("active");
    openBoardContextItem = null;
  }
}
window.closeContextMenu = closeContextMenu;

function startInlineRename(board, itemEl) {
  if (!itemEl || !board) return;

  const mainBtn = itemEl.querySelector(".sidebar-board-btn");
  const menuBtn = itemEl.querySelector(".sidebar-menu-btn");
  if (!mainBtn) {
    // Fallback: if something is weird, use the modal
    openModal(board);
    return;
  }

  // Avoid multiple rename inputs on the same item
  if (itemEl.querySelector(".sidebar-board-rename-input")) return;

  const originalTitle = board.title || "Untitled";

  const input = document.createElement("input");
  input.type = "text";
  input.value = originalTitle;
  input.className = "sidebar-board-rename-input";

  mainBtn.replaceWith(input);

  // Hide the 3-dot menu while editing
  if (menuBtn) {
    menuBtn.dataset.prevVisibility = menuBtn.style.visibility || "";
    menuBtn.style.visibility = "hidden";
  }

  let finished = false;

  const cleanupDomOnly = () => {
    // Just re-render from loadedBoards so DOM matches our state
    renderSidebarBoards(loadedBoards);
  };

  const finish = async (commit) => {
    if (finished) return;
    finished = true;

    input.removeEventListener("blur", onBlur);
    input.removeEventListener("keydown", onKeyDown);

    const newTitle = input.value.trim();

    // Cancel / no change
    if (!commit || !newTitle || newTitle === originalTitle) {
      cleanupDomOnly();
      return;
    }

    try {
      await renameBoardAndUpdateUI(board.id, newTitle);
    } catch (err) {
      console.error("Inline rename failed:", err);
      alert("Failed to rename board: " + (err.message || err));
      cleanupDomOnly();
    }
  };

  const onBlur = () => finish(true);
  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };

  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", onKeyDown);

  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function openContextMenu(e, board, itemEl, menuBtn) {
  e.preventDefault();
  e.stopPropagation();
  currentModalBoard = board;

  const container =
    sidebarBoardsContainer ||
    document.getElementById("sidebar-boards-container") ||
    document.body;

  // Move menu into the correct container if needed
  if (contextMenuEl.parentElement !== container) {
    container.appendChild(contextMenuEl);
  }

  // Clear old item highlight / active dots
  if (openBoardContextItem && openBoardContextItem !== itemEl) {
    openBoardContextItem.classList.remove("context-open");
    const prevBtn = openBoardContextItem.querySelector(".sidebar-menu-btn");
    if (prevBtn) prevBtn.classList.remove("active");
  }

  // Track + highlight the current item and its 3-dots
  openBoardContextItem = itemEl;
  if (itemEl) itemEl.classList.add("context-open");
  if (menuBtn) menuBtn.classList.add("active");

  // Temporarily show menu (hidden) so we can measure its size
  contextMenuEl.style.visibility = "hidden";
  contextMenuEl.classList.add("show");

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
  boards.forEach((board) => {
    const group = getDateGroup(board.updatedAt || board.createdAt);
    if (!groups[group]) groups[group] = [];
    groups[group].push(board);
  });

  const order = ["Today", "Yesterday", "Last 7 Days", "Last 30 Days", "Older"];

  order.forEach((group) => {
    if (!groups[group] || groups[group].length === 0) return;

    const label = document.createElement("div");
    label.className = "sidebar-group-label";
    label.textContent = group;
    container.appendChild(label);

    groups[group].forEach((board) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "sidebar-board-item";
      itemDiv.dataset.id = board.id;

      const currentParams = new URLSearchParams(window.location.search);
      if (currentParams.get("board") === board.id) {
        itemDiv.classList.add("active");
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

    const parsedBoard = {
      id: json.id || file.name.replace(".json", ""),
      title: json.title || "Untitled Board",
      description: json.description || previewSnippet || "",
      elements: items,
      createdAt: json.createdAt || file.created_at || null,
      updatedAt: json.updatedAt || file.updated_at || file.created_at || null,
      path,
    };

    // 🔄 Apply local title override if present
    const override = boardTitleOverrides[parsedBoard.id];

    if (override && override.title && override.title !== parsedBoard.title) {
      // console.log("[Boards][fetchBoardDetails] applying override", {
      //   id: parsedBoard.id,
      //   jsonTitle: parsedBoard.title,
      //   overrideTitle: override.title,
      //   jsonUpdatedAt: parsedBoard.updatedAt,
      //   overrideUpdatedAt: override.updatedAt,
      // });

      parsedBoard.title = override.title;
      // Optionally, also prefer override.updatedAt for sorting:
      if (override.updatedAt) {
        parsedBoard.updatedAt = override.updatedAt;
      }
    } else if (override && override.title === parsedBoard.title) {
      // JSON finally caught up; we can optionally clean up the override
      // delete boardTitleOverrides[parsedBoard.id];
      // saveBoardTitleOverrides();
    }

    // console.log(`[Boards][fetchBoardDetails]`, {
    //   fileName: file.name,
    //   id: parsedBoard.id,
    //   title: parsedBoard.title,
    //   updatedAt: parsedBoard.updatedAt,
    //   path,
    // });

    return parsedBoard;
  } catch (err) {
    console.error("Failed to fetch details for", file.name, err);
    return null;
  }
}








// function renderNoBoardsGetStarted() {
//    const mainContentContainer = document.getElementById("bible-board-container");
//   if (!mainContentContainer) return;

//   mainContentContainer.innerHTML = `
//     <svg id="connections" class="connections"></svg>
//     <div class="get-started-root">
//       <div class="get-started-card">
//         <h1 class="get-started-header">What would you like to study today?</h1>
//         <p class="get-started-subtext">
//           Start from a pre-made BibleBoard template or create a brand new board.
//         </p>
//         <div class="get-started-options">
//           ${TEMPLATE_BOARDS.map(
//             (tpl) => `
//             <button
//               type="button"
//               class="get-started-option"
//               data-template-id="${tpl.id}"
//             >
//               <div class="get-started-option-label">${tpl.title}</div>
//               <div class="get-started-option-hint">${tpl.subtitle}</div>
//             </button>
//           `
//           ).join("")}
//         </div>
//       </div>
//     </div>
//   `;

//   // For now, just log which template was chosen.
//   // We can wire this up to actually create a board from the template next.
//     // Wire up click handlers for each template option
//   TEMPLATE_BOARDS.forEach((tpl) => {
//     const btn = workspace.querySelector(
//       `.get-started-option[data-template-id="${tpl.id}"]`
//     );
//     if (!btn) return;

//     btn.addEventListener("click", () => {
//       // Create a new board on this user's account from the template
//       handleTemplateBoardClick(tpl);
//     });
//   });
// }

function hideGetStartedHero() {
  const hero = document.querySelector(".get-started-root");
  if (hero) {
    hero.style.display = "none";
  }
}


function renderNoBoardsGetStarted() {
  console.log("[GetStarted] renderNoBoardsGetStarted called");

  // 1. Target the specific container you requested
  const container = document.getElementById("bible-board-container");
  if (!container) {
    console.warn("[GetStarted] #bible-board-container not found");
    return;
  }

  // 2. Check if hero already exists. If so, just show it.
  const existingHero = document.querySelector(".get-started-root");
  if (existingHero) {
    existingHero.style.display = "flex";
    return;
  }

  // 3. Inject CSS Styles
  // We use position: absolute to overlay it on top of the board content
  // We use z-index to ensure it sits above the canvas but below modals
  if (!document.getElementById("get-started-styles")) {
    const style = document.createElement("style");
    style.id = "get-started-styles";
    // style.textContent = `
    //   .get-started-root {
    //     position: absolute;
    //     top: 0;
    //     left: 0;
    //     right: 0;
    //     bottom: 0;
    //     display: flex;
    //     align-items: center;
    //     justify-content: center;
    //     z-index: 50; 
    //     background: var(--bg, #020617); /* Covers the empty lines/grid behind it */
    //   }
    //   .get-started-card {
    //     background: var(--bg-alt, #151515);
    //     border: 1px solid var(--border, #333);
    //     border-radius: 16px;
    //     padding: 40px;
    //     max-width: 500px;
    //     width: 90%;
    //     text-align: center;
    //     box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    //     color: var(--fg, #ffffff);
    //   }
    //   .get-started-header {
    //     font-size: 24px;
    //     font-weight: 700;
    //     margin-bottom: 12px;
    //     color: var(--fg, #ffffff);
    //   }
    //   .get-started-subtext {
    //     font-size: 14px;
    //     color: var(--muted, #888);
    //     margin-bottom: 30px;
    //     line-height: 1.5;
    //   }
    //   .get-started-options {
    //     display: flex;
    //     flex-direction: column;
    //     gap: 12px;
    //     margin-bottom: 24px;
    //   }
    //   .get-started-option {
    //     background: var(--bg-seethrough, rgba(255,255,255,0.05));
    //     border: 1px solid var(--border, #444);
    //     padding: 16px;
    //     border-radius: 12px;
    //     cursor: pointer;
    //     transition: all 0.2s ease;
    //     text-align: left;
    //   }
    //   .get-started-option:hover {
    //     background: var(--bg-hover, rgba(255,255,255,0.1));
    //     border-color: var(--accent, #4ade80);
    //   }
    //   .get-started-option-label {
    //     font-weight: 600;
    //     font-size: 15px;
    //     color: var(--fg, #fff);
    //     margin-bottom: 4px;
    //   }
    //   .get-started-option-hint {
    //     font-size: 12px;
    //     color: var(--muted, #888);
    //   }
    //   .get-started-new-board-btn {
    //     background: transparent;
    //     border: none;
    //     color: var(--muted, #888);
    //     font-size: 13px;
    //     cursor: pointer;
    //     text-decoration: underline;
    //   }
    //   .get-started-new-board-btn:hover {
    //     color: var(--fg, #fff);
    //   }
    // `;
    document.head.appendChild(style);
  }

  // 4. Build the HTML
  const heroHTML = `
    <div class="get-started-root">
      <div class="get-started-card">
        <h1 class="get-started-header">What would you like to study today?</h1>
        <p class="get-started-subtext">
          Start from a pre-made BibleBoard template or create a brand new board.
        </p>

        <div class="get-started-options">
          ${TEMPLATE_BOARDS.map(
            (tpl) => `
              <button
                type="button"
                class="get-started-option"
                data-template-id="${tpl.id}"
              >
                <div class="get-started-option-label">${tpl.title}</div>
                <div class="get-started-option-hint">${tpl.subtitle}</div>
              </button>
            `
          ).join("")}
        </div>

        <div id="get-started-board-or-section">
          <div id="get-started-board-or-text">or</div>
        </div>

        <button
          id="get-started-new-board-btn"
          class="get-started-new-board-btn"
          type="button"
        >
          Start with a blank board
        </button>
      </div>
    </div>
  `;

  // 5. Inject safely using insertAdjacentHTML to avoid destroying siblings
  container.insertAdjacentHTML("beforeend", heroHTML);

  // 6. Wire up events
  const newHero = document.querySelector(".get-started-root");
  
  TEMPLATE_BOARDS.forEach((tpl) => {
    const selector = `.get-started-option[data-template-id="${tpl.id}"]`;
    const btn = newHero.querySelector(selector);
    if (btn) {
      btn.addEventListener("click", () => {
        handleTemplateBoardClick(tpl);
      });
    }
  });

  const blankBtn = newHero.querySelector("#get-started-new-board-btn");
  if (blankBtn) {
    blankBtn.addEventListener("click", () => {
      handleNewBoard();
    });
  }
}


function clearGetStartedHero() {
  const hero = document.querySelector(".get-started-root");
  if (hero && hero.parentElement) {
    console.log("[GetStarted] clearing hero");
    hero.parentElement.removeChild(hero);
  }
}













// --- Load all boards for the current user ---


async function loadBoards() {
  try {
    boardsLoaded = false;
    if (typeof updateBoardCreateButtonState === "function") {
      updateBoardCreateButtonState();
    }

    // Try to use the cached user first
    let user = currentUser;

    // If we don't have one yet (or something cleared it),
    // ask Supabase for the current session.
    if (!user && typeof ensureUser === "function") {
      user = await ensureUser();
    }

    if (!user) {
      // Truly not signed in
      renderStatus("Not signed in.");
      loadedBoards = [];
      renderSidebarBoards([]);
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }
      return;
    }

    // Now we *know* we have a user, safe to show loading
    // renderStatus("Loading boards…");

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

    // if (!boardFiles || boardFiles.length === 0) {
    //   // console.log(
    //   //   "[Boards] No board files found; auto-creating first board..."
    //   // );
    //   loadedBoards = [];
    //   renderSidebarBoards([]);
    //   boardsLoaded = true;
    //   if (typeof updateBoardCreateButtonState === "function") {
    //     updateBoardCreateButtonState();
    //   }

    //   // Auto-create a first board for this user.
    //   // handleNewBoard(true) skips the “plan not ready yet” block,
    //   // but still respects FREE_BOARD_LIMIT / PRO rules.
    //   await handleNewBoard(true);
    //   return;
    // }

    const boardFiles = Array.isArray(files)
      ? files.filter((f) => f.name.endsWith(".json"))
      : [];

    // ... inside loadBoards empty check ...
    if (!boardFiles || boardFiles.length === 0) {
      loadedBoards = [];
      renderSidebarBoards([]);
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }

      // Clear URL params
      const newUrl = new URL(window.location);
      newUrl.searchParams.delete("board");
      newUrl.searchParams.delete("owner");
      window.history.replaceState({}, "", newUrl);

      // Render the hero
      renderNoBoardsGetStarted();
      renderStatus('No boards yet. Get started creating.');
      return;
    }


    // Download and parse all boards
    const boardResults = await Promise.all(
      boardFiles.map((file) => fetchBoardDetails(user, file))
    );

    // if (boards.length === 0) {
    //   // Files existed but none parsed correctly – treat as "no boards"
    //   console.warn(
    //     "[Boards] Board files found but none parsed; auto-creating new board."
    //   );
    //   loadedBoards = [];
    //   renderSidebarBoards([]);
    //   boardsLoaded = true;
    //   if (typeof updateBoardCreateButtonState === "function") {
    //     updateBoardCreateButtonState();
    //   }

    //   await handleNewBoard(true);
    //   return;
    // }

    const boards = boardResults.filter(Boolean);

    if (boards.length === 0) {
      // Files existed but none parsed correctly – treat as "no boards"
      console.warn(
        "[Boards] Board files found but none parsed; treating as empty state."
      );
      loadedBoards = [];
      renderSidebarBoards([]);
      boardsLoaded = true;
      if (typeof updateBoardCreateButtonState === "function") {
        updateBoardCreateButtonState();
      }

      const newUrl = new URL(window.location);
      newUrl.searchParams.delete("board");
      newUrl.searchParams.delete("owner");
      window.history.replaceState({}, "", newUrl);

      const workspace = document.getElementById("workspace");
      if (workspace) {
        workspace.innerHTML =
          '<svg id="connections" class="connections"></svg>';
      }

      renderNoBoardsGetStarted();
      renderStatus('No boards yet. Get started creating.');
      return;
    }

    // Sort boards by most recently updated/created
    const sorted = boards.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt) -
        new Date(a.updatedAt || a.createdAt)
    );


    // console.log(
    //   "[Boards][loadBoards] SORTED from storage:",
    //   sorted.map((b) => ({
    //     id: b.id,
    //     title: b.title,
    //     updatedAt: b.updatedAt,
    //     path: b.path,
    //   }))
    // );

    // ✅ We now have at least one board – hide the get-started overlay
    hideGetStartedHero();

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
      const exists = sorted.some((b) => b.id === targetBoardId);

      if (exists) {
        switchBoard(targetBoardId, owner);
      } else if (sorted.length > 0) {
        // Deleted or invalid board id in URL – fall back to first board
        const fallback = sorted[0];
        const newUrl = new URL(window.location);
        newUrl.searchParams.set("board", fallback.id);
        newUrl.searchParams.set("owner", owner);
        window.history.replaceState({}, "", newUrl);
        switchBoard(fallback.id, owner);
      } else {
        // No boards left at all – clear params and workspace
        const newUrl = new URL(window.location);
        newUrl.searchParams.delete("board");
        newUrl.searchParams.delete("owner");
        window.history.replaceState({}, "", newUrl);

        const workspace = document.getElementById("workspace");
        if (workspace) {
          workspace.innerHTML =
            '<svg id="connections" class="connections"></svg>';
        }
        renderStatus("No boards yet. Get started creating.");
      }
    } else if (sorted.length > 0) {
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









async function loadTemplateBoardData(templateFile) {
  const url = `../assets/template_boards/${templateFile}`;
  console.log("[GetStarted] loadTemplateBoardData: fetching", url);

  try {
    const res = await fetch(url, { cache: "no-cache" });
    console.log(
      "[GetStarted] loadTemplateBoardData: response status",
      res.status
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    console.log(
      "[GetStarted] loadTemplateBoardData: template loaded. elements:",
      Array.isArray(json.elements) ? json.elements.length : "n/a",
      "connections:",
      Array.isArray(json.connections) ? json.connections.length : "n/a"
    );
    return json;
  } catch (err) {
    console.error("[GetStarted] Failed to load template", templateFile, err);
    showToast("Couldn't load that template. Please try again.", {
      variant: "error",
    });
    throw err;
  }
}







// Create a new board file in Supabase using a template JSON
async function createBoardFileFromTemplate(boardId, templateJson, explicitTitle) {
  console.log("[Templates] createBoardFileFromTemplate", boardId);

  let originalContent = "";
  if (newBoardBtn) {
    originalContent = newBoardBtn.innerHTML;
    newBoardBtn.disabled = true;
    const label = document.getElementById("new-board-btn-sidebar-text");
    if (label) label.textContent = "Creating...";
  }

  try {
    if (!currentUser || !currentUser.id) {
      throw new Error("No current user for template board creation");
    }

    const path = `${currentUser.id}/boards/${boardId}.json`;
    const now = new Date().toISOString();

    // Mapping 'elements' -> 'items' for the viewer
    const sourceItems = Array.isArray(templateJson.items)
      ? templateJson.items
      : Array.isArray(templateJson.elements)
      ? templateJson.elements
      : [];

    const connections = Array.isArray(templateJson.connections)
      ? templateJson.connections
      : [];

    const boardJson = {
      ...templateJson,
      id: boardId,
      title: explicitTitle || templateJson.title || "Untitled Board",
      description: templateJson.description || "",
      createdAt: now,
      updatedAt: now,
      background: templateJson.background || { type: "solid", color: "#020617" },
      items: sourceItems, // Viewer needs this
      elements: sourceItems, // Backup
      connections,
    };

    const blob = new Blob([JSON.stringify(boardJson, null, 2)], {
      type: "application/json",
    });

    const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
      contentType: "application/json",
      cacheControl: "0",
      upsert: true,
    });

    if (error) throw error;

    // Update URL and reload
    const newUrl = new URL(window.location);
    newUrl.searchParams.set("board", boardId);
    newUrl.searchParams.set("owner", currentUser.id);
    window.history.replaceState({}, "", newUrl.toString());

    await loadBoards(); // This will trigger hideGetStartedHero()
    
    return true;
  } catch (err) {
    console.error("Template creation failed:", err);
    showToast("Failed to create board.", { variant: "error" });
  } finally {
    if (newBoardBtn) {
      newBoardBtn.disabled = false;
      if (originalContent) newBoardBtn.innerHTML = originalContent;
    }
  }
}





async function handleTemplateBoardClick(tpl) {
  console.log("[Templates] handleTemplateBoardClick", tpl);

  if (isCreatingBoard) return;
  isCreatingBoard = true;
  updateBoardCreateButtonState?.();

  try {
    // Ensure user exists (you already have this logic somewhere)
    let user = currentUser;
    if (!user && typeof ensureUser === "function") {
      user = await ensureUser();
      if (user) currentUser = user;
    }
    if (!user) {
      alert("Please sign in first.");
      return;
    }

    // Respect free vs pro board limit
    const isPro = !!window.BIBLEBOARD_IS_PRO;
    const currentCount = loadedBoards.length;
    if (!isPro && currentCount >= FREE_BOARD_LIMIT) {
      openUpgradeModal?.();
      return;
    }

    // 👉 Load template JSON and create board from it
    const templateJson = await loadTemplateBoardData(tpl.templateFile);
    const newId = crypto.randomUUID();
    await createBoardFileFromTemplate(newId, templateJson, tpl.title);
  } finally {
    isCreatingBoard = false;
    updateBoardCreateButtonState?.();
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
    document.getElementById("new-board-btn-sidebar-text").textContent =
      "Creating...";
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

    // 👉 Tell the app which board we WANT to be active
    const newUrl = new URL(window.location);
    newUrl.searchParams.set("board", boardId);
    newUrl.searchParams.set("owner", currentUser.id);
    window.history.replaceState({}, "", newUrl.toString());

    // 👉 Reload boards; loadBoards() sees the URL param and:
    //    - finds the new board
    //    - calls switchBoard(boardId, owner)
    //    - dispatches bibleboard:load so the viewport updates
    await loadBoards();

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

window.closeUpgradeModal = function () {
  if (upgradeModalBackdrop) {
    upgradeModalBackdrop.classList.add("hidden");
    setTimeout(() => {
      upgradeModalBackdrop.style.display = "none";
    }, 200);
  }
};

async function handleUpgrade() {
  // Close the nice modal first
  closeUpgradeModal();

  try {
    // Only using monthly right now, so hard-code monthly
    await SubscriptionService.subscribe("monthly");

    // ✅ Show success toast once payment completes
    showToast(
      "You’re all set! BibleBoard Pro is now active on your account 🙌",
      {
        variant: "success",
      }
    );
  } catch (err) {
    console.error("Error starting subscription:", err);

    // Optional error toast
    showToast(
      "Something went wrong starting your subscription. Please try again.",
      {
        variant: "error",
      }
    );
  }
}

// ==================== USER PROFILE LOGIC (ChatGPT Style) ====================

function updateUserProfileUI(user) {
  if (!user) return;

  const nameEl = document.getElementById("user-profile-name");
  const emailEl = document.getElementById("user-profile-email");
  const avatarEl = document.getElementById("user-avatar-img");

  // Extract data safely
  const email = user.email || "";
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || email.split("@")[0] || "User";
  const avatar = meta.avatar_url || meta.picture || "../assets/logo_no_bg.png";

  if (nameEl) nameEl.textContent = name;
  if (emailEl) emailEl.textContent = email;
  if (avatarEl) avatarEl.src = avatar;
}

function setupProfileMenu() {
  const triggerBtn = document.getElementById("user-profile-btn");
  const menu = document.getElementById("user-profile-menu");

  if (!triggerBtn || !menu) return;

  triggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = !menu.classList.contains("show");

    if (typeof closeContextMenu === "function") closeContextMenu();

    if (isHidden) {
      menu.classList.remove("hidden");
      requestAnimationFrame(() => {
        menu.classList.add("show");
        triggerBtn.classList.add("active");
      });
    } else {
      closeProfileMenu();
    }
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && !triggerBtn.contains(e.target)) {
      closeProfileMenu();
    }
  });
}

function closeProfileMenu() {
  const menu = document.getElementById("user-profile-menu");
  const triggerBtn = document.getElementById("user-profile-btn");
  if (menu) {
    menu.classList.remove("show");
    triggerBtn?.classList.remove("active");
    setTimeout(() => menu.classList.add("hidden"), 150);
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

    await loadBoards(); // 👈 important: wait for boardsLoaded

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

window.closeSearchModal = function () {
  if (searchBackdrop) {
    searchBackdrop.classList.add("hidden");
    setTimeout(() => {
      searchBackdrop.style.display = "none";
    }, 200);
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

  if (
    boardDate.getDate() === now.getDate() &&
    boardDate.getMonth() === now.getMonth() &&
    boardDate.getFullYear() === now.getFullYear()
  ) {
    return "Today";
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    boardDate.getDate() === yesterday.getDate() &&
    boardDate.getMonth() === yesterday.getMonth() &&
    boardDate.getFullYear() === yesterday.getFullYear()
  ) {
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

  const matches = loadedBoards
    .map((board) => {
      let snippetText = "";
      if (board.title.toLowerCase().includes(term)) {
        snippetText = "Matches title";
      } else if (board.elements && board.elements.length > 0) {
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
    })
    .filter(Boolean);

  const groupedMatches = { Today: [], Yesterday: [], Older: [] };

  matches.forEach((match) => {
    const group = getBoardGroup(match.board);
    if (groupedMatches[group]) groupedMatches[group].push(match);
    else groupedMatches["Older"].push(match);
  });

  Object.keys(groupedMatches).forEach((groupName) => {
    groupedMatches[groupName].sort((a, b) => {
      const dateA = new Date(a.board.updatedAt || 0);
      const dateB = new Date(b.board.updatedAt || 0);
      return dateB - dateA;
    });
  });

  let hasResults = false;
  ["Today", "Yesterday", "Older"].forEach((groupName) => {
    if (groupedMatches[groupName].length > 0) {
      hasResults = true;
      const groupHeader = document.createElement("div");
      groupHeader.className = "search-results-group-header";
      groupHeader.textContent = groupName;
      searchResults.appendChild(groupHeader);

      groupedMatches[groupName].forEach((match) => {
        const div = document.createElement("div");
        div.className = "search-result-item";
        div.onclick = () => {
          const ownerId = currentUser
            ? currentUser.id
            : match.board.path.split("/")[0];
          switchBoard(match.board.id, ownerId);
          closeSearchModal();
        };

        div.innerHTML = `
          <span class="material-symbols-outlined" style="font-weight:900;color:var(--muted);">chat_bubble</span>
          <span class="search-result-title">${highlightText(
            match.board.title,
            term
          )}</span>
          ${
            match.snippetText && match.snippetText !== "Matches title"
              ? `<span class="search-result-snippet">${highlightText(
                  match.snippetText,
                  term
                )}</span>`
              : ""
          }
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
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${safeTerm})`, "gi");
  return text.replace(regex, `<span class="highlight-match">$1</span>`);
}


async function hardSignOutAndRedirect() {
  console.log("[Boards] Starting HARD sign out");

  // 1) Try normal Supabase signOut
  try {
    const { error } = await sb.auth.signOut();
    if (error) {
      console.error("[Boards] sb.auth.signOut() error:", error);
    } else {
      console.log("[Boards] sb.auth.signOut() completed");
    }
  } catch (err) {
    console.error("[Boards] sb.auth.signOut() threw:", err);
  }

  // 2) Nuclear option: clear storage
  try {
    if (typeof window !== "undefined") {
      if (window.localStorage) {
        console.log("[Boards] Clearing localStorage");
        window.localStorage.clear();
      }
      if (window.sessionStorage) {
        console.log("[Boards] Clearing sessionStorage");
        window.sessionStorage.clear();
      }
    }
  } catch (err) {
    console.warn("[Boards] Failed clearing storage:", err);
  }

  // 3) Extra safety: clear cookies (anything JWT-ish on this domain)
  try {
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(
          /=.*/,
          "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/"
        );
    });
    console.log("[Boards] Cleared cookies");
  } catch (err) {
    console.warn("[Boards] Failed clearing cookies:", err);
  }

  // 4) Optional sanity check: see if Supabase still thinks we have a user
  try {
    const { data, error } = await sb.auth.getUser();
    console.log("[Boards] Post-hard-signout getUser:", { data, error });
  } catch (err) {
    console.warn("[Boards] getUser after hard signout threw (non-fatal):", err);
  }

  // 5) Finally, go to the landing page
  console.log("[Boards] Redirecting to landing page after HARD signout");
  window.location.href = "/";
}





// ==================== APP INIT ====================

async function init() {
  // 1. Close menus on outside click
  document.addEventListener("click", (e) => {
    if (contextMenuEl && contextMenuEl.contains(e.target)) return;
    closeContextMenu();
  });

  // 2. Setup Auth
  sb.auth.onAuthStateChange((_event, data) =>
    handleAuthChange(data?.session?.user)
  );
  const { data } = await sb.auth.getSession();
  handleAuthChange(data?.session?.user, true);

  // 3. Setup Profile Menu
  setupProfileMenu();

  // 4. Wire up Profile Menu Actions
  const manageBtn = document.getElementById("manage-sub-btn");
  if (manageBtn) {
    manageBtn.onclick = async (e) => {
      e.preventDefault();
      closeProfileMenu();

      let pro = false;
      try {
        // Use your existing async Pro check
        pro = await isProUser();
      } catch (err) {
        console.error("[Boards] Error checking Pro status before manage:", err);
        // If something goes wrong, treat as not Pro
        pro = false;
      }

      // If they are NOT Pro → open the upgrade modal instead of manage portal
      if (!pro) {
        if (typeof window.openUpgradeModal === "function") {
          window.openUpgradeModal("manage-no-active-sub");
        } else {
          // Fallback if for some reason modal isn't wired
          alert(
            "It looks like you don’t have an active subscription yet. " +
              "You can upgrade to unlock BibleBoard Pro features."
          );
        }
        return;
      }

      // If they ARE Pro → send them to the manage portal
      if (
        typeof SubscriptionService !== "undefined" &&
        typeof SubscriptionService.manage === "function"
      ) {
        try {
          await SubscriptionService.manage();
        } catch (err) {
          console.error(
            "[Boards] Error opening manage subscription portal:",
            err
          );
        }
      } else {
        console.warn("[Boards] SubscriptionService.manage is not available.");
      }
    };
  }

  const signoutBtn = document.getElementById("signout-btn-sidebar");
  if (signoutBtn) {
    signoutBtn.onclick = async (e) => {
      e.preventDefault();
      console.log("[Boards] Signout button clicked");

      try {
        closeProfileMenu();
      } catch (err) {
        console.warn("[Boards] closeProfileMenu failed (non-fatal):", err);
      }

      // Try your subscription logout first (if it exists),
      // but don't let it block the hard signout.
      try {
        if (typeof SubscriptionService?.logout === "function") {
          console.log("[Boards] Calling SubscriptionService.logout()");
          await SubscriptionService.logout();
        } else {
          console.warn(
            "[Boards] SubscriptionService.logout missing; skipping."
          );
        }
      } catch (err) {
        console.error("[Boards] SubscriptionService.logout threw:", err);
      }

      // Now do the nuclear Supabase + storage + cookie clear + redirect
      await hardSignOutAndRedirect();
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
// 1. Ensure Global Queues Exist
window.pendingVerseAdds = window.pendingVerseAdds || new Map();
window.pendingSongAdds = window.pendingSongAdds || new Map();

// Wrap interlinear queue so only *confirmed* items are visible to the rest of the app
if (
  !window.pendingInterlinearAdds ||
  !window.pendingInterlinearAdds.__isVerseStudyQueueWrapper
) {
  const internal = new Map();

  window.pendingInterlinearAdds = {
    __isVerseStudyQueueWrapper: true,
    _internal: internal,

    has(key) {
      return internal.has(key);
    },

    set(key, value) {
      internal.set(key, value);
    },

    delete(key) {
      internal.delete(key);
    },

    clear() {
      internal.clear();
    },

    // Kept for API compatibility – no-op for now
    confirmAll() {},

    // Kept for API compatibility – no-op for now
    clearUnconfirmed() {},

    get size() {
      return internal.size;
    },

    values() {
      return internal.values();
    },
  };
}

window.verseStudySelectionCount = window.verseStudySelectionCount || 0;

function updateVerseStudyHeaderButtons() {
  const addBtn = document.getElementById("verse-study-add-btn");
  const clearBtn = document.getElementById("verse-study-clear-btn");
  if (!addBtn && !clearBtn) return;

  const count = window.verseStudySelectionCount || 0;

  if (count > 0) {
    if (addBtn) addBtn.style.display = "inline-flex";
    if (clearBtn) clearBtn.style.display = "inline-flex";
  } else {
    if (addBtn) addBtn.style.display = "none";
    if (clearBtn) clearBtn.style.display = "none";
  }
}

// 2. Unified Verse Toggle (Fixes the split-brain issue)
// This replaces the old 'toggleVerseSelection' that used verseSelectionQueue
function toggleVerseSelection(verseData, btnElement) {
  // Create a unique key including version to prevent collisions
  const key = `${verseData.reference}::${verseData.version}`;

  // Verse row can be a search result OR a reader verse
  const row = btnElement
    ? btnElement.closest(".search-query-verse-container, .verse")
    : null;

  if (window.pendingVerseAdds.has(key)) {
    // REMOVE
    window.pendingVerseAdds.delete(key);
    if (btnElement) btnElement.classList.remove("selected");
    if (row) row.classList.remove("selected-for-add");
  } else {
    // ADD
    window.pendingVerseAdds.set(key, verseData);
    if (btnElement) btnElement.classList.add("selected");
    if (row) row.classList.add("selected-for-add");
  }

  // Update floating button label
  updateFloatingAddButton();

  // Update rounded corners for first/last selected verse in the reader
  updateSelectedVerseRadii();
}

function clearVerseStudySelections() {
  // Deselect interlinear items
  if (window.pendingInterlinearAdds) {
    window.pendingInterlinearAdds.clear();
  }
  // Deselect crossref items
  if (window.pendingCrossRefAdds) {
    window.pendingCrossRefAdds.clear();
  }

  document.querySelectorAll(".selected-for-add").forEach((el) => {
    el.classList.remove("selected-for-add");
  });
  document.querySelectorAll(".selected").forEach((el) => {
    el.classList.remove("selected");
  });
}
window.clearVerseStudySelections = clearVerseStudySelections;

// Apply .selected-first / .selected-last for verses in the Bible Reader,
// handling multiple separate runs of selected verses (e.g., 1–3 and 6–10).
function updateSelectedVerseRadii() {
  const readerContent = document.getElementById("bible-query-reader-content");
  if (!readerContent) return;

  const containers = readerContent.querySelectorAll(".verse-list-container");

  containers.forEach((container) => {
    const verses = Array.from(container.querySelectorAll(".verse"));

    // Clear previous markings
    verses.forEach((v) => {
      v.classList.remove("selected-first", "selected-last", "selected-single");
    });

    let runStartIndex = null; // index of first verse in current run

    for (let i = 0; i < verses.length; i++) {
      const v = verses[i];
      const isSelected = v.classList.contains("selected-for-add");

      if (isSelected) {
        // Start a new run if we weren't in one
        if (runStartIndex === null) {
          runStartIndex = i;
        }
      } else {
        // We hit the end of a run
        if (runStartIndex !== null) {
          const startEl = verses[runStartIndex];
          const endEl = verses[i - 1];

          if (startEl === endEl) {
            // Single verse run
            startEl.classList.add(
              "selected-single",
              "selected-first",
              "selected-last"
            );
          } else {
            // Multi-verse run
            startEl.classList.add("selected-first");
            endEl.classList.add("selected-last");
          }

          runStartIndex = null;
        }
      }
    }

    // Flush a run that reaches the end of the list
    if (runStartIndex !== null) {
      const startEl = verses[runStartIndex];
      const endEl = verses[verses.length - 1];

      if (startEl === endEl) {
        startEl.classList.add(
          "selected-single",
          "selected-first",
          "selected-last"
        );
      } else {
        startEl.classList.add("selected-first");
        endEl.classList.add("selected-last");
      }
    }
  });
}

// 3. Unified "Add to Board" Button Update
// Counts items from ALL three maps (Verses + Songs + Interlinear)
function updateFloatingAddButton() {
  const btn = document.getElementById("bible-reader-add-to-board-btn");
  if (!btn) return;

  const totalCount =
    (window.pendingVerseAdds?.size || 0) +
    (window.pendingInterlinearAdds?.size || 0) +
    (window.pendingCrossRefAdds?.size || 0);

  if (totalCount > 0) {
    btn.style.display = "flex";
    btn.innerHTML = `
      <span class="floating-add-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
             viewBox="0 0 24 24" fill="currentColor"
             class="icon icon-tabler icons-tabler-filled icon-tabler-square-rounded-plus">
          <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
          <path d="M12 2l.324 .001l.318 .004l.616 .017l.299 .013l.579 .034l.553 .046c4.785 .464 6.732 2.411 7.196 7.196l.046 .553l.034 .579c.005 .098 .01 .198 .013 .299l.017 .616l.005 .642l-.005 .642l-.017 .616l-.013 .299l-.034 .579l-.046 .553c-.464 4.785 -2.411 6.732 -7.196 7.196l-.553 .046l-.579 .034c-.098 .005 -.198 .01 -.299 .013l-.616 .017l-.642 .005l-.642 -.005l-.616 -.017l-.299 -.013l-.579 -.034l-.553 -.046c-4.785 -.464 -6.732 -2.411 -7.196 -7.196l-.046 -.553l-.034 -.579a28.058 28.058 0 0 1 -.013 -.299l-.017 -.616c-.003 -.21 -.005 -.424 -.005 -.642l.001 -.324l.004 -.318l.017 -.616l.013 -.299l.034 -.579l.046 -.553c.464 -4.785 2.411 -6.732 7.196 -7.196l.553 -.046l.579 -.034c.098 -.005 .198 -.01 .299 -.013l.616 -.017c.21 -.003 .424 -.005 .642 -.005zm0 6a1 1 0 0 0 -1 1v2h-2l-.117 .007a1 1 0 0 0 .117 1.993h2v2l.007 .117a1 1 0 0 0 1.993 -.117v-2h2l.117 -.007a1 1 0 0 0 -.117 -1.993h-2v-2l-.007 -.117a1 1 0 0 0 -.993 -.883z"
                fill="currentColor" stroke-width="0"></path>
        </svg>
      </span>
      <span class="floating-add-label">
        Add ${totalCount} item${totalCount > 1 ? "s" : ""}
      </span>
    `;
  } else {
    btn.style.display = "none";
  }
}

// 🔐 Export to the global window so non-module scripts use THIS version
window.updateFloatingAddButton = updateFloatingAddButton;

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

/**
 * Parse a full Bible reference like "Genesis 1:3" or "1 Peter 2:10-12"
 * into an object { book, chapter, verse }.
 *
 * - book: full book name portion (may include leading number, e.g. "1 Peter")
 * - chapter: number before the colon
 * - verse: starting verse number (if a range is given, we take the first)
 */
function parseFullRef(ref) {
  if (!ref || typeof ref !== "string") {
    return { book: "", chapter: 0, verse: 0 };
  }

  const clean = ref.trim();
  const colonIndex = clean.lastIndexOf(":");
  if (colonIndex === -1) {
    // No chapter/verse part, treat whole thing as book
    return { book: clean, chapter: 0, verse: 0 };
  }

  // "Genesis 1" / "1 Peter 2"
  const before = clean.slice(0, colonIndex).trim();
  // "3" or "3-5" or "3–5"
  const after = clean.slice(colonIndex + 1).trim();

  // If a range is present ("3-5" / "3–5"), use the starting verse
  const verseStr = after.split(/[-–]/)[0].trim();

  // ["Genesis","1"] or ["1","Peter","2"]
  const parts = before.split(/\s+/);
  const chapStr = parts.pop(); // "1" or "2"
  const book = parts.join(" "); // "Genesis" or "1 Peter"

  const chapter = parseInt(chapStr, 10) || 0;
  const verse = parseInt(verseStr, 10) || 0;

  return { book, chapter, verse };
}

// Keeps track of which verse the modal is currently showing
window.currentVerseStudyData = null;

function openVerseStudyModal(verseData) {
  const backdrop = document.getElementById("verse-study-modal-backdrop");
  if (!backdrop || !verseData) return;

  // Store data globally for tab switching
  window.currentVerseStudyData = verseData;

  // Reset header button state (Add/Clear buttons)
  if (typeof window !== "undefined") {
    window.verseStudySelectionCount = 0;
  }
  if (typeof updateVerseStudyHeaderButtons === "function") {
    updateVerseStudyHeaderButtons();
  }

  // 1. Populate Header Text
  const refEl = document.getElementById("verse-study-ref");
  const versionEl = document.getElementById("verse-study-version");
  const previewEl = document.getElementById("verse-study-preview");

  if (refEl) refEl.textContent = verseData.reference || "";
  if (versionEl) versionEl.textContent = verseData.version || "";

  if (previewEl) {
    const rawText = (verseData.text || "").trim();
    let verseNumber = "";
    let verseBody = rawText;

    const numMatch = rawText.match(/^(\d+)\s+(.*)$/);
    if (numMatch) {
      verseNumber = numMatch[1];
      verseBody = numMatch[2];
    }

    const escapeHtml = (str) =>
      String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    if (verseNumber) {
      previewEl.innerHTML =
        `<span class="verse-study-preview-number">${escapeHtml(
          verseNumber
        )}</span>` +
        `<span class="verse-study-preview-text">${escapeHtml(
          verseBody
        )}</span>`;
    } else {
      previewEl.textContent = verseBody;
    }
  }

  // 2. Set Initial Tab State (Default to Cross References)
  if (typeof window.activateVerseStudyTab === "function") {
    window.activateVerseStudyTab("verse-study-open-crossref", "crossref-section");
  }

  // 3. Load Initial Data (Cross References)
  try {
    if (typeof openCrossRefForReference === "function" && verseData.reference) {
      openCrossRefForReference(verseData.reference);
    }
  } catch (err) {
    console.warn("Failed to preload cross references:", err);
  }

  // 4. Show Modal
  backdrop.style.display = "flex";
  backdrop.setAttribute("data-open", "true");
}


function closeVerseStudyModal() {
  const backdrop = document.getElementById("verse-study-modal-backdrop");
  if (!backdrop) return;

  backdrop.style.display = "none";
  backdrop.removeAttribute("data-open");
  window.currentVerseStudyData = null;

  // Drop any interlinear rows that were selected but never confirmed with the header +
  if (
    window.pendingInterlinearAdds &&
    typeof window.pendingInterlinearAdds.clearUnconfirmed === "function"
  ) {
    window.pendingInterlinearAdds.clearUnconfirmed();
  }

  if (typeof resetVerseStudySections === "function") {
    resetVerseStudySections();
  }
}

window.closeVerseStudyModal = closeVerseStudyModal;

function initVerseStudyModal() {
  const backdrop = document.getElementById("verse-study-modal-backdrop");
  if (!backdrop) return;

  const closeBtn = backdrop.querySelector(".verse-study-close");
  const interBtn = document.getElementById("verse-study-open-interlinear");
  const crossBtn = document.getElementById("verse-study-open-crossref");
  const peopleBtn = document.getElementById("verse-study-open-people");
  const placesBtn = document.getElementById("verse-study-open-places");
  const bookBtn = document.getElementById("verse-study-open-bookinfo");
  
  const headerAddBtn = document.getElementById("verse-study-add-btn");
  const headerClearBtn = document.getElementById("verse-study-clear-btn");

  // --- Close Button ---
  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      closeVerseStudyModal();
    });
  }

  // --- Header Action Buttons (Add/Clear) ---
  if (headerAddBtn) {
    headerAddBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (
        window.pendingInterlinearAdds &&
        typeof window.pendingInterlinearAdds.confirmAll === "function"
      ) {
        window.pendingInterlinearAdds.confirmAll();
      }
      if (typeof updateFloatingAddButton === "function") {
        updateFloatingAddButton();
      }
      closeVerseStudyModal();
    });
  }

  if (headerClearBtn) {
    headerClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Clear queues
      if (window.pendingVerseAdds?.clear) window.pendingVerseAdds.clear();
      if (window.pendingSongAdds?.clear) window.pendingSongAdds.clear();
      if (window.pendingInterlinearAdds?.clear) window.pendingInterlinearAdds.clear();

      // Reset visuals
      document
        .querySelectorAll(".selected-for-add, .search-query-verse-add-button.selected")
        .forEach((el) => {
          el.classList.remove("selected-for-add", "selected");
        });

      window.verseStudySelectionCount = 0;
      if (typeof updateFloatingAddButton === "function") updateFloatingAddButton();
      if (typeof updateVerseStudyHeaderButtons === "function") updateVerseStudyHeaderButtons();
    });
  }

  // --- Tab Navigation ---
  // These now simply call the functions in script.js, which handle 
  // both the data fetching AND the UI switching (via activateVerseStudyTab).

  // 1. Interlinear Tab
  if (interBtn) {
    interBtn.addEventListener("click", () => {
      const data = window.currentVerseStudyData;
      if (data && typeof openVerseStudyInterlinear === "function") {
        openVerseStudyInterlinear(data.reference);
      }
    });
  }

  // 2. Cross References Tab
  if (crossBtn) {
    crossBtn.addEventListener("click", () => {
      const data = window.currentVerseStudyData;
      if (data && typeof openCrossRefForReference === "function") {
        openCrossRefForReference(data.reference);
      }
    });
  }

  // 3. Book Info Tab
  if (bookBtn) {
    bookBtn.addEventListener("click", () => {
      // Use the reference from the current data object
      const data = window.currentVerseStudyData;
      if (data && typeof openVerseStudyBookInfo === "function") {
        openVerseStudyBookInfo(data.reference);
      }
    });
  }

    if (peopleBtn) {
    peopleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const ref = window.currentVerseStudyData?.reference || "";
      if (typeof window.openVerseStudyPeople === "function" && ref) {
        window.openVerseStudyPeople(ref);
      }
    });
  }

  if (placesBtn) {
    placesBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const ref = window.currentVerseStudyData?.reference || "";
      if (typeof window.openVerseStudyPlaces === "function" && ref) {
        window.openVerseStudyPlaces(ref);
      }
    });
  }

  // --- Modal Dismissal ---
  
  // Click outside
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeVerseStudyModal();
    }
  });

  // Escape key
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      backdrop.getAttribute("data-open") === "true"
    ) {
      closeVerseStudyModal();
    }
  });
}

// ======================
// Bible Query UI Helpers
// ======================

document.addEventListener("DOMContentLoaded", () => {
  try {
    initBibleQueryVersionDropdown();
    installBibleQueryGlobalDropdownCloser();
  } catch (err) {
    console.warn("Failed to init Bible Query version dropdown:", err);
  }

  try {
    initBibleQueryBookChapterDropdowns();
    installBibleQueryGlobalDropdownCloser();
  } catch (err) {
    console.warn("Failed to init Bible Query book/chapter dropdowns:", err);
  }

  try {
    initScriptureModeToggle();
  } catch (err) {
    console.warn("Failed to init Scripture Mode toggle:", err);
  }

  try {
    initVerseStudyModal();
  } catch (err) {
    console.warn("Failed to init verse study modal:", err);
  }

  // NEW: verse-study header clear behaviour
  try {
    initVerseStudyHeaderClearButton();
  } catch (err) {
    console.warn("Failed to init verse study header clear button:", err);
  }

  // Hook up the Bible reader close button to the same logic
  const readerCloseBtn = document.getElementById("bible-query-reader-close");
  if (readerCloseBtn) {
    readerCloseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Next time the reader renders, keep the current scroll position
      suppressNextReaderScroll = true;
      closeBibleReaderAndExitScriptureMode();
    });
  }

  // Also close on ESC key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Esc") {
      // If the user closes with ESC, don't snap back to the top on next open
      suppressNextReaderScroll = true;
      closeBibleReaderAndExitScriptureMode();
    }
  });
});

function initVerseStudyHeaderClearButton() {
  // Placeholder for future "clear selections in verse-study" behavior.
  // Currently a no-op – just here so the init call doesn't throw.
}

function initScriptureModeToggle() {
  const btn = document.getElementById("scripture-mode-toggle");
  const container = document.getElementById("bible-query-container");
  const reader = document.getElementById("bible-query-reader");

  if (!btn || !container || !reader) return;

  function applyState(on) {
    const body = document.body;

    if (on) {
      body.classList.add("scripture-mode-on");
      btn.classList.add("active");
      // btn.textContent = "Close Scripture";
      reader.style.display = "block";

      if (typeof window.__bbSyncScriptureNow === "function") {
        window.__bbSyncScriptureNow(true);
      }
    } else {
      body.classList.remove("scripture-mode-on");
      btn.classList.remove("active");
      // btn.textContent = "Scripture mode";
      reader.style.display = "none";

      if (typeof closeSearchQuery === "function") {
        try {
          closeSearchQuery();
        } catch (err) {
          console.warn(
            "closeSearchQuery() failed when turning off Scripture mode:",
            err
          );
        }
      }
    }
  }

  applyState(false);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const turningOn = !document.body.classList.contains("scripture-mode-on");
    applyState(turningOn);
  });
}

// Close the Bible reader and also turn off Scripture mode (if it's on)
function closeBibleReaderAndExitScriptureMode() {
  const body = document.body;
  const reader = document.getElementById("bible-query-reader");
  const scriptureBtn = document.getElementById("scripture-mode-toggle");
  const scriptureContainer = document.getElementById("bible-query-container");

  // 1) Run existing close logic (animations, etc.)
  if (typeof closeSearchQuery === "function") {
    try {
      closeSearchQuery();
    } catch (err) {
      console.warn(
        "closeSearchQuery() failed while closing Bible reader:",
        err
      );
    }
  }

  // 2) Ensure the reader panel is hidden
  if (reader) {
    reader.style.display = "none";
  }

  // 3) Clear any queued selections (verses / songs / interlinear)
  if (
    window.pendingVerseAdds &&
    typeof window.pendingVerseAdds.clear === "function"
  ) {
    window.pendingVerseAdds.clear();
  }
  if (
    window.pendingInterlinearAdds &&
    typeof window.pendingInterlinearAdds.clear === "function"
  ) {
    window.pendingInterlinearAdds.clear();
  }
  if (
    window.pendingSongAdds &&
    typeof window.pendingSongAdds.clear === "function"
  ) {
    window.pendingSongAdds.clear();
  }

  // Remove selection-related classes from the DOM
  const selectedEls = document.querySelectorAll(
    ".verse.selected-for-add, " +
      ".search-query-verse-container.selected-for-add, " +
      ".verse.selected-first, " +
      ".verse.selected-last, " +
      ".verse.selected-single"
  );
  selectedEls.forEach((el) => {
    el.classList.remove(
      "selected-for-add",
      "selected-first",
      "selected-last",
      "selected-single"
    );
  });

  // Hide any "Add to Board" buttons that depend on pending adds
  if (typeof updateFloatingAddButton === "function") {
    updateFloatingAddButton();
  }

  // 4) Exit Scripture mode visually
  if (body.classList.contains("scripture-mode-on")) {
    body.classList.remove("scripture-mode-on");
  }

  if (scriptureBtn) {
    scriptureBtn.classList.remove("active");
    // scriptureBtn.textContent = "Scripture mode";
  }

  if (scriptureContainer) {
    // CSS will hide it when scripture-mode-on is removed, so reset inline style
    scriptureContainer.style.display = "";
  }
}








function installBibleQueryGlobalDropdownCloser() {
  if (window.__bbBibleQueryDropdownCloserInstalled) return;
  window.__bbBibleQueryDropdownCloserInstalled = true;

  function closeAllBibleQueryDropdowns() {
    const bookDropdown = document.getElementById("bible-query-book-dropdown");
    const chapterDropdown = document.getElementById("bible-query-chapter-dropdown");
    const versionDropdown = document.getElementById("bible-query-version-dropdown");

    if (bookDropdown) {
      bookDropdown.setAttribute("data-open", "false");
      bookDropdown.dataset.dropdownType = "";
    }
    if (chapterDropdown) {
      chapterDropdown.setAttribute("data-open", "false");
      chapterDropdown.dataset.dropdownType = "";
    }
    if (versionDropdown) {
      versionDropdown.setAttribute("data-open", "false");
    }

    document.getElementById("bible-query-reference")?.classList.remove("open");
    document.getElementById("bible-query-version")?.classList.remove("open");
  }

  // Capture phase => runs even if inner handlers call stopPropagation()
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      const clickedInsideDropdown = t.closest?.(
        "#bible-query-book-dropdown, #bible-query-chapter-dropdown, #bible-query-version-dropdown"
      );
      if (clickedInsideDropdown) return;

      closeAllBibleQueryDropdowns();
    },
    true
  );
}













/**
 * Custom dropdowns for:
 * - Book  (#bible-query-container-book)
 * - Chapter (#bible-query-container-chapter)
 *
 * UX flow:
 *   - Click reference pill OR book -> show BOOK dropdown
 *   - Select book  -> close book dropdown, immediately show CHAPTER dropdown
 *   - Select chapter -> close everything
 *
 * Both dropdowns use the same .bible-query-dropdown / .bible-query-dropdown-item styles
 * as the version dropdown.
 */
function initBibleQueryBookChapterDropdowns() {
  const referencePill = document.getElementById("bible-query-reference");
  const bookLabel = document.getElementById("bible-query-container-book");
  const chapterLabel = document.getElementById("bible-query-container-chapter");

  if (!referencePill || !bookLabel || !chapterLabel) {
    return; // Not on this page or markup missing
  }

  // Hidden search form we reuse (already wired to Bible logic)
  const searchInput = document.getElementById("search-bar");
  const searchForm = document.getElementById("search-container");

  // Bible search results container (existing drawer)
  const verseResultContainer = document.getElementById(
    "search-query-verse-container"
  );

  // New reader DOM
  const reader = document.getElementById("bible-query-reader");
  const readerHeader = document.getElementById("bible-query-reader-header");
  const readerContent = document.getElementById("bible-query-reader-content");

  // Allow selecting verses directly in the Bible Reader
  // and long-pressing to open the verse study modal.
  function buildVerseDataFromReaderVerse(verseEl) {
    if (!verseEl) return null;

    const book = (bookLabel.textContent || "").trim();
    const chapter = (chapterLabel.textContent || "").trim();

    const verseNumEl = verseEl.querySelector(".verse-number");
    const verseNum = verseNumEl ? verseNumEl.textContent.trim() : "";
    if (!book || !chapter || !verseNum) return null;

    const reference = `${book} ${chapter}:${verseNum}`;

    const textEl =
      verseEl.querySelector(".verse-text-content") ||
      verseEl.querySelector(".verse-text");

    const verseText = textEl
      ? textEl.textContent.trim()
      : verseEl.textContent.trim();

    const text = `${verseNum} ${verseText}`.trim();

    // Current version (ESV, NLT, etc.)
    const versionTextEl = document.getElementById("bible-query-version-text");
    const versionSelect = document.getElementById("version-select");
    const version =
      (versionTextEl && versionTextEl.textContent.trim()) ||
      (versionSelect &&
        (versionSelect.value ||
          (versionSelect.selectedOptions &&
            versionSelect.selectedOptions[0] &&
            versionSelect.selectedOptions[0].textContent.trim()))) ||
      "";

    if (!version) return null;

    return { reference, text, version };
  }

  if (readerContent) {
    // Normal tap / click still toggles selection
    readerContent.addEventListener("click", (event) => {
      // Only care about verse rows inside the reader
      const verseEl = event.target.closest(
        "#bible-query-reader-content .verse-list-container .verse"
      );
      if (!verseEl) return;

      const verseData = buildVerseDataFromReaderVerse(verseEl);
      if (!verseData) return;

      toggleVerseSelection(verseData, verseEl);
    });

    // Long-press (hold) opens the verse study modal for interlinear / cross-refs
    const LONG_PRESS_MS = 350;
    let longPressTimer = null;
    let longPressTarget = null;

    function clearLongPressTimer() {
      if (longPressTimer !== null) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      longPressTarget = null;
    }

    function startLongPress(verseEl) {
      if (!verseEl) return;
      clearLongPressTimer();
      longPressTarget = verseEl;

      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        const verseData = buildVerseDataFromReaderVerse(longPressTarget);
        if (!verseData) return;

        if (typeof openVerseStudyModal === "function") {
          openVerseStudyModal(verseData);
        }
      }, LONG_PRESS_MS);
    }

    function getVerseFromEvent(event) {
      return event.target.closest(
        "#bible-query-reader-content .verse-list-container .verse"
      );
    }

    // Desktop: hold left mouse button
    readerContent.addEventListener("mousedown", (event) => {
      // Only left-click (button 0)
      if (event.button !== 0) return;
      const verseEl = getVerseFromEvent(event);
      if (!verseEl) return;
      startLongPress(verseEl);
    });

    readerContent.addEventListener("mouseup", clearLongPressTimer);
    readerContent.addEventListener("mouseleave", clearLongPressTimer);

    // Mobile / touch: finger hold
    readerContent.addEventListener(
      "touchstart",
      (event) => {
        const verseEl = getVerseFromEvent(event);
        if (!verseEl) return;
        startLongPress(verseEl);
      },
      { passive: true }
    );

    readerContent.addEventListener("touchend", clearLongPressTimer);
    readerContent.addEventListener("touchcancel", clearLongPressTimer);

    ["pointerup", "pointerleave", "pointercancel"].forEach((type) => {
      readerContent.addEventListener(type, clearLongPressTimer);
    });
  }

  // Track what we requested so we can label the header nicely
  let lastRequestedBook = null;
  let lastRequestedChapter = null;
  let pendingSyncAfterSearch = false;

  // Allow selecting verses directly inside the Bible Reader (not just the hidden search drawer)
  if (readerContent) {
    readerContent.addEventListener("click", (event) => {
      // Find the verse row that was clicked
      const verseRow = event.target.closest(".search-query-verse-container");
      if (!verseRow) return;

      // If the user clicked anywhere in the row, treat it as toggling that verse
      let addBtn =
        event.target.closest(".search-query-verse-add-button") ||
        verseRow.querySelector(".search-query-verse-add-button") ||
        verseRow; // fallback so toggleVerseSelection still finds the row

      // Extract reference + text from the row
      const refEl =
        verseRow.querySelector(".verse-text-reference") ||
        verseRow.querySelector(".search-query-verse-text");
      const textEl =
        verseRow.querySelector(".verse-text-content") ||
        verseRow.querySelector(".search-query-verse-text");

      const reference = refEl ? refEl.textContent.trim() : "";
      const text = textEl ? textEl.textContent.trim() : "";

      // Get the current version shown in the reader header
      const versionTextEl = document.getElementById("bible-query-version-text");
      const versionSelect = document.getElementById("version-select");
      const version =
        (versionTextEl && versionTextEl.textContent.trim()) ||
        (versionSelect &&
          (versionSelect.value ||
            (versionSelect.selectedOptions &&
              versionSelect.selectedOptions[0] &&
              versionSelect.selectedOptions[0].textContent.trim()))) ||
        "";

      if (!reference || !text || !version) return;

      const verseData = { reference, text, version };

      // Toggle selection (queue + row highlight + floating button)
      toggleVerseSelection(verseData, addBtn);
    });
  }

  // Allow other scripts (like the version picker) to request a sync
  window.__bbMarkBibleQueryNeedsSync = () => {
    pendingSyncAfterSearch = true;
  };

  // ---- Canonical book list (66 books) ----
  const BOOK_NAMES = [
    "Genesis",
    "Exodus",
    "Leviticus",
    "Numbers",
    "Deuteronomy",
    "Joshua",
    "Judges",
    "Ruth",
    "1 Samuel",
    "2 Samuel",
    "1 Kings",
    "2 Kings",
    "1 Chronicles",
    "2 Chronicles",
    "Ezra",
    "Nehemiah",
    "Esther",
    "Job",
    "Psalms",
    "Proverbs",
    "Ecclesiastes",
    "Song of Solomon",
    "Isaiah",
    "Jeremiah",
    "Lamentations",
    "Ezekiel",
    "Daniel",
    "Hosea",
    "Joel",
    "Amos",
    "Obadiah",
    "Jonah",
    "Micah",
    "Nahum",
    "Habakkuk",
    "Zephaniah",
    "Haggai",
    "Zechariah",
    "Malachi",
    "Matthew",
    "Mark",
    "Luke",
    "John",
    "Acts",
    "Romans",
    "1 Corinthians",
    "2 Corinthians",
    "Galatians",
    "Ephesians",
    "Philippians",
    "Colossians",
    "1 Thessalonians",
    "2 Thessalonians",
    "1 Timothy",
    "2 Timothy",
    "Titus",
    "Philemon",
    "Hebrews",
    "James",
    "1 Peter",
    "2 Peter",
    "1 John",
    "2 John",
    "3 John",
    "Jude",
    "Revelation",
  ];

  // ---- Chapter counts per book ----
  const BOOK_CHAPTER_COUNTS = {
    Genesis: 50,
    Exodus: 40,
    Leviticus: 27,
    Numbers: 36,
    Deuteronomy: 34,
    Joshua: 24,
    Judges: 21,
    Ruth: 4,
    "1 Samuel": 31,
    "2 Samuel": 24,
    "1 Kings": 22,
    "2 Kings": 25,
    "1 Chronicles": 29,
    "2 Chronicles": 36,
    Ezra: 10,
    Nehemiah: 13,
    Esther: 10,
    Job: 42,
    Psalms: 150,
    Proverbs: 31,
    Ecclesiastes: 12,
    "Song of Solomon": 8,
    Isaiah: 66,
    Jeremiah: 52,
    Lamentations: 5,
    Ezekiel: 48,
    Daniel: 12,
    Hosea: 14,
    Joel: 3,
    Amos: 9,
    Obadiah: 1,
    Jonah: 4,
    Micah: 7,
    Nahum: 3,
    Habakkuk: 3,
    Zephaniah: 3,
    Haggai: 2,
    Zechariah: 14,
    Malachi: 4,
    Matthew: 28,
    Mark: 16,
    Luke: 24,
    John: 21,
    Acts: 28,
    Romans: 16,
    "1 Corinthians": 16,
    "2 Corinthians": 13,
    Galatians: 6,
    Ephesians: 6,
    Philippians: 4,
    Colossians: 4,
    "1 Thessalonians": 5,
    "2 Thessalonians": 3,
    "1 Timothy": 6,
    "2 Timothy": 4,
    Titus: 3,
    Philemon: 1,
    Hebrews: 13,
    James: 5,
    "1 Peter": 5,
    "2 Peter": 3,
    "1 John": 5,
    "2 John": 1,
    "3 John": 1,
    Jude: 1,
    Revelation: 22,
  };

  function getMaxChapterForBook(bookName) {
    return BOOK_CHAPTER_COUNTS[bookName] || 150;
  }

  // ---- Prev/Next chapter arrows (Scripture mode) ----
  const prevArrow = document.createElement("button");
  prevArrow.type = "button";
  prevArrow.id = "bible-query-prev-chapter";
  prevArrow.className = "bible-query-arrow bible-query-arrow-prev";
  prevArrow.innerHTML =
    '<span class="material-symbols-outlined">chevron_left</span>';

  const nextArrow = document.createElement("button");
  nextArrow.type = "button";
  nextArrow.id = "bible-query-next-chapter";
  nextArrow.className = "bible-query-arrow bible-query-arrow-next";
  nextArrow.innerHTML =
    '<span class="material-symbols-outlined">chevron_right</span>';

  // Place arrows at the edges of the pill
  // [prev] [icon + book + chapter] [next]
  referencePill.insertBefore(prevArrow, referencePill.firstChild);
  referencePill.appendChild(nextArrow);

  function getCurrentBookChapter() {
    const book = (bookLabel.textContent || "").trim();
    let chapter = parseInt((chapterLabel.textContent || "").trim(), 10) || 1;

    const maxForBook = getMaxChapterForBook(book);
    if (chapter < 1) chapter = 1;
    if (chapter > maxForBook) chapter = maxForBook;

    return { book, chapter };
  }

  function updateArrowVisibility() {
    const { book, chapter } = getCurrentBookChapter();
    if (!prevArrow || !nextArrow) return;

    // Default: show both arrows
    prevArrow.style.display = "inline-flex";
    nextArrow.style.display = "inline-flex";
    referencePill.style.padding = "0px 10px";

    // Genesis 1: only right arrow
    if (book === "Genesis" && chapter === 1) {
      prevArrow.style.display = "none";
      nextArrow.style.display = "inline-flex";
      referencePill.style.paddingRight = "10px";
      referencePill.style.paddingLeft = "20px";
      return;
    }

    // Revelation 22: only left arrow
    const lastBook = "Revelation";
    const lastChapter = getMaxChapterForBook(lastBook);
    if (book === lastBook && chapter === lastChapter) {
      prevArrow.style.display = "inline-flex";
      nextArrow.style.display = "none";
      referencePill.style.paddingLeft = "10px";
      referencePill.style.paddingRight = "20px";
      return;
    }
  }

  function goToPrevChapter() {
    const { book, chapter } = getCurrentBookChapter();
    const idx = BOOK_NAMES.indexOf(book);
    if (idx === -1) return;

    // No previous from Genesis 1
    if (book === "Genesis" && chapter === 1) {
      return;
    }

    let newBook = book;
    let newChapter = chapter;

    if (chapter > 1) {
      // Previous chapter in same book
      newChapter = chapter - 1;
    } else {
      // Chapter 1 → last chapter of previous book
      if (idx > 0) {
        newBook = BOOK_NAMES[idx - 1];
        newChapter = getMaxChapterForBook(newBook);
      }
    }

    bookLabel.textContent = newBook;
    chapterLabel.textContent = String(newChapter);
    updateArrowVisibility();
    // Auto-submit & reload reader
    syncSearchField(true);
  }

  function goToNextChapter() {
    const { book, chapter } = getCurrentBookChapter();
    const idx = BOOK_NAMES.indexOf(book);
    if (idx === -1) return;

    const maxChapter = getMaxChapterForBook(book);

    // No next from Revelation 22
    if (book === "Revelation" && chapter === maxChapter) {
      return;
    }

    let newBook = book;
    let newChapter = chapter;

    if (chapter < maxChapter) {
      // Next chapter in same book
      newChapter = chapter + 1;
    } else {
      // Last chapter of this book → chapter 1 of next book
      if (idx < BOOK_NAMES.length - 1) {
        newBook = BOOK_NAMES[idx + 1];
        newChapter = 1;
      }
    }

    bookLabel.textContent = newBook;
    chapterLabel.textContent = String(newChapter);
    updateArrowVisibility();
    // Auto-submit & reload reader
    syncSearchField(true);
  }

  prevArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    goToPrevChapter();
  });

  nextArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    goToNextChapter();
  });

  // Initial state (Genesis 1 = only right arrow)
  updateArrowVisibility();

  // ---- Create dropdown DOM nodes (book + chapter) ----
  const bookDropdown = document.createElement("div");
  bookDropdown.id = "bible-query-book-dropdown";
  bookDropdown.className = "bible-query-dropdown";
  bookDropdown.setAttribute("data-open", "false");

  const chapterDropdown = document.createElement("div");
  chapterDropdown.id = "bible-query-chapter-dropdown";
  chapterDropdown.className = "bible-query-dropdown";
  chapterDropdown.setAttribute("data-open", "false");

  document.body.appendChild(bookDropdown);
  document.body.appendChild(chapterDropdown);

  // ---- Position dropdown under the reference pill ----
  function positionDropdown(dropdownEl) {
    const rect = referencePill.getBoundingClientRect();
    dropdownEl.style.position = "fixed";
    dropdownEl.style.left = rect.left + "px";
    dropdownEl.style.bottom = 80 + "px";
    dropdownEl.style.minWidth = rect.width + "px";
  }

  function openDropdown(dropdownEl, type) {
    closeAllDropdowns();
    positionDropdown(dropdownEl);
    dropdownEl.setAttribute("data-open", "true");
    dropdownEl.dataset.dropdownType = type; // 'book' or 'chapter'
    referencePill.classList.add("open");
  }

  function closeDropdown(dropdownEl) {
    dropdownEl.setAttribute("data-open", "false");
    dropdownEl.dataset.dropdownType = "";
  }

  function closeAllDropdowns() {
    closeDropdown(bookDropdown);
    closeDropdown(chapterDropdown);
    referencePill.classList.remove("open");
  }

  // ---- Reader rendering (copies from existing verse search results) ----
  function renderReaderFromVerseResults() {
    if (!reader || !readerHeader || !readerContent || !verseResultContainer)
      return;

    const book = (lastRequestedBook || bookLabel.textContent || "").trim();
    const chapter = (
      lastRequestedChapter ||
      chapterLabel.textContent ||
      ""
    ).trim();

    const versionTextEl = document.getElementById("bible-query-version-text");
    const versionSelect = document.getElementById("version-select");

    const version =
      (versionTextEl && versionTextEl.textContent.trim()) ||
      (versionSelect &&
        (versionSelect.value ||
          (versionSelect.selectedOptions &&
            versionSelect.selectedOptions[0] &&
            versionSelect.selectedOptions[0].textContent.trim()))) ||
      "";

    // 🔹 Reset header content
    readerHeader.innerHTML = "";

    const bookChapter = document.createElement("div");
    bookChapter.id = "book-chapter-text-element";
    bookChapter.textContent = `${book} ${chapter}`;

    const versionText = document.createElement("div");
    versionText.id = "version-text-element";
    versionText.textContent = version;

    readerHeader.appendChild(bookChapter);
    readerHeader.appendChild(versionText);

    // 🔹 Copy verses from the hidden search drawer
    readerContent.innerHTML = verseResultContainer.innerHTML;

    // 🔝 Scroll to top *unless* we've been told to preserve scroll
    if (!suppressNextReaderScroll) {
      readerContent.scrollTop = 0;
      reader.scrollTop = 0;
    } else {
      // Consume the suppression flag so future renders behave normally again
      suppressNextReaderScroll = false;
    }

    // 🔹 Make it visible & animate in
    reader.style.display = "flex";

    // Start from "closed" pose so the transition plays
    reader.style.opacity = "0";
    reader.style.top = "12px";

    // Next frame, animate to open pose
    requestAnimationFrame(() => {
      reader.style.opacity = "1";
      reader.style.top = "0px";
    });
  }

  // Watch the verse results container for changes after we trigger search
  if (verseResultContainer && readerContent) {
    const observer = new MutationObserver(() => {
      // Only react if this change came from our book/chapter selection
      if (!pendingSyncAfterSearch) return;

      // ✅ Wait until actual chapter content has been rendered
      const hasVerses = !!verseResultContainer.querySelector(
        ".verse-list-container"
      );
      if (!hasVerses) {
        // This is probably just the "clear" / loader stage — ignore
        return;
      }

      pendingSyncAfterSearch = false;
      renderReaderFromVerseResults();
    });

    observer.observe(verseResultContainer, {
      childList: true,
      subtree: true, // watch deeper changes as verses are appended
    });
  }

  // ---- Render options for BOOKS ----
  function renderBookOptions() {
    bookDropdown.innerHTML = "";
    const currentBook = (bookLabel.textContent || "").trim();

    BOOK_NAMES.forEach((name) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bible-query-dropdown-item";
      btn.textContent = name;

      if (name === currentBook) {
        btn.classList.add("selected");
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        // 1) Select book
        selectBook(name);
        // 2) Immediately open chapters for that book
        renderChapterOptions();
        openDropdown(chapterDropdown, "chapter");
      });

      bookDropdown.appendChild(btn);
    });
  }

  // ---- Render options for CHAPTERS (based on current book) ----
  function renderChapterOptions() {
    chapterDropdown.innerHTML = "";
    const currentBook = (bookLabel.textContent || "").trim();
    const maxChapter = getMaxChapterForBook(currentBook);
    const currentChapter =
      parseInt((chapterLabel.textContent || "").trim(), 10) || 1;

    for (let ch = 1; ch <= maxChapter; ch++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bible-query-dropdown-item";
      btn.textContent = String(ch);

      if (ch === currentChapter) {
        btn.classList.add("selected");
      }

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectChapter(ch);
        closeAllDropdowns();
      });

      chapterDropdown.appendChild(btn);
    }
  }

  // ---- Sync book/chapter into hidden search input & trigger search ----
  function syncSearchField(autoSubmit = false) {
    if (!searchInput) return;

    const book = (bookLabel.textContent || "").trim();
    const chapter = (chapterLabel.textContent || "").trim();
    if (!book || !chapter) return;

    searchInput.value = `${book} ${chapter}`;

    if (autoSubmit && searchForm) {
      lastRequestedBook = book;
      lastRequestedChapter = chapter;
      pendingSyncAfterSearch = true;

      // ✅ NEW: Persist last opened chapter locally
      try {
        localStorage.setItem(
          "bb:lastScriptureRef",
          JSON.stringify({ book, chapter })
        );
      } catch (err) {
        console.warn("[BibleReader] Failed to persist last reference:", err);
      }

      // If you have a search drawer function, open it so the verses load
      if (typeof window.openSearchModal === "function") {
        window.openSearchModal();
      }

      if (typeof searchForm.requestSubmit === "function") {
        searchForm.requestSubmit();
      } else {
        const ev = new Event("submit", { bubbles: true, cancelable: true });
        searchForm.dispatchEvent(ev);
      }
    }
  }

  // Expose a helper so other parts (like Scripture mode) can trigger this
  window.__bbSyncScriptureNow = function (autoSubmit = true) {
    syncSearchField(autoSubmit);
  };

  // ---- Selection handlers ----
  function selectBook(name) {
    bookLabel.textContent = name;

    const maxChapter = getMaxChapterForBook(name);
    let currentChapter =
      parseInt((chapterLabel.textContent || "").trim(), 10) || 1;
    if (currentChapter > maxChapter) {
      currentChapter = maxChapter;
      chapterLabel.textContent = String(currentChapter);
    }

    updateArrowVisibility(); // NEW
    // Just change the text + hidden query, do NOT auto-submit yet
    syncSearchField(false);
  }

  function selectChapter(ch) {
    chapterLabel.textContent = String(ch);
    updateArrowVisibility(); // NEW
    // 👇 This auto-submits and triggers the reader update
    syncSearchField(true);
  }

  // ---- Click behavior ----

  // Click on the whole reference pill opens BOOK selection
  referencePill.addEventListener("click", (e) => {
    e.stopPropagation();
    renderBookOptions();
    openDropdown(bookDropdown, "book");
  });

  // Clicking on the book label also opens the book list
  bookLabel.addEventListener("click", (e) => {
    e.stopPropagation();
    renderBookOptions();
    openDropdown(bookDropdown, "book");
  });

  // Clicking on the chapter label jumps straight to the chapter list
  chapterLabel.addEventListener("click", (e) => {
    e.stopPropagation();
    renderChapterOptions();
    openDropdown(chapterDropdown, "chapter");
  });

  // Close all dropdowns when clicking outside
  document.addEventListener("click", (e) => {
    const isOpenBook = bookDropdown.getAttribute("data-open") === "true";
    const isOpenChapter = chapterDropdown.getAttribute("data-open") === "true";

    if (!isOpenBook && !isOpenChapter) return;

    if (
      !bookDropdown.contains(e.target) &&
      !chapterDropdown.contains(e.target) &&
      !referencePill.contains(e.target)
    ) {
      closeAllDropdowns();
    }
  });

  // ✅ NEW: Restore last opened book + chapter from localStorage (if available)
  try {
    const raw = localStorage.getItem("bb:lastScriptureRef");
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved.book && saved.chapter) {
        bookLabel.textContent = saved.book;
        chapterLabel.textContent = String(saved.chapter);
      }
    }
  } catch (err) {
    console.warn("[BibleReader] Failed to restore last reference:", err);
  }

  // Initial: clamp chapter to the valid range for the initial book
  const initialBook =
    (bookLabel.textContent || "").trim() || BOOK_NAMES[0] || "Genesis";
  selectBook(initialBook);
}

/**
 * Custom dropdown for Bible versions that stays in sync
 * with the hidden <select id="version-select"> element.
 * This avoids the native <select> styling and works on
 * both desktop and mobile.
 */
function initBibleQueryVersionDropdown() {
  const versionButton = document.getElementById("bible-query-version");
  const versionText = document.getElementById("bible-query-version-text");
  const nativeSelect = document.getElementById("version-select");

  if (!versionButton || !versionText || !nativeSelect) {
    return; // Not on this page or markup missing
  }

  // Hide the native select but keep it in the DOM so
  // existing logic that reads #version-select still works.
  nativeSelect.style.display = "none";

  const dropdown = document.createElement("div");
  dropdown.id = "bible-query-version-dropdown";
  dropdown.className = "bible-query-dropdown";
  dropdown.setAttribute("data-open", "false");

  Array.from(nativeSelect.options).forEach((opt) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "bible-query-dropdown-item";
    item.textContent = opt.textContent.trim();
    item.dataset.value = opt.value || opt.textContent.trim();

    if (opt.selected || nativeSelect.value === item.dataset.value) {
      item.classList.add("selected");
    }

    item.addEventListener("click", (e) => {
      e.stopPropagation();

      const value = item.dataset.value;
      const label = item.textContent;

      // Update the visible label
      versionText.textContent = label;

      // Keep the hidden native select in sync
      nativeSelect.value = value;

      // Update selected state UI
      dropdown.querySelectorAll(".bible-query-dropdown-item").forEach((btn) => {
        btn.classList.toggle("selected", btn === item);
      });

      // Fire a change event so any existing listeners react.
      nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));

      closeDropdown();
    });

    dropdown.appendChild(item);
  });

  document.body.appendChild(dropdown);

  function openDropdown() {
    const rect = versionButton.getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.left = rect.left + "px";
    dropdown.style.bottom = 80 + "px";
    dropdown.style.minWidth = rect.width + "px";
    dropdown.setAttribute("data-open", "true");
    versionButton.classList.add("open");
  }

  function closeDropdown() {
    dropdown.setAttribute("data-open", "false");
    versionButton.classList.remove("open");
  }

  versionButton.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.getAttribute("data-open") === "true";
    if (isOpen) {
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  // Close when clicking outside
  document.addEventListener("click", (e) => {
    if (dropdown.getAttribute("data-open") !== "true") return;
    if (!dropdown.contains(e.target) && !versionButton.contains(e.target)) {
      closeDropdown();
    }
  });

  // Ensure the label matches the current select value on load
  if (!versionText.textContent.trim()) {
    const selected =
      nativeSelect.value || nativeSelect.options[0]?.textContent.trim();
    if (selected) {
      versionText.textContent = selected;
    }
  }
}
