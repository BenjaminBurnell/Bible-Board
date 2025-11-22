// board/tour.js

class Tour {
  constructor(steps = [], options = {}) {
    this.steps = steps;
    this.options = {
      padding: 8,
      tooltipMargin: 8, // New option for screen edge margin
      onStart: () => {},
      onEnd: () => {},
      onStep: () => {},
      ...options,
    };
    this.currentStep = 0;
    this.isOpen = false;
    this.prevFocusedEl = null;
    this.motionQuery =
      window.matchMedia?.("(prefers-reduced-motion: reduce)") || {
        matches: false,
      };
    this._vpSnapshot = null; 

    // DOM elements
    this.overlay = null;
    this.highlight = null;
    this.tooltip = null;
    this.arrow = null;
    this.titleEl = null;
    this.contentEl = null;
    this.stepsEl = null;
    this.skipBtn = null;
    this.backBtn = null;
    this.nextBtn = null;
    this.focusTrapStart = null;
    this.focusTrapEnd = null;

    // Shield elements
    this.shieldsContainer = null;
    this.shields = { top: null, bottom: null, left: null, right: null };

    // Bind methods
    this._handleKeydown = this._handleKeydown.bind(this);
    this._handleResize = this._handleResize.bind(this);
    this._focusTrap = this._focusTrap.bind(this);
    this.next = this.next.bind(this);
    this.back = this.back.bind(this);
    this.end = this.end.bind(this);
  }

  // --- Helpers ---
  _style(el, styles) {
    if (!el) return;
    Object.assign(el.style, styles);
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _waitForFrames(n = 2) {
    return new Promise((resolve) => {
      let count = 0;
      const loop = () => {
        count++;
        if (count >= n) {
          resolve();
        } else {
          requestAnimationFrame(loop);
        }
      };
      loop();
    });
  }

  // --- DOM Lifecycle ---
  _createElements() {
    this.prevFocusedEl = document.activeElement;

    // Overlay (now just visual)
    this.overlay = document.createElement("div");
    this.overlay.id = "bb-tour-overlay";
    this.overlay.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.overlay);

    // Shield container
    this.shieldsContainer = document.createElement("div");
    this.shieldsContainer.id = "bb-tour-shields";
    this.shieldsContainer.setAttribute("aria-hidden", "true");

    // Create 4 shield divs
    this.shields.top = document.createElement("div");
    this.shields.bottom = document.createElement("div");
    this.shields.left = document.createElement("div");
    this.shields.right = document.createElement("div");

    for (const shield of Object.values(this.shields)) {
      shield.className = "bb-tour-shield";
      this.shieldsContainer.appendChild(shield);
    }
    document.body.appendChild(this.shieldsContainer);

    // Highlight (visual ring)
    this.highlight = document.createElement("div");
    this.highlight.id = "bb-tour-highlight";
    this.highlight.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.highlight);

    // Tooltip
    this.tooltip = document.createElement("div");
    this.tooltip.id = "bb-tour-tooltip";
    this.tooltip.setAttribute("role", "dialog");
    this.tooltip.setAttribute("aria-modal", "true");
    this.tooltip.setAttribute("aria-live", "polite");
    this.tooltip.setAttribute("aria-labelledby", "bb-tour-title");
    this.tooltip.setAttribute("aria-describedby", "bb-tour-content");
    this.tooltip.style.visibility = "hidden";

    // Focus Traps
    this.focusTrapStart = document.createElement("div");
    this.focusTrapStart.className = "bb-tour-focus-trap";
    this.focusTrapStart.tabIndex = 0;
    this.focusTrapEnd = this.focusTrapStart.cloneNode();

    // Arrow
    this.arrow = document.createElement("div");
    this.arrow.id = "bb-tour-arrow";
    this.arrow.setAttribute("aria-hidden", "true");

    // Content
    this.titleEl = document.createElement("h2");
    this.titleEl.className = "bb-tour-title";
    this.titleEl.id = "bb-tour-title";

    this.contentEl = document.createElement("p");
    this.contentEl.className = "bb-tour-content";
    this.contentEl.id = "bb-tour-content";

    // Footer
    const footer = document.createElement("footer");
    footer.className = "bb-tour-footer";
    this.stepsEl = document.createElement("span");
    this.stepsEl.className = "bb-tour-steps";
    const buttons = document.createElement("div");
    buttons.className = "bb-tour-buttons";

    this.skipBtn = document.createElement("button");
    this.skipBtn.className = "bb-tour-btn bb-tour-btn-skip";
    this.skipBtn.textContent = "Skip";
    this.skipBtn.onclick = () => this.end({ completed: false });

    this.backBtn = document.createElement("button");
    this.backBtn.className = "bb-tour-btn";
    this.backBtn.textContent = "Back";
    this.backBtn.onclick = this.back;

    this.nextBtn = document.createElement("button");
    this.nextBtn.className = "bb-tour-btn bb-tour-btn-primary";
    this.nextBtn.textContent = "Next";
    this.nextBtn.onclick = this.next;

    buttons.appendChild(this.skipBtn);
    buttons.appendChild(this.backBtn);
    buttons.appendChild(this.nextBtn);
    footer.appendChild(this.stepsEl);
    footer.appendChild(buttons);

    // Assemble Tooltip
    this.tooltip.appendChild(this.focusTrapStart);
    this.tooltip.appendChild(this.titleEl);
    this.tooltip.appendChild(this.contentEl);
    this.tooltip.appendChild(footer);
    this.tooltip.appendChild(this.arrow);
    this.tooltip.appendChild(this.focusTrapEnd);

    document.body.appendChild(this.tooltip);
  }

  _destroyElements() {
    this.overlay?.remove();
    this.highlight?.remove();
    this.tooltip?.remove();
    this.shieldsContainer?.remove();

    this.overlay = null;
    this.highlight = null;
    this.tooltip = null;
    this.shieldsContainer = null;
    this.shields = { top: null, bottom: null, left: null, right: null };

    this.prevFocusedEl?.focus();
  }

  // --- Event Listeners ---
  _attachListeners() {
    window.addEventListener("keydown", this._handleKeydown, true);
    window.addEventListener("resize", this._handleResize);
    document.addEventListener("scroll", this._handleResize, true);
    this.focusTrapStart.addEventListener("focus", this._focusTrap);
    this.focusTrapEnd.addEventListener("focus", this._focusTrap);
  }

  _removeListeners() {
    window.removeEventListener("keydown", this._handleKeydown, true);
    window.removeEventListener("resize", this._handleResize);
    document.removeEventListener("scroll", this._handleResize, true);
    this.focusTrapStart?.removeEventListener("focus", this._focusTrap);
    this.focusTrapEnd?.removeEventListener("focus", this._focusTrap);
  }

  _handleKeydown(e) {
    if (!this.isOpen) return;

    const ae = document.activeElement;
    const isTyping =
      ae &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.isContentEditable ||
        ae.closest?.("#search-container"));
    
    if (isTyping) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.end({ completed: false });
    } else if ((e.key === "ArrowRight" || e.key === "Enter") && this.nextBtn.style.display !== "none") {
      e.preventDefault();
      e.stopPropagation();
      this.next();
    } else if (e.key === "ArrowLeft" && !this.backBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      this.back();
    }
  }

  _focusTrap(e) {
    const isStartTrap = e.target === this.focusTrapStart;
    const focusableElements = [this.skipBtn, this.backBtn, this.nextBtn].filter(
      (el) => !el.disabled && el.style.display !== "none"
    );

    if (isStartTrap) {
      focusableElements[focusableElements.length - 1]?.focus();
    } else {
      focusableElements[0]?.focus();
    }
  }

  _handleResize() {
    if (!this.isOpen) return;
    this._positionCurrentStep();
  }

  // --- Core Logic ---

  _getTarget(step) {
    if (!step.target) return null;
    if (typeof step.target === "string") {
      return document.querySelector(step.target);
    }
    if (typeof step.target === "function") {
      return step.target();
    }
    return step.target;
  }

  async _ensureBoardTargetVisible(target, padding = 16) {
    const viewport = document.querySelector(".viewport");
    const workspace = document.getElementById("workspace");
    if (!target || !viewport || !workspace) return;

    const scale = window.BoardAPI?.getScale?.() || 1;
    const t = target.getBoundingClientRect();
    const vp = viewport.getBoundingClientRect();

    const targetCx = (t.left + t.right) / 2;
    const targetCy = (t.top + t.bottom) / 2;
    const viewCx = (vp.left + vp.right) / 2;
    const viewCy = (vp.top + vp.bottom) / 2;

    const deltaScreenX = targetCx - viewCx;
    const deltaScreenY = targetCy - viewCy;

    const dx = deltaScreenX / scale;
    const dy = deltaScreenY / scale;

    viewport.scrollBy({
      left: dx,
      top: dy,
      behavior: this.motionQuery.matches ? "auto" : "smooth",
    });

    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );
  }

  async _ensureTargetVisible(step) {
    const target = this._getTarget(step);
    if (!target) return;

    const viewport = document.querySelector(".viewport");
    const isBoardTarget = viewport && viewport.contains(target);

    if (isBoardTarget) {
      await this._ensureBoardTargetVisible(target, step.padding ?? 16);
    } else {
      try {
        target.scrollIntoView({
          behavior: this.motionQuery.matches ? "auto" : "smooth",
          block: "center",
          inline: "center",
        });
        await new Promise((r) => requestAnimationFrame(r));
      } catch {}
    }
  }

  _positionTooltip(targetRect, placement) {
    this._style(this.tooltip, {
      transform: "",
      top: "-9999px",
      left: "-9999px",
      visibility: "visible",
    });
    const tipRect = this.tooltip.getBoundingClientRect();
    const arrowPad = 25;
    const margin = this.options.tooltipMargin;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    const placements = {
      bottom: {
        top: targetRect.bottom + arrowPad,
        left: targetRect.left + targetRect.width / 2 - tipRect.width / 2,
      },
      right: {
        top: targetRect.top + targetRect.height / 2 - tipRect.height / 2,
        left: targetRect.right + arrowPad,
      },
      left: {
        top: targetRect.top + targetRect.height / 2 - tipRect.height / 2,
        left: targetRect.left - tipRect.width - arrowPad,
      },
      top: {
        top: targetRect.top - tipRect.height - arrowPad,
        left: targetRect.left + targetRect.width / 2 - tipRect.width / 2,
      },
    };

    const checkFit = (pos) => {
      return (
        pos.top >= margin &&
        pos.left >= margin &&
        pos.top + tipRect.height <= vpH - margin &&
        pos.left + tipRect.width <= vpW - margin
      );
    };

    let finalPlacement = placement;
    if (placement === "auto") {
      const order = ["bottom", "right", "left", "top"];
      finalPlacement = order.find((p) => checkFit(placements[p])) || "bottom";
    }

    let { top, left } = placements[finalPlacement];

    if (top < margin) top = margin;
    if (left < margin) left = margin;
    if (top + tipRect.height > vpH - margin)
      top = vpH - tipRect.height - margin;
    if (left + tipRect.width > vpW - margin)
      left = vpW - tipRect.width - margin;

    this._style(this.tooltip, { top: `${top}px`, left: `${left}px` });
    this.tooltip.setAttribute("data-placement", finalPlacement);
  }

  async _positionCurrentStep() {
    const step = this.steps[this.currentStep];
    if (!step) return;

    const target = this._getTarget(step);
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    if (step.id === "finish") {
      this._style(this.shields.top, {
        display: "block",
        position: "fixed",
        left: "0px",
        top: "0px",
        right: "0px",
        bottom: "0px",
        width: "100vw",
        height: "100vh",
      });
      this._style(this.shields.bottom, { display: "none" });
      this._style(this.shields.left, { display: "none" });
      this._style(this.shields.right, { display: "none" });
      this._style(this.highlight, { display: "none" });
      this.tooltip.classList.add("bb-tour-centered");
      this._style(this.tooltip, {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      return;
    }

    if (!target) {
      this._style(this.highlight, { display: "none" });
      this.tooltip.classList.add("bb-tour-centered");
      this._style(this.tooltip, {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      this._style(this.shields.top, {
        left: "0",
        top: "0",
        right: "0",
        bottom: "0",
        display: "block",
      });
      this._style(this.shields.bottom, { display: "none" });
      this._style(this.shields.left, { display: "none" });
      this._style(this.shields.right, { display: "none" });
      return;
    }

    await this._ensureTargetVisible(step);

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const snap = (v) => Math.round(v * dpr) / dpr;
    const pad = (step.padding ?? this.options.padding) | 0;
    const r = target.getBoundingClientRect();

    const hole = {
      left: snap(r.left - pad),
      top: snap(r.top - pad),
      right: snap(r.right + pad),
      bottom: snap(r.bottom + pad),
    };
    hole.left = Math.max(0, hole.left);
    hole.top = Math.max(0, hole.top);
    hole.right = Math.min(vpW, hole.right);
    hole.bottom = Math.min(vpH, hole.bottom);
    const holeHeight = Math.max(0, hole.bottom - hole.top);
    const holeWidth = Math.max(0, hole.right - hole.left);

    this._style(this.highlight, {
      display: "block",
      left: `${hole.left}px`,
      top: `${hole.top}px`,
      width: `${holeWidth}px`,
      height: `${holeHeight}px`,
    });

    if (step.allowPointerThrough) {
      this._style(this.shields.top, {
        left: "0",
        top: "0",
        right: "0",
        height: `${hole.top}px`,
        display: "block",
      });
      this._style(this.shields.bottom, {
        left: "0",
        top: `${hole.bottom}px`,
        right: "0",
        bottom: "0",
        display: "block",
      });
      this._style(this.shields.left, {
        left: "0",
        top: `${hole.top}px`,
        width: `${hole.left}px`,
        height: `${holeHeight}px`,
        display: "block",
      });
      this._style(this.shields.right, {
        left: `${hole.right}px`,
        top: `${hole.top}px`,
        right: "0",
        height: `${holeHeight}px`,
        display: "block",
      });
    } else {
      this._style(this.shields.top, {
        display: "block",
        position: "fixed",
        left: "0px",
        top: "0px",
        right: "0px",
        bottom: "0px",
        width: "100vw",
        height: "100vh",
      });
      this._style(this.shields.bottom, { display: "none" });
      this._style(this.shields.left, { display: "none" });
      this._style(this.shields.right, { display: "none" });
    }

    this.tooltip.classList.remove("bb-tour-centered");
    this._positionTooltip(r, step.placement || "auto"); 
  }

  async _setStep(index) {
    const prevStep = this.steps[this.currentStep];
    if (prevStep && typeof prevStep.afterStep === "function") {
      try {
        await prevStep.afterStep();
      } catch (e) {
        console.warn("Tour afterStep error", e);
      }
    }

    this.currentStep = index;
    const step = this.steps[index];
    if (!step) {
      this.end({ completed: true });
      return;
    }

    this.highlight.style.opacity = 0;
    this.tooltip.style.opacity = 0;

    if (typeof step.beforeStep === "function") {
      try {
        await step.beforeStep();
      } catch (e) {
        console.warn("Tour beforeStep error", e);
      }
    }

    this.titleEl.textContent = step.title;
    this.contentEl.textContent = step.text;
    this.stepsEl.textContent = `${index + 1} / ${this.steps.length}`;

    this.backBtn.disabled = index === 0;
    this.skipBtn.textContent =
      index === this.steps.length - 1 ? "Finish" : "Skip";
    
    // Interactive Steps Hide "Next" Button
    if (step.hideNext) {
        this.nextBtn.style.display = "none";
    } else {
        this.nextBtn.style.display =
          index === this.steps.length - 1 ? "none" : "inline-block";
    }

    if (this.skipBtn.textContent === "Finish") {
      this.skipBtn.classList.add("bb-tour-btn-primary");
      this.skipBtn.onclick = () => this.end({ completed: true });
    } else {
      this.skipBtn.classList.remove("bb-tour-btn-primary");
      this.skipBtn.onclick = () => this.end({ completed: false });
    }

    await this._positionCurrentStep();

    this.tooltip.style.visibility = "visible";
    this.highlight.style.opacity = 1;
    this.tooltip.style.opacity = 1;
    this.tooltip.style.transform = this.tooltip.classList.contains(
      "bb-tour-centered"
    )
      ? "translate(-50%, -50%) scale(1)"
      : "";

    // Focus management
    if (this.nextBtn.style.display !== "none") {
        this.nextBtn.focus();
    } else {
        this.skipBtn.focus();
    }

    this.options.onStep(index, step);
  }

  async start(startIndex = 0) {
    if (this.isOpen) return;
    this.isOpen = true;
    this._createElements();
    this._attachListeners();

    const viewport = document.querySelector(".viewport");
    this._vpSnapshot = viewport
      ? {
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
          scale: window.BoardAPI?.getScale?.() || 1,
        }
      : null;

    this.overlay.style.opacity = 1;
    await this._setStep(startIndex);
    this.options.onStart();
  }

  async next() {
    if (this.currentStep < this.steps.length - 1) {
      await this._setStep(this.currentStep + 1);
    } else {
      this.end({ completed: true });
    }
  }

  async back() {
    if (this.currentStep > 0) {
      await this._setStep(this.currentStep - 1);
    }
  }

  async go(index) {
    if (index >= 0 && index < this.steps.length) {
      await this._setStep(index);
    }
  }

  end(options = {}) {
    const { completed = false } = options;
    if (!this.isOpen) return;
    this.isOpen = false;

    this._removeListeners();
    this._destroyElements(); 

    const currentStep = this.steps[this.currentStep];
    if (currentStep && typeof currentStep.afterStep === "function") {
      try {
        currentStep.afterStep();
      } catch (e) {}
    }

    setTimeout(() => {
      const viewport = document.querySelector(".viewport");
      const workspace = document.getElementById("workspace");

      if (viewport && workspace && this._vpSnapshot) {
        if (typeof window.BoardAPI?.setScale === "function") {
          window.BoardAPI.setScale(this._vpSnapshot.scale);
        } else {
          workspace.style.transformOrigin = "top left";
          workspace.style.transform = `scale(${this._vpSnapshot.scale})`;
        }
        viewport.scrollLeft = this._vpSnapshot.left;
        viewport.scrollTop = this._vpSnapshot.top;

        try {
          window.clampScroll?.();
        } catch {}
        try {
          window.updateAllConnections?.();
        } catch {}
      }

      this._vpSnapshot = null;
      try {
        this.options?.onEnd?.({ completed });
      } catch (e) {
        console.error("Tour onEnd callback failed", e);
      }
    }, 0);
  }
}

// ==========================================
// CONTEXT-AWARE TOUR CONFIGURATION
// ==========================================

// 1. Dashboard Steps (dashboard/index.html)
const dashboardSteps = [
  {
    id: "dash-welcome",
    title: "Welcome to BibleBoard",
    text: "This is your dashboard. Manage your study boards here.",
    placement: "center",
  },
  {
    id: "dash-sidebar",
    title: "Navigation",
    text: "Collapse the sidebar to save space, or use it to switch boards.",
    target: "#sidebar-toggle-btn",
    placement: "right",
  },
  {
    id: "dash-new",
    title: "Create a Board",
    text: "Start a new study canvas by clicking here.",
    target: "#new-board-btn-sidebar",
    placement: "right",
  },
  {
    id: "dash-search",
    title: "Search Boards",
    text: "Quickly find specific notes or verses across all your boards.",
    target: "#search-board-btn-sidebar",
    placement: "right",
  }
];

// ==========================================
// 2. WORKSPACE TOUR (Interactive)
// ==========================================
let _tourObserver = null;
let _tourClickListener = null;

const workspaceSteps = [
  {
    id: "welcome",
    title: "Welcome to your canvas",
    text: "Let's add your first item. We'll search for a verse and drop it on the board.",
    placement: "center",
  },
  {
    id: "interactive-search",
    title: "Search for a Verse",
    text: "Type 'John 3:16' (or any topic) in the search bar and press Enter.",
    target: "#search-container",
    placement: "top",
    padding: 4,
    allowPointerThrough: true,
    hideNext: true, // User must search to proceed
    beforeStep: () => {
        return new Promise(resolve => {
            const container = document.getElementById("search-query-verse-container");
            if(!container) { resolve(); return; }
            
            // Watch for results to appear
            _tourObserver = new MutationObserver((mutations) => {
                if (container.children.length > 0) {
                    _tourObserver.disconnect();
                    setTimeout(() => myTour.next(), 500); // Wait for UI to settle
                }
            });
            _tourObserver.observe(container, { childList: true });
            resolve();
        });
    },
    afterStep: () => {
        if(_tourObserver) _tourObserver.disconnect();
    }
  },
  {
    id: "interactive-add",
    title: "Add to Selection",
    text: "Click the '+' button next to a verse to add it to your pending items.",
    target: ".search-query-verse-add-button", // Will target the first one found
    placement: "left",
    hideNext: true,
    allowPointerThrough: true,
    beforeStep: () => {
        return new Promise(resolve => {
            // Wait a tick for DOM
            setTimeout(() => {
                // Attach ONE-TIME global capture listener
                _tourClickListener = (e) => {
                     if(e.target.closest(".search-query-verse-add-button")) {
                         setTimeout(() => myTour.next(), 300);
                     }
                };
                document.addEventListener("click", _tourClickListener, { capture: true, once: true });
                resolve();
            }, 200);
        });
    },
    afterStep: () => {
        if(_tourClickListener) document.removeEventListener("click", _tourClickListener, { capture: true });
    }
  },
  {
    id: "interactive-music",
    title: "Switch to Music",
    text: "Now let's find a song. Click the 'Music' tab.",
    target: "#search-mode-songs",
    placement: "bottom",
    hideNext: true,
    allowPointerThrough: true,
    beforeStep: () => {
        return new Promise(resolve => {
            const btn = document.getElementById("search-mode-songs");
            if(btn) {
                btn.addEventListener("click", () => {
                    setTimeout(() => myTour.next(), 500);
                }, { once: true });
            } else {
                myTour.next();
            }
            resolve();
        });
    }
  },
  {
    id: "interactive-add-song",
    title: "Add a Song",
    text: "Click '+' on a song to add it to your selection.",
    target: "#search-query-song-container", // Target container so tooltip is visible even if empty initially
    placement: "left",
    hideNext: true,
    allowPointerThrough: true,
    beforeStep: () => {
        return new Promise(resolve => {
            // Wait a moment for the container to become ready
            setTimeout(() => {
                 const container = document.getElementById("search-query-song-container");
                 
                 // Attach global capture listener on the container
                 _tourClickListener = (e) => {
                     // Check if the user clicked anything inside the container (row, button, etc)
                     // BUT specifically look for the add action or the row toggle
                     if(e.target.closest(".search-query-verse-add-button") || e.target.closest(".search-query-verse-container")) {
                          setTimeout(() => myTour.next(), 300);
                     }
                 };
                 
                 if(container) {
                    // Use capture: true to intercept before the song card stops prop
                    container.addEventListener("click", _tourClickListener, { capture: true, once: true });
                 } else {
                    // Fallback: Listen on document if container isn't found yet
                    document.addEventListener("click", _tourClickListener, { capture: true, once: true });
                 }
                 
                 resolve();
            }, 500);
        });
    },
    afterStep: () => {
        const container = document.getElementById("search-query-song-container");
        if(container && _tourClickListener) {
            container.removeEventListener("click", _tourClickListener, { capture: true });
        }
        if(_tourClickListener) {
            document.removeEventListener("click", _tourClickListener, { capture: true });
        }
    }
  },
  {
    id: "interactive-flush",
    title: "Drop on Board",
    text: "Click the floating button to drop your selected items onto the canvas.",
    target: "#floating-add-to-board-btn",
    placement: "left",
    hideNext: true,
    allowPointerThrough: true,
    beforeStep: () => {
        return new Promise(resolve => {
            const btn = document.getElementById("floating-add-to-board-btn");
            if(btn && btn.style.display !== 'none') {
                btn.addEventListener("click", () => {
                    setTimeout(() => myTour.next(), 800); // Wait for animation
                }, { once: true });
            } else {
                myTour.next();
            }
            resolve();
        });
    }
  },
  {
    id: "finish",
    title: "You're Ready!",
    text: "Great job! You can now arrange items, connect them, or add notes.",
    placement: "center",
  }
];

// 3. Init Logic
const isWorkspace = !!document.getElementById("workspace");
const currentSteps = isWorkspace ? workspaceSteps : dashboardSteps;
const storageKey = isWorkspace ? "tour_workspace_v2_interactive" : "tour_dashboard_v2";

const myTour = new Tour(currentSteps, {
  onEnd: ({ completed }) => {
    if (completed) {
      localStorage.setItem(storageKey, "true");
    }
  }
});

window.startTour = function() {
  myTour.start();
};

// 4. Auto-start
setTimeout(() => {
  const hasSeen = localStorage.getItem(storageKey);
  // Only auto-start if we are on the workspace
  if (!hasSeen) {
      myTour.start();
  }
}, 2000); // Wait for UI to settle

window.Tour = Tour;