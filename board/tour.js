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
    this._vpSnapshot = null; // <-- ADDED

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
    this.skipBtn.onclick = () => this.end({ completed: true });

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

    // --- ADDED ---
    const ae = document.activeElement;
    const isTyping =
      ae &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.isContentEditable ||
        ae.closest?.("#search-container"));
    // If user is typing, do not hijack Enter/Arrow keys
    if (isTyping) return;
    // --- END ADDED ---

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.end({ completed: false });
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      this.back();
    }
  }

  _focusTrap(e) {
    const isStartTrap = e.target === this.focusTrapStart;
    const focusableElements = [this.skipBtn, this.backBtn, this.nextBtn].filter(
      (el) => !el.disabled
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

  /**
   * NEW HELPER: Pans the .viewport to center a board target.
   * Uses correct math for scaled content.
   */
  async _ensureBoardTargetVisible(target, padding = 16) {
    const viewport = document.querySelector(".viewport");
    const workspace = document.getElementById("workspace");
    if (!target || !viewport || !workspace) return;

    // Current zoom
    const scale = window.BoardAPI?.getScale?.() || 1;

    // Target rect on screen
    const t = target.getBoundingClientRect();
    const vp = viewport.getBoundingClientRect();

    // Compute deltas in SCREEN pixels to center target
    const targetCx = (t.left + t.right) / 2;
    const targetCy = (t.top + t.bottom) / 2;
    const viewCx = (vp.left + vp.right) / 2;
    const viewCy = (vp.top + vp.bottom) / 2;

    const deltaScreenX = targetCx - viewCx;
    const deltaScreenY = targetCy - viewCy;

    // Convert to SCROLL deltas (divide by scale)
    const dx = deltaScreenX / scale;
    const dy = deltaScreenY / scale;

    // Scroll viewport by those world units
    viewport.scrollBy({
      left: dx,
      top: dy,
      behavior: this.motionQuery.matches ? "auto" : "smooth",
    });

    // Wait 2 frames for layout to settle, then reflow highlight
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r))
    );
  }

  /**
   * REPLACED: Ensures target is visible, using the correct
   * scroll/pan method (document vs. viewport).
   */
  async _ensureTargetVisible(step) {
    const target = this._getTarget(step);
    if (!target) return;

    const viewport = document.querySelector(".viewport");
    const isBoardTarget = viewport && viewport.contains(target);

    if (isBoardTarget) {
      await this._ensureBoardTargetVisible(target, step.padding ?? 16);
    } else {
      // OK to use document scroll for regular UI
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

  /**
   * NEW: Robust tooltip positioning with auto-placement.
   */
  _positionTooltip(targetRect, placement) {
    // Ensure tooltip is rendered but off-screen to measure
    this._style(this.tooltip, {
      transform: "",
      top: "-9999px",
      left: "-9999px",
      visibility: "visible",
    });
    const tipRect = this.tooltip.getBoundingClientRect();
    const arrowPad = 25; // Space for the arrow
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

    // Final check to keep it on screen
    if (top < margin) top = margin;
    if (left < margin) left = margin;
    if (top + tipRect.height > vpH - margin)
      top = vpH - tipRect.height - margin;
    if (left + tipRect.width > vpW - margin)
      left = vpW - tipRect.width - margin;

    this._style(this.tooltip, { top: `${top}px`, left: `${left}px` });
    this.tooltip.setAttribute("data-placement", finalPlacement);
  }

  /**
   * CORRECTED: Positions highlight, shields, and tooltip, handling the final step first.
   */
  async _positionCurrentStep() {
    const step = this.steps[this.currentStep];
    if (!step) return;

    const target = this._getTarget(step);
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    // --- SPECIAL CASE: Handle Final Step First ---
    if (step.id === "finish") {
      console.log("Final step detected, applying full screen shield."); // Keep for debugging
      // 1. Force full screen block
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

      // 2. Hide highlight
      this._style(this.highlight, { display: "none" });

      // 3. Center tooltip
      this.tooltip.classList.add("bb-tour-centered");
      this._style(this.tooltip, {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      return; // Exit early for the final step
    }

    // --- REGULAR STEP LOGIC (Non-Final Steps) ---

    // 1. Handle non-target (centered) step (shouldn't happen if not 'finish', but good fallback)
    if (!target) {
      this._style(this.highlight, { display: "none" });
      this.tooltip.classList.add("bb-tour-centered");
      this._style(this.tooltip, {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      // Full screen shield
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

    // 2. We have a target. Ensure it's visible.
    await this._ensureTargetVisible(step);

    // 3. Get pixel-snapped rect for the hole
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const snap = (v) => Math.round(v * dpr) / dpr;
    const pad = (step.padding ?? this.options.padding) | 0;
    const r = target.getBoundingClientRect(); // Re-measure after scroll

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

    // 4. Position Highlight Ring
    this._style(this.highlight, {
      display: "block",
      left: `${hole.left}px`,
      top: `${hole.top}px`,
      width: `${holeWidth}px`,
      height: `${holeHeight}px`,
    });

    // 5. Position Shields based on interactivity
    if (step.allowPointerThrough) {
      // --- Interactive Step (Hole-punch) ---
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
      // --- Non-Interactive Step (Full screen shield) ---
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

    // 6. Position Tooltip
    this.tooltip.classList.remove("bb-tour-centered");
    this._positionTooltip(r, step.placement || "auto"); // Use original rect 'r'
  }

  /**
   * NEW: Made async to handle step hooks and positioning.
   */
  async _setStep(index) {
    // Run cleanup for the *previous* step
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
      this.end({ completed: true }); // No await needed, end() is sync
      return;
    }

    // Fade out old step
    this.highlight.style.opacity = 0;
    this.tooltip.style.opacity = 0;

    // Run setup for the *current* step
    if (typeof step.beforeStep === "function") {
      try {
        await step.beforeStep();
      } catch (e) {
        console.warn("Tour beforeStep error", e);
      }
    }

    // Update content (while invisible)
    this.titleEl.textContent = step.title;
    this.contentEl.textContent = step.text;
    this.stepsEl.textContent = `${index + 1} / ${this.steps.length}`;

    // Update buttons
    this.backBtn.disabled = index === 0;
    this.skipBtn.textContent =
      index === this.steps.length - 1 ? "Finish" : "Skip";
    this.nextBtn.style.display =
      index === this.steps.length - 1 ? "none" : "inline-block";

    if (this.skipBtn.textContent === "Finish") {
      this.skipBtn.classList.add("bb-tour-btn-primary");
      this.skipBtn.onclick = () => this.end({ completed: true });
    } else {
      this.skipBtn.classList.remove("bb-tour-btn-primary");
      this.skipBtn.onclick = () => this.end({ completed: false });
    }

    // Position, scroll, and wait for layout
    await this._positionCurrentStep();

    // Fade in
    this.tooltip.style.visibility = "visible";
    this.highlight.style.opacity = 1;
    this.tooltip.style.opacity = 1;
    this.tooltip.style.transform = this.tooltip.classList.contains(
      "bb-tour-centered"
    )
      ? "translate(-50%, -50%) scale(1)"
      : "";

    // Set focus
    this.nextBtn.style.display !== "none"
      ? this.nextBtn.focus()
      : this.skipBtn.focus();

    this.options.onStep(index, step);
  }

  // --- Public API (now async) ---
  async start(startIndex = 0) {
    if (this.isOpen) return;
    this.isOpen = true;
    this._createElements();
    this._attachListeners();

    // --- ADDED: Snapshot viewport state ---
    const viewport = document.querySelector(".viewport");
    this._vpSnapshot = viewport
      ? {
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
          scale: window.BoardAPI?.getScale?.() || 1,
        }
      : null;
    // --- End Added ---

    this.overlay.style.opacity = 1; // Fade in visual overlay
    await this._setStep(startIndex);
    this.options.onStart();
  }

  async next() {
    if (this.currentStep < this.steps.length - 1) {
      await this._setStep(this.currentStep + 1);
    } else {
      this.end({ completed: true }); // No await needed
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

  /**
   * REPLACED: New end() logic to restore viewport state
   * cleanly after DOM removal.
   */
  end(options = {}) {
    const { completed = false } = options;
    if (!this.isOpen) return; // Prevent double-ends
    this.isOpen = false;

    // 1. Clean up listeners and DOM
    this._removeListeners();
    this._destroyElements(); // Removes overlay, highlight, tooltip, shields

    // Run final afterStep if it exists (and was missed)
    const currentStep = this.steps[this.currentStep];
    if (currentStep && typeof currentStep.afterStep === "function") {
      try {
        // Not awaiting, just firing
        currentStep.afterStep();
      } catch (e) {
        /* ignore */
      }
    }

    // 2. Restore viewport state *after* DOM is gone
    setTimeout(() => {
      const viewport = document.querySelector(".viewport");
      const workspace = document.getElementById("workspace");

      if (viewport && workspace && this._vpSnapshot) {
        // Restore scale
        if (typeof window.BoardAPI?.setScale === "function") {
          window.BoardAPI.setScale(this._vpSnapshot.scale);
        } else {
          // Fallback if API shim failed
          workspace.style.transformOrigin = "top left";
          workspace.style.transform = `scale(${this._vpSnapshot.scale})`;
        }
        // Restore scroll
        viewport.scrollLeft = this._vpSnapshot.left;
        viewport.scrollTop = this._vpSnapshot.top;

        // Finalize layout
        try {
          window.clampScroll?.();
        } catch {}
        try {
          window.updateAllConnections?.();
        } catch {}
      }

      // 3. Clear snapshot and fire callback
      this._vpSnapshot = null;
      try {
        this.options?.onEnd?.({ completed });
      } catch (e) {
        console.error("Tour onEnd callback failed", e);
      }
    }, 0); // Use setTimeout to run after current call stack
  }
}




// ==========================================
// ADD THIS TO THE BOTTOM OF board/tour.js
// ==========================================

// 1. Define your Tour Steps
const bibleBoardSteps = [
  {
    id: "welcome",
    title: "Welcome to BibleBoard",
    text: "This is your digital workspace for studying scripture. Let's take a quick look around.",
    // No target = centers on screen
    placement: "right", 
  },
  {
    id: "sidebar-toggle",
    title: "Collapse Sidebar",
    text: "Click here to collapse and expand the sidebar",
    target: "#sidebar-toggle-btn",
    placement: "bottom",
  },
  {
    id: "new-board",
    title: "Create Boards",
    text: "Click here to create a new canvas for your study.",
    target: "#new-board-btn-sidebar",
    placement: "right",
  },
  {
    id: "search-boards",
    title: "Search & Chat",
    text: "Search through your past notes, verses, and songs to find a specific study",
    target: "#search-board-btn-sidebar",
    placement: "right",
  },
  {
    id: "undo",
    title: "Undo Your Last Action",
    text: "Made a mistake? Tap this button to undo your last action, like adding an item or making a connection. You can also use the shortcut Ctrl+Z.",
    target: "#undo-btn",
    placement: "right",
  },
  {
    id: "redo",
    title: "Redo an Action",
    text: "If you undo too far, tap this button to bring your action back. The shortcut for this is Ctrl+Shift+Z.",
    target: "#redo-btn",
    placement: "right",
  },
  {
    id: "connect",
    title: "Connect Ideas",
    text: "Select a card, then tap this 'Connect' button. Tap another card to draw a line between them.",
    target: "#mobile-action-button",
    placement: "right",
  },
  {
    id: "disconnect",
    title: "Disconnect Ideas",
    text: "Made a mistake? Connecting some ideas just click this and enter 'Disconnect Mode' allowing you to disconnect any connections.",
    target: "#disconnect-mode-btn",
    placement: "right",
  },
  {
    id: "notes",
    title: "Add Notes",
    text: "Tap this 'note' button to add a blank note card to your board. You can type anything you want!",
    target: "#text-action-button",
    placement: "right",
  },
  {
    id: "delete",
    title: "Delete Item",
    text: "Select a item on the bible board, then tap the 'Delete' button to delete the selected item.",
    target: "#delete-action-button",
    placement: "right",
  },
  {
    id: "colors",
    title: "Colors for your connections",
    text: "If you want to add some color to your board select a color and when connecting ideas the 'Connection Lines' will be the selected color.",
    target: "#connection-color-toolbar",
    placement: "left",
  },
  {
    id: "search",
    title: "Search anything",
    text:"Use this search bar to find verses, topics, and songs. It's your quick entry into the board.",
    target: "#search-bar",
    placement: "top",
  },
  {
    id: "choose-version",
    title: "Choose your version",
    text: "Use this menu beside the search bar to choose your Bible version. Searches and added verses use this selection.",
    target: "#version-select",
    placement: "top",
  },
  {
    id: "finish",
    title: "You're Ready!",
    text: "Explore the tools and start connecting verses. Enjoy!",
    target: null, // Center screen
    placement: "center",
  }
];

// 2. Initialize the Tour Instance
const myTour = new Tour(bibleBoardSteps, {
  onEnd: () => {
    console.log("Tour ended");
    // Optional: Save to localStorage so it doesn't show again automatically
    localStorage.setItem("tour_completed", "true");
  }
});

// 3. Expose the start function globally
window.startTour = function() {
  myTour.start();
};

// 4. (Optional) Auto-start if never seen
if (!localStorage.getItem("tour_completed")) {
  // Wait a moment for UI to load
  setTimeout(() => {
     // window.startTour(); // Uncomment this line if you want it to auto-start
  }, 1000);
}

// Attach to window
window.Tour = Tour;