/* =====================================================================
   Sidebar Controller (Variable Based)
   ===================================================================== */

(function () {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("overlay");
  const logoBtn = document.getElementById("logo-btn");
  const sidebarLogoBtn = document.getElementById("sidebar-logo-btn");
  const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
  const hamburgerBtn = document.getElementById("hamburger-btn");

  // Buttons to forward
  const newBoardBtn = document.getElementById("new-board-btn");
  const signoutTop = document.getElementById("signout-btn");
  const newBoardBtnSidebar = document.getElementById("new-board-btn-sidebar");
  const signoutSidebar = document.getElementById("signout-btn-sidebar");

  const BREAKPOINT = 900; 

  function isMobile() {
    return window.innerWidth < BREAKPOINT;
  }

  function setAria(el, val) {
    if (el) el.setAttribute("aria-expanded", val ? "true" : "false");
  }

  // --- NEW: The Magic Function ---
  // Updates the CSS variable globally so everything resizes
  function updateLayoutVar(isCollapsed) {
    if (isMobile()) {
      // On mobile, let CSS media queries handle it (remove inline override)
      document.documentElement.style.removeProperty('--sidebar-width');
    } else {
      // On desktop, set exact pixel width
      const width = isCollapsed ? "72px" : "280px";
      document.documentElement.style.setProperty('--sidebar-width', width);
    }
  }

  // --- Initialization ---
  function initSidebarState() {
    if (isMobile()) {
      sidebar.classList.remove("collapsed", "expanded");
      sidebar.classList.add("offscreen");
      overlay.classList.add("hidden");
      setAria(logoBtn, false);
      setAria(hamburgerBtn, false);
      updateLayoutVar(false); // Reset var for mobile
    } else {
      const wasCollapsed = localStorage.getItem("sidebar_collapsed") === "true";
      sidebar.classList.remove("offscreen");

      if (wasCollapsed) {
        sidebar.classList.add("collapsed");
        sidebar.classList.remove("expanded");
        setAria(logoBtn, false);
        updateLayoutVar(true); // Set to 72px
      } else {
        sidebar.classList.add("expanded");
        sidebar.classList.remove("collapsed");
        setAria(logoBtn, true);
        updateLayoutVar(false); // Set to 280px
      }
    }
  }

  // --- Toggle Logic ---
  function toggleDesktopSidebar() {
    if (sidebar.classList.contains("collapsed")) {
      // Expand
      sidebar.classList.remove("collapsed");
      sidebar.classList.add("expanded");
      localStorage.setItem("sidebar_collapsed", "false");
      setAria(logoBtn, true);
      updateLayoutVar(false); // -> 280px
    } else {
      // Collapse
      sidebar.classList.remove("expanded");
      sidebar.classList.add("collapsed");
      localStorage.setItem("sidebar_collapsed", "true");
      setAria(logoBtn, false);
      updateLayoutVar(true); // -> 72px
    }
  }

  function openMobileSidebar() {
    sidebar.classList.remove("offscreen");
    sidebar.classList.add("expanded");
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    setAria(logoBtn, true);
    setAria(hamburgerBtn, true);
    document.body.style.overflow = "hidden";
  }

  function closeMobileSidebar() {
    sidebar.classList.remove("expanded");
    sidebar.classList.add("offscreen");
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    setAria(logoBtn, false);
    setAria(hamburgerBtn, false);
    document.body.style.overflow = "";
  }

  function toggleSidebarFromLogo() {
    if (isMobile()) {
      if (sidebar.classList.contains("offscreen")) openMobileSidebar();
      else closeMobileSidebar();
    } else {
      toggleDesktopSidebar();
    }
  }

  // --- Event Listeners ---
  logoBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleSidebarFromLogo();
  });

  sidebarLogoBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleSidebarFromLogo();
  });

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSidebarFromLogo();
    });
  }

  hamburgerBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (sidebar.classList.contains("offscreen")) openMobileSidebar();
    else closeMobileSidebar();
  });

  overlay?.addEventListener("click", () => closeMobileSidebar());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!overlay.classList.contains("hidden")) closeMobileSidebar();
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      initSidebarState();
      // Force update layout var on resize too
      if (!isMobile()) {
        const isCollapsed = sidebar.classList.contains("collapsed");
        updateLayoutVar(isCollapsed);
      }
    }, 150);
  });

  // Button Forwarding
  if (newBoardBtnSidebar && newBoardBtn) {
    newBoardBtnSidebar.addEventListener("click", () => {
      newBoardBtn.click();
      if (isMobile()) closeMobileSidebar();
    });
  }

  if (signoutSidebar && signoutTop) {
    signoutSidebar.addEventListener("click", () => {
      signoutTop.click(); 
      if (isMobile()) closeMobileSidebar();
    });
  }

  initSidebarState();
})();