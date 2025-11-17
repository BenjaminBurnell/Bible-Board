// ========== DOM ELEMENTS ==========
const body                      = document.querySelector("body");
const loaderSection             = document.getElementById("loader-section");
const loaderLogoImage           = document.getElementById("loader-logo-image");
const pageContainer             = document.getElementById("page-container");
const navbar                    = document.getElementById("nav-bar");
const getStartedButton          = document.querySelectorAll(".action-button")[1];
const mainSectionContainer      = document.querySelector(".section.main");
const mainSectionHeaderText     = document.getElementById("main-section-header-text");
const mainSectionSubText        = document.getElementById("main-section-sub-text");
const sectionDemoVideo          = document.querySelector(".section.demo-video");
const sectionHeaderText         = document.getElementById("section-header-text");
const sectionUsedBy             = document.querySelector(".section.used-by");

const featuresSectionTextHeader   = document.getElementById("features-section-text-header");
const featuresSectionSubHeader    = document.getElementById("features-section-subheader");
const featuresSectionImagesVideos = document.getElementById("features-section-images-videos");

const testimonialsSection   = document.querySelector(".section.testimonials");
const testimonialsContainer = document.getElementById("testimonials-posts-container");
const testimonialCards      = testimonialsContainer
  ? testimonialsContainer.querySelectorAll(".testimonial-container")
  : [];

// NEW: Testimonials header/subheader elements
const testimonialsHeaderText = document.getElementById("testimonials-section-text-header");
const testimonialsSubHeader  = document.getElementById("testimonials-section-subheader");


// ========== WORDS DATA (FEATURES HEADER + SUBHEADER) ==========
let headerWordElements = [];
let subWordElements    = [];

// NEW: Testimonials word arrays
let testimonialsHeaderWordElements = [];
let testimonialsSubWordElements    = [];

if (featuresSectionTextHeader) {
  const headerWords = featuresSectionTextHeader.textContent.split(" ");
  featuresSectionTextHeader.textContent = "";

  for (let i = 0; i < headerWords.length; i++) {
    const word = document.createElement("span");
    word.textContent = headerWords[i] + " ";
    word.style.opacity = "0";
    word.id = "word-header-" + i;
    featuresSectionTextHeader.appendChild(word);
    headerWordElements.push(word);
  }
}

if (featuresSectionSubHeader) {
  const subWords = featuresSectionSubHeader.textContent.split(" ");
  featuresSectionSubHeader.textContent = "";

  for (let j = 0; j < subWords.length; j++) {
    const subWord = document.createElement("span");
    subWord.textContent = subWords[j] + " ";
    subWord.style.opacity = "0";
    subWord.id = "word-subheader-" + j;
    featuresSectionSubHeader.appendChild(subWord);
    subWordElements.push(subWord);
  }
}

// NEW: Split testimonials header + subheader into word spans (same pattern)
if (testimonialsHeaderText) {
  const headerWords = testimonialsHeaderText.textContent.split(" ");
  testimonialsHeaderText.textContent = "";

  for (let i = 0; i < headerWords.length; i++) {
    const word = document.createElement("span");
    word.textContent = headerWords[i] + " ";
    word.style.opacity = "0";
    word.id = "testimonials-word-header-" + i;
    testimonialsHeaderText.appendChild(word);
    testimonialsHeaderWordElements.push(word);
  }
}

if (testimonialsSubHeader) {
  const subWords = testimonialsSubHeader.textContent.split(" ");
  testimonialsSubHeader.textContent = "";

  for (let j = 0; j < subWords.length; j++) {
    const subWord = document.createElement("span");
    subWord.textContent = subWords[j] + " ";
    subWord.style.opacity = "0";
    subWord.id = "testimonials-word-subheader-" + j;
    testimonialsSubHeader.appendChild(subWord);
    testimonialsSubWordElements.push(subWord);
  }
}


// ========== NAVBAR / SCROLL EFFECTS ==========
const START_FADE   = 50;   // px
const END_FADE     = 250;  // px
// 0 = demo, 1 = used-by, 2 = features text, 3 = features images/videos, 4 = testimonials text
let loadedSections = [false, false, false, false, false];

let lastScrollTop = 0;

window.addEventListener("scroll", () => {
  const windowHeight = window.innerHeight;

  const DEMO_START_FADE = windowHeight / 3;
  const DEMO_END_FADE   = (windowHeight / 3) + 100;

  const DEMO_SECTION_HEIGHT = sectionDemoVideo.getBoundingClientRect().height;

  const USEDBY_START_FADE = (windowHeight / 3) + DEMO_SECTION_HEIGHT;
  const USEDBY_END_FADE   = USEDBY_START_FADE + 100;

  const SECTION_USED_BY_SECTION_HEIGHT = sectionUsedBy.getBoundingClientRect().height;

  const FEATURES_START_FADE = USEDBY_START_FADE + SECTION_USED_BY_SECTION_HEIGHT;
  const FEATURES_END_FADE   = FEATURES_START_FADE + 250;

  // --- bottom fade settings ---
  const doc         = document.documentElement;
  const maxScroll   = doc.scrollHeight - (doc.clientHeight + 150); // max scrollTop
  const FOOTER_FADE_RANGE = 300; // px of fade near bottom
  const FOOTER_START_FADE = Math.max(START_FADE, maxScroll - FOOTER_FADE_RANGE);
  const FOOTER_END_FADE   = maxScroll;

  if (!navbar) return;

  const scrollTop =
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0;

  const scrollingDown = scrollTop > lastScrollTop;

  // ========== NAVBAR BACKGROUND/BLUR ==========
  // Top fade-in factor
  const topTRaw = (scrollTop - START_FADE) / (END_FADE - START_FADE);
  const tTop    = Math.min(Math.max(topTRaw, 0), 1); // 0..1

  // Bottom fade-out factor
  const bottomTDen = (FOOTER_END_FADE - FOOTER_START_FADE) || 1;
  const bottomTRaw = (scrollTop - FOOTER_START_FADE) / bottomTDen;
  const tBottom    = Math.min(Math.max(bottomTRaw, 0), 1); // 0..1

  // Combined strength: fade in from top, fade out near bottom
  const navStrength = tTop * (1 - tBottom); // 0..1
  const getStartedOpacity     = 1 * navStrength;

  if (navStrength <= 0) {
    // Fully transparent
    navbar.style.background     = "transparent";
    navbar.style.backdropFilter = "none";
    navbar.style.borderBottom   = "none";
    getStartedButton.style.opacity = "0"
  } else {
    const bgOpacity             = 0.5 * navStrength;
    const blurAmountRem         = 1.5 * navStrength;
    const borderOpacity         = 0.8 * navStrength;

    navbar.style.background     = `rgba(23, 23, 23, ${bgOpacity})`;
    navbar.style.backdropFilter = `blur(${blurAmountRem}rem)`;
    navbar.style.borderBottom   = `1px solid rgba(47, 47, 47, ${borderOpacity})`;
  }

  if(scrollTop > windowHeight) {
        getStartedButton.style.opacity = getStartedOpacity
    } else {
        getStartedButton.style.opacity = "1"
    }

  // ========== DEMO SECTION FADE-IN ==========
  if (scrollTop >= DEMO_START_FADE && scrollTop <= DEMO_END_FADE && !loadedSections[0]) {
    sectionDemoVideo.style.opacity = (scrollTop - DEMO_START_FADE) / 100;
    sectionDemoVideo.style.scale   = 0.9 + ((scrollTop - DEMO_START_FADE) / 1000);
  } else if (scrollTop <= DEMO_START_FADE && !loadedSections[0]) {
    sectionDemoVideo.style.scale   = 0.9;
    sectionDemoVideo.style.opacity = 0;
  } else if (scrollTop >= DEMO_END_FADE && !loadedSections[0]) {
    sectionDemoVideo.style.scale   = 1;
    sectionDemoVideo.style.opacity = 1;
    loadedSections[0] = true;
  }

  // ========== USED-BY SECTION FADE-IN ==========
  if (scrollTop >= USEDBY_START_FADE && scrollTop <= USEDBY_END_FADE && !loadedSections[1]) {
    sectionUsedBy.style.opacity = (scrollTop - USEDBY_START_FADE) / 100;
    sectionUsedBy.style.scale   = 0.9 + ((scrollTop - USEDBY_START_FADE) / 1000);
  } else if (scrollTop <= USEDBY_START_FADE && !loadedSections[1]) {
    sectionUsedBy.style.scale   = 0.9;
    sectionUsedBy.style.opacity = 0;
  } else if (scrollTop >= USEDBY_END_FADE && !loadedSections[1]) {
    sectionUsedBy.style.scale   = 1;
    sectionUsedBy.style.opacity = 1;
    loadedSections[1] = true;
  }

  // ========== FEATURES HEADER & SUBHEADER WORD-BY-WORD FADE ==========
  if (featuresSectionTextHeader && headerWordElements.length) {
    if (loadedSections[2]) {
      headerWordElements.forEach((wordEl) => (wordEl.style.opacity = 1));
      subWordElements.forEach((wordEl) => (wordEl.style.opacity = 1));
    } else {
      const headerRect   = featuresSectionTextHeader.getBoundingClientRect();
      const headerCenter = headerRect.top + headerRect.height / 2;

      const startY       = windowHeight * 0.9; // header center here → progress 0
      const endY         = windowHeight * 0.35; // header center here → progress 1

      let progress = (startY - headerCenter) / (startY - endY);
      if (progress < 0) progress = 0;
      if (progress > 1) progress = 1;

      const totalHeaderWords = headerWordElements.length;
      const totalSubWords    = subWordElements.length;
      const totalWordsAll    = totalHeaderWords + totalSubWords;
      const visibleAll       = progress * totalWordsAll;

      headerWordElements.forEach((wordEl, idx) => {
        const local = visibleAll - idx;
        let opacity;
        if (local <= 0) opacity = 0;
        else if (local >= 1) opacity = 1;
        else opacity = local;
        wordEl.style.opacity = opacity;
        wordEl.style.marginTop = 15 - (opacity * 15)
      });

      subWordElements.forEach((wordEl, idx) => {
        const local = visibleAll - (totalHeaderWords + idx);
        let opacity;
        if (local <= 0) opacity = 0;
        else if (local >= 1) opacity = 1;
        else opacity = local;
        wordEl.style.opacity = opacity;
        wordEl.style.marginTop = 15 - (opacity * 15)
      });

      if (progress >= 1) {
        loadedSections[2] = true;
        headerWordElements.forEach((wordEl) => (wordEl.style.opacity = 1, wordEl.style.marginTop = 0));
        subWordElements.forEach((wordEl) => (wordEl.style.opacity = 1, wordEl.style.marginTop = 0));
      }
    }
  }

  // ========== TESTIMONIALS HEADER & SUBHEADER WORD-BY-WORD FADE ==========
  if (testimonialsHeaderText && testimonialsHeaderWordElements.length) {
    if (loadedSections[4]) {
      testimonialsHeaderWordElements.forEach((wordEl) => {
        wordEl.style.opacity   = 1;
        wordEl.style.marginTop = 0;
      });
      testimonialsSubWordElements.forEach((wordEl) => {
        wordEl.style.opacity   = 1;
        wordEl.style.marginTop = 0;
      });
    } else {
      const headerRect   = testimonialsHeaderText.getBoundingClientRect();
      const headerCenter = headerRect.top + headerRect.height / 2;

      const startY = windowHeight * 0.9;  // header center here → progress 0
      const endY   = windowHeight * 0.35; // header center here → progress 1

      let progress = (startY - headerCenter) / (startY - endY);
      if (progress < 0) progress = 0;
      if (progress > 1) progress = 1;

      const totalHeaderWords = testimonialsHeaderWordElements.length;
      const totalSubWords    = testimonialsSubWordElements.length;
      const totalWordsAll    = totalHeaderWords + totalSubWords;
      const visibleAll       = progress * totalWordsAll;

      testimonialsHeaderWordElements.forEach((wordEl, idx) => {
        const local = visibleAll - idx;
        let opacity;
        if (local <= 0) opacity = 0;
        else if (local >= 1) opacity = 1;
        else opacity = local;
        wordEl.style.opacity   = opacity;
        wordEl.style.marginTop = 15 - (opacity * 15);
      });

      testimonialsSubWordElements.forEach((wordEl, idx) => {
        const local = visibleAll - (totalHeaderWords + idx);
        let opacity;
        if (local <= 0) opacity = 0;
        else if (local >= 1) opacity = 1;
        else opacity = local;
        wordEl.style.opacity   = opacity;
        wordEl.style.marginTop = 15 - (opacity * 15);
      });

      if (progress >= 1) {
        loadedSections[4] = true;
        testimonialsHeaderWordElements.forEach((wordEl) => {
          wordEl.style.opacity   = 1;
          wordEl.style.marginTop = 0;
        });
        testimonialsSubWordElements.forEach((wordEl) => {
          wordEl.style.opacity   = 1;
          wordEl.style.marginTop = 0;
        });
      }
    }
  }

  // ========== TESTIMONIALS PARALLAX (SCROLL-HANDLER VERSION) ==========
  if (testimonialsSection && testimonialCards.length) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

    // On mobile: disable parallax + reset any transforms
    if (viewportWidth < 775) {
      testimonialCards.forEach((card) => {
        card.style.transform = "";
      });
    } else {
      const sectionRect     = testimonialsSection.getBoundingClientRect();
      const viewportHeight  = windowHeight;

      const sectionCenter   = sectionRect.top + sectionRect.height / 2;
      const viewportCenter  = viewportHeight / 2;

      // distance from center, normalized so around [-1, 1]
      let t = (sectionCenter - viewportCenter) / (viewportHeight * 0.5);
      if (t < -1) t = -1;
      if (t >  1) t =  1;

      // How strong the parallax is (tweak this to taste)
      const PARALLAX_STRENGTH = 500; // px; try 260–300 for wilder movement

      testimonialCards.forEach((card) => {
        const styles   = getComputedStyle(card);
        const xOffset  = styles.getPropertyValue("--x-offset") || "0px";
        const depthVal = parseFloat(styles.getPropertyValue("--depth")) || 0;

        // Farther "back" = slightly slower motion (so they don't all move the same)
        const depthAmount = 1 - Math.min(Math.abs(depthVal), 1) * 0.5; // 1 → 0.5

        const translateY = -t * PARALLAX_STRENGTH * depthAmount;

        card.style.transform = `translate3d(${xOffset}, ${translateY}px, 0)`;
      });
    }
  }


  // ========== FEATURES IMAGES/VIDEOS FADE-IN ==========
  if (featuresSectionImagesVideos) {
    if (loadedSections[3]) {
      featuresSectionImagesVideos.style.opacity = "1";
      featuresSectionImagesVideos.style.scale   = "1";
    } else if (loadedSections[1]) {
      if (scrollTop >= FEATURES_START_FADE && scrollTop <= FEATURES_END_FADE) {
        const progress = (scrollTop - FEATURES_START_FADE) / (FEATURES_END_FADE - FEATURES_START_FADE);
        const clamped  = Math.min(Math.max(progress, 0), 1);

        const opacity = clamped;
        const scale   = 0.9 + 0.1 * clamped;

        featuresSectionImagesVideos.style.opacity = opacity.toString();
        featuresSectionImagesVideos.style.scale   = scale.toString();
      } else if (scrollTop <= FEATURES_START_FADE) {
        featuresSectionImagesVideos.style.opacity = "0";
        featuresSectionImagesVideos.style.scale   = "0.9";
      } else if (scrollTop >= FEATURES_END_FADE) {
        featuresSectionImagesVideos.style.opacity = "1";
        featuresSectionImagesVideos.style.scale   = "1";
        loadedSections[3] = true;
      }
    }
  }

  lastScrollTop = scrollTop;
});


// ========== LOADER SEQUENCE ==========
function loadPage() {
  let timeframe = 1000;

  setTimeout(function () {
    document.documentElement.scrollTo(0, 0);
    loaderLogoImage.style.transition = ".25s";
    loaderLogoImage.style.opacity    = "1";
  }, timeframe);

  timeframe += 1000;

  setTimeout(function () {
    loaderLogoImage.style.opacity = "0";
  }, timeframe);

  timeframe += 250;

  setTimeout(function () {
    loaderLogoImage.style.display = "none";
  }, timeframe);

  setTimeout(function () {
    pageContainer.style.transition = ".5s";
    pageContainer.style.opacity    = "1";
  }, timeframe);

  timeframe += 500;

  setTimeout(function () {
    mainSectionContainer.style.transition = ".5s";
    mainSectionContainer.style.marginTop  = "0px";
    mainSectionContainer.style.opacity    = "1";
  }, timeframe);

  timeframe += 500;

  setTimeout(function () {
    navbar.style.transition = ".5s";
    navbar.style.marginTop  = "0px";
    navbar.style.opacity    = "1";
    body.style.overflowY    = "scroll";
  }, timeframe);

  timeframe += 250;

  setTimeout(function () {
    mainSectionHeaderText.style.transition = ".5s";
    mainSectionHeaderText.style.opacity    = "1";
    mainSectionHeaderText.style.transform  = "rotateX(0deg)";
  }, timeframe);

  timeframe += 150;

  setTimeout(function () {
    mainSectionSubText.style.transition      = ".5s";
    mainSectionSubText.style.opacity         = "1";
    mainSectionSubText.style.transform       = "rotateX(0deg)";
  }, timeframe);

  timeframe += 500;

  setTimeout(function () {
    console.log("Fully Loaded.");
    sectionDemoVideo.style.transition   = "0s";
    loaderLogoImage.style.transition    = "0s";
    pageContainer.style.transition      = "0s";
    mainSectionContainer.style.transition = "0s";
    mainSectionHeaderText.style.transition = "0s";
    mainSectionSubText.style.transition   = "0s";
    navbar.style.transition             = "0s";
  }, timeframe);
}

// ========== CUSTOM VIDEO PLAYER ==========
document.addEventListener("DOMContentLoaded", () => {
  const video            = document.getElementById("demo-video");
  const playBtn          = document.querySelector(".video-control-btn.primary[data-action='toggle']");
  const playVideoOverlay = document.getElementById("play-video-overlay");
  const playIconMobile   = document.getElementById("play-icon-mobile");
  const progressTrack    = document.querySelector(".demo-video-progress-track");
  const progressFill     = document.querySelector(".demo-video-progress-fill");
  const timeLabel        = document.getElementById("demo-video-time");
  const playIconSpan     = document.getElementById("demo-play-icon");
  const demoContainer    = document.querySelector(".demo-video-container");
  const videoControls    = document.querySelector(".demo-video-controls");

  if (
    !video ||
    !playBtn ||
    !progressTrack ||
    !progressFill ||
    !timeLabel ||
    !playIconSpan ||
    !playVideoOverlay ||
    !demoContainer ||
    !videoControls
  ) {
    return;
  }

  function formatTime(sec) {
    if (isNaN(sec)) return "0:00";
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function updatePlayIcon() {
    if (video.paused) {
      playIconSpan.textContent   = "play_arrow";
      playIconMobile.textContent = "play_arrow";
    } else {
      playIconSpan.textContent   = "pause";
      playIconMobile.textContent = "pause";
    }
  }

  function updateProgress() {
    if (!video.duration) return;
    const percent = (video.currentTime / video.duration) * 100;
    progressFill.style.width = `${percent}%`;
    timeLabel.textContent    = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }

  const hasFinePointer =
    window.matchMedia && window.matchMedia("(pointer: fine)").matches;

  let hideControlsTimeout = null;
  const HIDE_DELAY = 2000; // ms after last movement while playing

  function showControls() {
    if (!hasFinePointer) return;

    // If paused: always show controls, never hide them
    if (video.paused) {
      demoContainer.classList.add("controls-visible");
      if (hideControlsTimeout) {
        clearTimeout(hideControlsTimeout);
        hideControlsTimeout = null;
      }
      return;
    }

    // If playing: show now, schedule hide
    demoContainer.classList.add("controls-visible");
    if (hideControlsTimeout) clearTimeout(hideControlsTimeout);
    hideControlsTimeout = setTimeout(() => {
      if (!video.paused) {
        demoContainer.classList.remove("controls-visible");
      }
    }, HIDE_DELAY);
  }

  // Play / pause via overlay (mobile + click on video)
  playVideoOverlay.addEventListener("click", () => {
    if (video.paused) {
      video.play();
      playVideoOverlay.style.zIndex         = "1";
      playVideoOverlay.style.opacity        = "0";
      playVideoOverlay.style.gap            = "0px";
      playVideoOverlay.style.backdropFilter = "blur(0rem)";
    } else {
      video.pause();
      playVideoOverlay.style.zIndex         = "5";
      playVideoOverlay.style.opacity        = "1";
      playVideoOverlay.style.gap            = "5px";
      playVideoOverlay.style.backdropFilter = "blur(1.5rem)";
    }
  });

  // Play / pause button (desktop controls)
  playBtn.addEventListener("click", () => {
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  });

  video.addEventListener("play", () => {
    updatePlayIcon();
    showControls();
  });

  video.addEventListener("pause", () => {
    updatePlayIcon();
    showControls(); // paused branch keeps them visible
  });

  video.addEventListener("timeupdate", updateProgress);
  video.addEventListener("loadedmetadata", updateProgress);

  // Click progress to seek
  progressTrack.addEventListener("click", (e) => {
    if (!video.duration) return;
    const rect   = progressTrack.getBoundingClientRect();
    const ratio  = (e.clientX - rect.left) / rect.width;
    const clamped = Math.min(Math.max(ratio, 0), 1);
    video.currentTime = clamped * video.duration;
  });

  // Desktop hover behavior (YouTube-style)
  if (hasFinePointer) {
    demoContainer.addEventListener("mousemove", () => {
      showControls();
    });

    demoContainer.addEventListener("mouseleave", () => {
      if (video.paused) return; // paused: keep visible
      demoContainer.classList.remove("controls-visible");
      if (hideControlsTimeout) {
        clearTimeout(hideControlsTimeout);
        hideControlsTimeout = null;
      }
    });
  }

  // Initialize icon, time label, and starting visibility
  updatePlayIcon();
  updateProgress();
  showControls(); // start with controls visible while paused on desktop

  // Initialize features fan layout on load
  try {
    changeSelectedImage();
  } catch (e) {
    console.warn("changeSelectedImage init failed:", e);
  }
});

// ========== SMOOTH SCROLL TO ELEMENT ==========
function scrollToElement(selector) {
  const el = typeof selector === "string" ? document.querySelector(selector) : selector;

  if (!el) {
    console.warn("scrollToElement: element not found for", selector);
    return;
  }

  const navOffset = 80; // px
  const rect      = el.getBoundingClientRect();
  const absoluteTop = rect.top + window.scrollY;
  const targetY   = absoluteTop - navOffset;

  window.scrollTo({
    top: targetY,
    behavior: "smooth",
  });
}

// ========== FEATURES CAROUSEL ==========
let currentImageIndex = 0;

function changeSelectedImage(direction, user = false) {
  const containers      = document.querySelectorAll(".features-section-image-container");
  const videoContainers = document.querySelectorAll(".features-section-example-content-container");
  const videos          = document.querySelectorAll(".features-section-example-video");

  if (!containers.length) return;

  if (direction === "r") {
    currentImageIndex = (currentImageIndex + 1) % containers.length;
  } else if (direction === "l") {
    currentImageIndex = (currentImageIndex - 1 + containers.length) % containers.length;
  }

  containers.forEach((container, index) => {
    const distanceFromCurrent = index - currentImageIndex;

    if (distanceFromCurrent === 0) {
      container.style.transition = ".5s";
      container.style.transform  = "rotate(0deg) translate(-50%)";
      container.style.scale      = "1";
      container.style.zIndex     = "105";
      container.style.opacity    = "1";

      if (videoContainers[index]) {
        videoContainers[index].style.boxShadow =
          "0px 5px 15px 2px rgba(0, 0, 0, 0.25)";
      }
    } else {
      const degreesToRotate = distanceFromCurrent * 7;
      const scaleToChange   = 1 - (Math.abs(distanceFromCurrent) / 20);

      container.style.transition = ".5s";
      container.style.opacity    = "0.5";
      container.style.transform  = `rotate(${degreesToRotate}deg) translate(-50%)`;
      container.style.scale      = `${scaleToChange}`;

      if (distanceFromCurrent < 0) {
        container.style.zIndex = `${containers.length - index}`;
      } else {
        container.style.zIndex = `${index - distanceFromCurrent * -1}`;
      }

      if (videos[index]) {
        videos[index].play();
      }

      if (videoContainers[index]) {
        videoContainers[index].style.boxShadow = "none";
      }
    }
  });

  if (typeof recentlyUsed !== "undefined") {
    recentlyUsed = !!user;
  }
}


// ========== TESTIMONIALS PARALLAX (PAGE SCROLL – DOMCONTENTLOADED VERSION) ==========
document.addEventListener("DOMContentLoaded", () => {
  const section   = document.querySelector(".section.testimonials");
  const container = document.getElementById("testimonials-posts-container");

  if (!section || !container) return;

  const cards = container.querySelectorAll(".testimonial-container");
  if (!cards.length) return;

  function updateTestimonialsParallax() {
    const rect = section.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth  = window.innerWidth || document.documentElement.clientWidth;

    // On mobile: disable parallax + reset transforms
    if (viewportWidth < 775) {
      cards.forEach((card) => {
        card.style.transform = "";
      });
      return;
    }

    // Only animate if the section is at least partly on screen
    if (rect.bottom < 0 || rect.top > viewportHeight) {
      return;
    }

    const sectionCenter  = rect.top + rect.height / 2;
    const viewportCenter = viewportHeight / 2;
    const distanceFromCenter = sectionCenter - viewportCenter;

    // t ≈ -1 when far above, 0 when centered, +1 when far below
    let t = distanceFromCenter / viewportHeight;
    if (t < -1) t = -1;
    if (t > 1)  t = 1;

    const baseRange = 120; // px of vertical travel
    var multiplyer = 1

    cards.forEach((card) => {
      const styles   = getComputedStyle(card);
      const depthVal = parseFloat(styles.getPropertyValue("--depth")) || 0;
      const xOffset  = styles.getPropertyValue("--x-offset") || "0px";

      // Deeper cards move a bit differently
      const speed      = 1 + depthVal * 0.6;
      const translateY = (-t * baseRange * speed) * multiplyer;
      const translateZ = depthVal * 150; // uses CSS perspective for depth

      card.style.transform = `translate3d(${xOffset}, ${translateY}px, ${translateZ}px)`;
      multiplyer += 1.2;
    });
  }


  // Run once on load, then on scroll / resize
  updateTestimonialsParallax();
  window.addEventListener("scroll", updateTestimonialsParallax, { passive: true });
  window.addEventListener("resize", updateTestimonialsParallax);
});


// ========= LANDING PAGE: GOOGLE SIGN-IN HANDLER =========

// Single shared client for the landing page
let landingSb = null;

function getLandingSupabaseClient() {
  if (landingSb) return landingSb;

  if (!window.supabase) {
    console.error("Supabase JS not loaded. Make sure the CDN script is on the page.");
    alert("Sign-in is not available right now. Please refresh and try again.");
    return null;
  }

  // Use the SAME URL & anon key as in supabaseClient.js
  const SUPABASE_URL = "https://hsxtmzweqasetzfhzopn.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzeHRtendlcWFzZXR6Zmh6b3BuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNTY0ODEsImV4cCI6MjA3NjkzMjQ4MX0.jxja4aulHU_oAghJlRjqpLObw4OFiLnMqL8o2wCSAOw";

  landingSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return landingSb;
}

function getDashboardRedirectURL() {
  // If you're on GitHub Pages under /Bible-Board/, adjust here
  if (window.location.pathname.includes("/Bible-Board")) {
    return `${window.location.origin}/Bible-Board/dashboard/`;
  }

  // Local dev / custom domain
  return `${window.location.origin}/dashboard/`;
}

async function startGoogleSignIn(event) {
  if (event) event.preventDefault();

  const sb = getLandingSupabaseClient();
  if (!sb) return;

  const redirectTo = getDashboardRedirectURL();

  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) {
      console.error("Supabase sign-in error:", error);
      alert("Could not start Google sign-in. Please try again.");
    }
    // After this call, the browser will go to accounts.google.com
    // and then Supabase will redirect back to `redirectTo`.
  } catch (err) {
    console.error("Error starting sign-in:", err);
    alert("Something went wrong starting sign-in. Please try again.");
  }
}

// Attach to buttons once DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // All "Get Started" buttons (nav + footer)
  document.querySelectorAll(".action-button").forEach((btn) => {
    btn.addEventListener("click", startGoogleSignIn);
  });

  // The "Sign in with Google" button in your feature section / hero
  const googleBtn = document.getElementById("signin-btn");
  if (googleBtn) {
    googleBtn.addEventListener("click", startGoogleSignIn);
  }
});
