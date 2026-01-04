// board/reader-gestures.js
(() => {
  const STORAGE_KEY = "bb_reader_gestures_seen";
  
  // Hand SVG path (Simple pointer hand)
  const HAND_PATH = "M12,24.5c-0.8-2.6-1.6-4.9-2.2-6.2c-0.8-1.9-2.6-2.9-4.7-1.7c-1.3,0.7-1.9,2.3-1.1,3.7c1.4,2.3,4.4,6.7,6.8,10.6c2.8,4.6,2.2,6.5,5.6,6.5c3.2,0,7.2,0.3,9.5-2.7c3.1-4,1.8-9.7,1.8-9.7l-1.3-12.8c-0.2-2.3-3.3-2.5-3.6-0.2l0.4,6.6c-0.1-2.9-4.2-2.9-4.3,0l0.2,3.3c-0.3-2.4-4.2-2.4-4.4,0l0.2,2.6C14.7,21.7,12.5,21.9,12,24.5z";

  let overlay = null;
  let handWrapper = null;
  let label = null;

  function hasSeenGestures() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch (e) { return false; }
  }

  function markAsSeen() {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
      console.log("[ReaderGestures] Marked as seen.");
    } catch (e) {}
  }

  function createElements() {
    const existing = document.querySelector(".gesture-overlay");
    if(existing) existing.remove();

    overlay = document.createElement("div");
    overlay.className = "gesture-overlay";

    handWrapper = document.createElement("div");
    handWrapper.className = "gesture-hand-wrapper";
    
    // 1. The Ripple (for tap)
    const ripple = document.createElement("div");
    ripple.className = "gesture-ripple";
    handWrapper.appendChild(ripple);

    // 2. The Hold Ring SVG
    const ringSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ringSvg.setAttribute("class", "gesture-hold-ring");
    ringSvg.setAttribute("viewBox", "0 0 80 80");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "gesture-hold-circle");
    circle.setAttribute("cx", "40");
    circle.setAttribute("cy", "40");
    circle.setAttribute("r", "30");
    ringSvg.appendChild(circle);
    handWrapper.appendChild(ringSvg);

    // 3. The Hand SVG
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "gesture-hand-svg");
    svg.setAttribute("viewBox", "0 0 32 40");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", HAND_PATH);
    svg.appendChild(path);
    handWrapper.appendChild(svg);

    // 4. Label
    label = document.createElement("div");
    label.className = "gesture-label";
    
    overlay.appendChild(handWrapper);
    overlay.appendChild(label);
    document.body.appendChild(overlay);
  }

  function moveHandTo(targetEl) {
    if (!targetEl || !handWrapper) return;
    const rect = targetEl.getBoundingClientRect();
    
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);

    handWrapper.style.left = `${centerX - 15}px`; 
    handWrapper.style.top = `${centerY - 5}px`; 
    
    label.style.left = `${centerX}px`;
    label.style.top = `${centerY + 40}px`;
    label.style.transform = "translateX(-50%)"; 
  }

  async function playSequence(targetEl) {
    console.log("[ReaderGestures] Playing sequence on target:", targetEl);
    
    // Phase 1: TAP
    moveHandTo(targetEl);
    handWrapper.style.opacity = "1";
    handWrapper.classList.remove("animate-hold");
    handWrapper.classList.add("animate-tap");
    
    label.textContent = "Tap to add to board";
    label.classList.add("visible");
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Phase 2: HOLD
    label.classList.remove("visible");
    await new Promise(r => setTimeout(r, 300)); 
    
    handWrapper.classList.remove("animate-tap");
    handWrapper.classList.add("animate-hold");
    label.textContent = "Hold for study & info";
    label.classList.add("visible");

    await new Promise(r => setTimeout(r, 4000));

    finish();
  }

  function finish() {
    if (overlay) {
      overlay.style.opacity = "0";
      setTimeout(() => {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 500);
    }
    markAsSeen();
  }

  function startWatcher() {
    if (hasSeenGestures()) {
      console.log("[ReaderGestures] Already seen. Skipping.");
      return;
    }

    console.log("[ReaderGestures] Watcher started... waiting for Scripture Mode.");

    const interval = setInterval(() => {
      // 1. Check if Scripture Mode is ON (Body class from script.js)
      if (!document.body.classList.contains("scripture-mode-on")) {
        return; 
      }

      // 2. Find the reader container
      const reader = document.getElementById("bible-query-reader");
      if (!reader) return;

      // 3. Find visible verses inside the reader
      const verses = reader.querySelectorAll(".search-query-verse-container");
      
      let target = null;
      for (const v of verses) {
        // Must have some height (be visible)
        if (v.offsetHeight > 10) {
          target = v;
          break;
        }
      }

      if (target) {
        console.log("[ReaderGestures] Target found!", target);
        clearInterval(interval);
        createElements();
        
        // Cancel triggers
        const cancel = () => {
          console.log("[ReaderGestures] User interrupted.");
          finish();
          window.removeEventListener("mousedown", cancel);
          window.removeEventListener("touchstart", cancel);
          window.removeEventListener("scroll", cancel);
        };
        
        // Delay attaching cancel listeners slightly so the initial open click doesn't cancel it immediately
        setTimeout(() => {
            window.addEventListener("mousedown", cancel);
            window.addEventListener("touchstart", cancel);
            reader.addEventListener("scroll", cancel);
        }, 500);

        playSequence(target);
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWatcher);
  } else {
    startWatcher();
  }

  // Debugging Helper
  window.resetReaderGestures = () => {
    localStorage.removeItem(STORAGE_KEY);
    console.log("[ReaderGestures] Reset. Open Scripture Mode now.");
    startWatcher();
  };
})();