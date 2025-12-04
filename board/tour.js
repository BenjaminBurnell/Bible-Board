// board/tour.js
// Lightweight onboarding for Scripture Mode in BibleBoard.
// Replaces the old multi-page tour with a small, tap-through guide.

(function () {
  const STORAGE_KEY = "bb_scripture_onboarding_v1";

  // Five simple steps focused on Scripture mode.
  const STEPS = [
    {
      id: "open-scripture",
      target: "#scripture-mode-toggle",
      title: "Open Scripture Mode",
      text: "Tap here to open Scripture Mode and read the Bible alongside your board.",
      placement: "top",
    },
    {
      id: "change-passage",
      target: "#bible-query-reader-header",
      title: "Change passage & version",
      text: "Use this header to change the book, chapter, and Bible version you’re reading.",
      placement: "bottom",
    },
    {
      id: "select-verses",
      target: "#bible-query-reader-content",
      title: "Select verses",
      text: "Tap verses here to select a range you want to work with on your board.",
      placement: "bottom",
    },
    {
      id: "add-to-board",
      target: "#bible-reader-add-to-board-btn",
      title: "Add to your board",
      text: "When you’re ready, tap this button to add the selected verses onto your board.",
      placement: "top",
    },
    {
      id: "go-deeper",
      target: "#bible-query-reader-content",
      title: "Go deeper on a verse",
      text: "Hold on a verse to open the deeper study view with interlinear and cross-references.",
      placement: "bottom",
    },
  ];

  let state = {
    active: false,
    index: 0,
    overlay: null,
    highlight: null,
    tooltip: null,
    titleEl: null,
    textEl: null,
    counterEl: null,
    skipBtn: null,
  };

  function createUi() {
    if (state.overlay) return;

    const overlay = document.createElement("div");
    overlay.id = "bb-onboarding-overlay";

    const highlight = document.createElement("div");
    highlight.id = "bb-onboarding-highlight";

    const tooltip = document.createElement("div");
    tooltip.id = "bb-onboarding-tooltip";

    const bubble = document.createElement("div");
    bubble.className = "bb-onboarding-bubble";

    const arrow = document.createElement("div");
    arrow.className = "bb-onboarding-arrow";
    bubble.appendChild(arrow);

    const body = document.createElement("div");
    body.className = "bb-onboarding-body";

    const titleEl = document.createElement("div");
    titleEl.className = "bb-onboarding-title";

    const textEl = document.createElement("div");
    textEl.className = "bb-onboarding-text";

    body.appendChild(titleEl);
    body.appendChild(textEl);
    bubble.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "bb-onboarding-footer";

    const counterEl = document.createElement("div");
    counterEl.className = "bb-onboarding-counter";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "bb-onboarding-skip";
    skipBtn.textContent = "Skip";

    footer.appendChild(counterEl);
    footer.appendChild(skipBtn);

    tooltip.appendChild(bubble);
    tooltip.appendChild(footer);

    overlay.appendChild(highlight);
    overlay.appendChild(tooltip);
    document.body.appendChild(overlay);

    // Click anywhere (except Skip) to advance
    overlay.addEventListener("click", (ev) => {
      if (!state.active) return;
      if (ev.target === skipBtn) return;
      ev.stopPropagation();
      ev.preventDefault();
      nextStep();
    });

    skipBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      endTour(true);
    });

    state.overlay = overlay;
    state.highlight = highlight;
    state.tooltip = tooltip;
    state.titleEl = titleEl;
    state.textEl = textEl;
    state.counterEl = counterEl;
    state.skipBtn = skipBtn;
  }

  function positionForStep(step) {
    const { highlight, tooltip } = state;
    if (!highlight || !tooltip) return;

    const targetEl = step.target
      ? document.querySelector(step.target)
      : null;

    const rect = targetEl && targetEl.getBoundingClientRect
      ? targetEl.getBoundingClientRect()
      : null;

    const hasTarget = rect && rect.width > 0 && rect.height > 0;

    tooltip.classList.remove("bb-placement-top", "bb-placement-bottom");

    if (hasTarget) {
      const padding = 8;

      // Highlight ring
      highlight.style.display = "block";
      highlight.style.left = rect.left - padding + "px";
      highlight.style.top = rect.top - padding + "px";
      highlight.style.width = rect.width + padding * 2 + "px";
      highlight.style.height = rect.height + padding * 2 + "px";

      // Tooltip
      tooltip.style.display = "block";

      const centerX = rect.left + rect.width / 2;
      tooltip.style.left = centerX + "px";
      tooltip.style.transform = "translateX(-50%)";

      const placement = step.placement === "top" ? "top" : "bottom";
      tooltip.classList.add(
        placement === "top" ? "bb-placement-top" : "bb-placement-bottom"
      );

      // We need a measurement after contents are set
      const tooltipRect = tooltip.getBoundingClientRect();
      let top;
      if (placement === "top") {
        // Tooltip above target
        top = rect.top - tooltipRect.height - 12;
        if (top < 12) top = 12;
      } else {
        // Tooltip below target
        top = rect.bottom + 12;
        if (top + tooltipRect.height > window.innerHeight - 12) {
          top = window.innerHeight - 12 - tooltipRect.height;
        }
      }
      tooltip.style.top = top + "px";
    } else {
      // No valid target – center tooltip, hide highlight
      highlight.style.display = "none";
      tooltip.style.display = "block";
      tooltip.style.left = "50%";
      tooltip.style.top = "50%";
      tooltip.style.transform = "translate(-50%, -50%)";
    }
  }

  function showStep(index) {
    if (index < 0 || index >= STEPS.length) {
      endTour(true);
      return;
    }

    state.index = index;
    const step = STEPS[index];

    state.titleEl.textContent = step.title || "";
    state.textEl.textContent = step.text || "";
    state.counterEl.textContent = `${index + 1} of ${STEPS.length}`;

    positionForStep(step);
  }

  function nextStep() {
    showStep(state.index + 1);
  }

  function startTour() {
    if (state.active) return;
    createUi();
    state.active = true;
    state.overlay.style.display = "block";
    showStep(0);
  }

  function endTour(markSeen) {
    if (!state.active) return;
    state.active = false;

    if (state.overlay) {
      state.overlay.style.display = "none";
    }
    if (markSeen) {
      try {
        localStorage.setItem(STORAGE_KEY, "done");
      } catch (err) {
        console.warn("Failed to persist onboarding state:", err);
      }
    }
  }

  // Auto-start the tour the first time Scripture Mode is opened.
  function setupAutoStart() {
    document.addEventListener("DOMContentLoaded", () => {
      try {
        if (localStorage.getItem(STORAGE_KEY) === "done") return;
      } catch {
        // ignore
      }

      const btn = document.getElementById("scripture-mode-toggle");
      if (!btn) return;

      btn.addEventListener(
        "click",
        () => {
          // Wait a bit for the reader to animate in.
          setTimeout(() => {
            try {
              if (localStorage.getItem(STORAGE_KEY) === "done") return;
            } catch {
              // ignore
            }
            startTour();
          }, 500);
        },
        { once: true }
      );
    });
  }

  setupAutoStart();

  // Expose a small API for debugging / manual triggering.
  window.BibleBoardScriptureTour = {
    start: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      startTour();
    },
    skip: () => endTour(true),
    reset: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    },
  };
})();
