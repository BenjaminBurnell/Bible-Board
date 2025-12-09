// // board/tour.js
// // Simple one-step onboarding: a glowing curved arrow that draws in
// // and points at the "Open Scripture" button (#scripture-mode-toggle).

// (function () {
//   const STORAGE_KEY = "bb_scripture_arrow_seen_v1";
//   // SVG is 260x260, but we’ll render it smaller
//   const ARROW_VIEWBOX_SIZE = 260;
//   const ARROW_SCALE = 0.3; // 👈 tweak this (0.6, 0.5, etc.) to make smaller/bigger

//   const ARROW_BOX_SIZE = ARROW_VIEWBOX_SIZE * ARROW_SCALE;

//   // Tip of the arrow in *SVG* coords (from your SVG: ~130, 235)
//   const TIP_X = 130;
//   const TIP_Y = 350;

//   function createArrowSvg() {
//     const svgNS = "http://www.w3.org/2000/svg";

//     const svg = document.createElementNS(svgNS, "svg");
//     svg.setAttribute("viewBox", "0 0 260 260");
//     svg.setAttribute("class", "bb-tour-arrow-svg");

//     // === <defs> glow filter (from your SVG, slight rename of id) ===
//     const defs = document.createElementNS(svgNS, "defs");
//     const filter = document.createElementNS(svgNS, "filter");
//     filter.setAttribute("id", "bb-tour-glow");
//     filter.setAttribute("x", "-50%");
//     filter.setAttribute("y", "-50%");
//     filter.setAttribute("width", "200%");
//     filter.setAttribute("height", "200%");

//     const feGaussianBlur = document.createElementNS(svgNS, "feGaussianBlur");
//     feGaussianBlur.setAttribute("in", "SourceGraphic");
//     feGaussianBlur.setAttribute("stdDeviation", "4");
//     feGaussianBlur.setAttribute("result", "blur");

//     const feMerge = document.createElementNS(svgNS, "feMerge");
//     const feMergeNodeBlur = document.createElementNS(svgNS, "feMergeNode");
//     feMergeNodeBlur.setAttribute("in", "blur");
//     const feMergeNodeSource = document.createElementNS(svgNS, "feMergeNode");
//     feMergeNodeSource.setAttribute("in", "SourceGraphic");

//     feMerge.appendChild(feMergeNodeBlur);
//     feMerge.appendChild(feMergeNodeSource);

//     filter.appendChild(feGaussianBlur);
//     filter.appendChild(feMerge);
//     defs.appendChild(filter);
//     svg.appendChild(defs);

//     // Group that uses the glow filter
//     const g = document.createElementNS(svgNS, "g");
//     g.setAttribute("filter", "url(#bb-tour-glow)");
//     svg.appendChild(g);

//     // === Main arrow shape (your exact path) ===
//     const mainD =
//       "M 65 35 L 90 32 L 93 40 L 98 55 L 96 60 L 102 65 " +
//       "Q 120 90 135 120 L 138 125 L 145 130 L 180 120 L 185 125 " +
//       "L 160 160 L 155 168 L 130 235 L 105 168 L 98 160 L 75 125 " +
//       "L 80 120 L 110 132 Q 95 100 78 70 L 75 65 L 80 60 L 75 40 Z";

//     // Filled body (white)
//     const fillPath = document.createElementNS(svgNS, "path");
//     fillPath.setAttribute("class", "bb-tour-arrow-fill");
//     fillPath.setAttribute("d", mainD);
//     g.appendChild(fillPath);

//     // Outline for the draw animation (same shape, stroke only)
//     const outlinePath = document.createElementNS(svgNS, "path");
//     outlinePath.setAttribute("class", "bb-tour-arrow-outline");
//     outlinePath.setAttribute("d", mainD);
//     g.appendChild(outlinePath);

//     // === Cracks (your second path, kept as one multi-segment path) ===
//     const cracksD =
//       "M 85 50 L 90 55 " +
//       "M 125 115 L 130 118 " +
//       "M 148 145 L 152 148 " +
//       "M 115 180 L 118 175 " +
//       "M 130 200 L 130 195 " +
//       "M 95 85 Q 100 90 97 95";

//     const cracksPath = document.createElementNS(svgNS, "path");
//     cracksPath.setAttribute("class", "bb-tour-arrow-crack");
//     cracksPath.setAttribute("d", cracksD);
//     g.appendChild(cracksPath);

//     return svg;
//   }

//   function positionArrow(targetEl, wrapper, label) {
//     const rect = targetEl.getBoundingClientRect();

//     const targetCenterX = rect.left + rect.width / 2;
//     const targetCenterY = rect.top + rect.height / 2;

//     // Scale the tip position from SVG space into rendered pixel space
//     const tipX = TIP_X * ARROW_SCALE;
//     const tipY = TIP_Y * ARROW_SCALE;

//     const left = targetCenterX - tipX;
//     const top = targetCenterY - tipY;

//     wrapper.style.left = `${left}px`;
//     wrapper.style.top = `${top}px`;

//     // Label near the tail (top-ish area of the box)
//     const labelOffsetX = -60;
//     const labelOffsetY = -20;
//     label.style.left = `${left + labelOffsetX}px`;
//     label.style.top = `${top + labelOffsetY}px`;
//   }

//   function showArrow(targetEl) {
//     const overlay = document.createElement("div");
//     overlay.className = "bb-tour-arrow-overlay";

//     const wrapper = document.createElement("div");
//     wrapper.className = "bb-tour-arrow-wrapper";
//     wrapper.style.width = `${ARROW_BOX_SIZE}px`;
//     wrapper.style.height = `${ARROW_BOX_SIZE}px`;

//     const svg = createArrowSvg();
//     wrapper.appendChild(svg);

//     const label = document.createElement("div");
//     label.className = "bb-tour-arrow-label";
//     label.textContent = "Tap here to open Scripture Mode.";

//     overlay.appendChild(wrapper);
//     overlay.appendChild(label);
//     document.body.appendChild(overlay);

//     function reposition() {
//       if (!document.body.contains(targetEl)) return;
//       positionArrow(targetEl, wrapper, label);
//     }

//     // Position now + on resize/scroll
//     reposition();
//     window.addEventListener("resize", reposition);
//     window.addEventListener("scroll", reposition, { passive: true });

//     function dismiss() {
//       if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
//       window.removeEventListener("resize", reposition);
//       window.removeEventListener("scroll", reposition);
//       try {
//         localStorage.setItem(STORAGE_KEY, "1");
//       } catch {
//         // ignore
//       }
//     }

//     // Hide the arrow when they actually open Scripture Mode
//     targetEl.addEventListener("click", dismiss, { once: true });

//     return { overlay, dismiss };
//   }

//   function maybeShowArrow() {
//     // Only show once per browser unless manually reset
//     try {
//       if (localStorage.getItem(STORAGE_KEY) === "1") return;
//     } catch {
//       // ignore storage failures
//     }

//     const targetEl = document.getElementById("scripture-mode-toggle");
//     if (!targetEl) return;

//     // Small delay to let layout settle
//     setTimeout(() => {
//       if (!document.body.contains(targetEl)) return;
//       showArrow(targetEl);
//     }, 400);
//   }

//   // Auto-run when the board page is ready
//   if (document.readyState === "loading") {
//     document.addEventListener("DOMContentLoaded", maybeShowArrow);
//   } else {
//     maybeShowArrow();
//   }

//   // Optional global API if you ever want to retrigger from the console
//   window.BibleBoardScriptureArrowTour = {
//     start() {
//       try {
//         localStorage.removeItem(STORAGE_KEY);
//       } catch {
//         // ignore
//       }
//       maybeShowArrow();
//     },
//     reset() {
//       try {
//         localStorage.removeItem(STORAGE_KEY);
//       } catch {
//         // ignore
//       }
//     },
//   };
// })();
