// feedback/feedback.js
import { sb } from "../supabaseClient.js";

const BUCKET = "feedback"; // make sure this matches your Supabase bucket name
const FILE_NAME = "feedback.json";

const statusEl = document.getElementById("feedback-status");
const headerWrapper = document.getElementById("fb-header-wrapper");
const formEl = document.getElementById("feedback-form");
const notLoggedInEl = document.getElementById("fb-not-logged-in");
const thankYouEl = document.getElementById("fb-thankyou");
const submitBtn = document.getElementById("feedback-submit");
const nextBtn = document.getElementById("feedback-next");
const prevBtn = document.getElementById("feedback-prev");
const stepIndicatorEl = document.getElementById("fb-step-indicator");

let sections = [];
// currentStep = 0 => INTRO ONLY
// currentStep = 1..N => show sections[currentStep - 1]
let currentStep = 0;

function setStatus(message, type = "") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = "fb-status";
  if (type === "loading") statusEl.classList.add("fb-status-loading");
  if (type === "error") statusEl.classList.add("fb-status-error");
  if (type === "success") statusEl.classList.add("fb-status-success");
}

async function getCurrentUser() {
  const { data, error } = await sb.auth.getUser();

  // Normal "not signed in" case – don't treat as an error
  if (
    error &&
    (error.name === "AuthSessionMissingError" ||
      error.message?.includes("Auth session missing"))
  ) {
    return null;
  }

  if (error) {
    console.error("[Feedback] getUser error", error);
    return null;
  }

  return data?.user ?? null;
}

function collectFormValues() {
  return {
    studentName: document.getElementById("student-name").value.trim(),
    studentEmail: document.getElementById("student-email").value.trim(),
    schoolName: document.getElementById("school-name").value.trim(),
    programName: document.getElementById("program-name").value.trim(),
    courseName: document.getElementById("course-name").value.trim(),
    usageRating: document.getElementById("usage-rating").value,
    recommendRating: document.getElementById("recommend-rating").value,
    favoritePart: document.getElementById("favorite-part").value.trim(),
    confusingPart: document.getElementById("confusing-part").value.trim(),
    wishlist: document.getElementById("wishlist").value.trim(),
    consent: document.getElementById("consent").value,
    updatedAt: new Date().toISOString(),
  };
}

function fillFormFromData(data) {
  if (!data) return;

  document.getElementById("student-name").value = data.studentName || "";
  document.getElementById("student-email").value = data.studentEmail || "";
  document.getElementById("school-name").value = data.schoolName || "";
  document.getElementById("program-name").value = data.programName || "";
  document.getElementById("course-name").value = data.courseName || "";
  document.getElementById("usage-rating").value = data.usageRating || "";
  document.getElementById("recommend-rating").value =
    data.recommendRating || "";
  document.getElementById("favorite-part").value = data.favoritePart || "";
  document.getElementById("confusing-part").value =
    data.confusingPart || "";
  document.getElementById("wishlist").value = data.wishlist || "";
  document.getElementById("consent").value = data.consent || "";

  // Sync card UI with loaded values
  syncOptionCardsFromInputs();
}

async function loadExistingFeedback(user) {
  const path = `${user.id}/${FILE_NAME}`;
  const { data, error } = await sb.storage.from(BUCKET).download(path);

  if (error) {
    console.info(
      "[Feedback] No existing feedback file or cannot read it:",
      error
    );
    return null;
  }

  try {
    const text = await data.text();
    const json = JSON.parse(text);
    return json;
  } catch (parseErr) {
    console.error(
      "[Feedback] Error parsing existing feedback JSON",
      parseErr
    );
    return null;
  }
}

async function saveFeedback(user, values) {
  const path = `${user.id}/${FILE_NAME}`;
  const blob = new Blob([JSON.stringify(values, null, 2)], {
    type: "application/json",
  });

  const { error } = await sb.storage
    .from(BUCKET)
    .upload(path, blob, { upsert: true });

  if (error) {
    throw error;
  }
}

// ---------- Option card helpers ----------

function initOptionCards() {
  const cards = Array.from(document.querySelectorAll(".fb-option-card"));
  if (!cards.length) return;

  cards.forEach((card) => {
    card.addEventListener("click", () => {
      const targetId = card.dataset.target;
      const value = card.dataset.value;
      if (!targetId || value == null) return;

      const input = document.getElementById(targetId);
      if (!input) return;

      // Update hidden input value
      input.value = value;

      // Toggle active state for all cards with the same target
      cards
        .filter((c) => c.dataset.target === targetId)
        .forEach((c) =>
          c.classList.toggle("fb-option-card--active", c === card)
        );
    });
  });

  // Initial sync (in case inputs already have values)
  syncOptionCardsFromInputs();
}

function syncOptionCardsFromInputs() {
  const cards = Array.from(document.querySelectorAll(".fb-option-card"));
  cards.forEach((card) => {
    const targetId = card.dataset.target;
    const value = card.dataset.value;
    const input = document.getElementById(targetId);
    if (!input) return;
    const isActive = input.value === value;
    card.classList.toggle("fb-option-card--active", isActive);
  });
}

// ---------- Thank-you screen ----------

function showThankYouScreen() {
  if (headerWrapper) headerWrapper.style.display = "none";
  if (formEl) formEl.style.display = "none";
  if (notLoggedInEl) notLoggedInEl.style.display = "none";
  if (thankYouEl) thankYouEl.style.display = "block";
}

// ---------- Stepper logic ----------
//
// "intro" is step 0 (only headerWrapper visible)
// steps 1..N map to sections[step - 1]

function updateStepUI() {
  const totalQuestions = sections.length;
  if (!totalQuestions) return;

  sections.forEach((section, index) => {
    if (currentStep === 0) {
      section.style.display = "none";
    } else {
      section.style.display = index === currentStep - 1 ? "block" : "none";
    }
  });

  if (headerWrapper) {
    headerWrapper.style.display = currentStep === 0 ? "block" : "none";
  }

  if (stepIndicatorEl) {
    if (currentStep === 0) {
      stepIndicatorEl.textContent = "Intro";
    } else {
      stepIndicatorEl.textContent = `Question ${currentStep} of ${totalQuestions}`;
    }
  }

  if (prevBtn) {
    prevBtn.disabled = currentStep === 0;
  }

  if (nextBtn) {
    nextBtn.style.display =
      currentStep < totalQuestions ? "inline-flex" : "none";
  }

  if (submitBtn) {
    submitBtn.style.display =
      currentStep === totalQuestions ? "inline-flex" : "none";
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initStepper() {
  sections = Array.from(document.querySelectorAll(".fb-section"));
  if (!sections.length) {
    console.warn("[Feedback] No sections found for stepper.");
    return;
  }

  currentStep = 0;
  updateStepUI();

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (currentStep > 0) {
        currentStep -= 1;
        updateStepUI();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const totalQuestions = sections.length;
      const lastStepIndex = totalQuestions; // steps 0..N
      if (currentStep < lastStepIndex) {
        currentStep += 1;
        updateStepUI();
      }
    });
  }
}

// ---------- Sign-in section ----------

function initSignInSection() {
  const signInBtn = document.getElementById("signin-btn");
  if (!signInBtn) return;

  signInBtn.addEventListener("click", async () => {
    // Fallback: if sb.auth.signInWithOAuth is not available for some reason,
    // just send them to the dashboard login.
    if (!sb || !sb.auth || !sb.auth.signInWithOAuth) {
      window.location.href = "/dashboard";
      return;
    }

    try {
      const { error } = await sb.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.href, // come back to this page
        },
      });

      if (error) {
        console.error("[Feedback] Google sign-in error", error);
        setStatus(
          "Could not start Google sign-in. Redirecting to your dashboard…",
          "error"
        );
        // As a backup: send them to the existing dashboard login flow
        window.location.href = "/dashboard";
      }
    } catch (err) {
      console.error("[Feedback] Google sign-in exception", err);
      setStatus(
        "Could not start Google sign-in. Redirecting to your dashboard…",
        "error"
      );
      window.location.href = "/dashboard";
    }
  });
}

// ---------- Init ----------

async function initFeedbackPage() {
  try {
    initSignInSection();
    setStatus("Checking your session…", "loading");

    const user = await getCurrentUser();

    if (!user) {
      setStatus("Please sign in to continue.", "loading");
      if (notLoggedInEl) notLoggedInEl.style.display = "block";
      if (formEl) formEl.style.display = "none";
      if (thankYouEl) thankYouEl.style.display = "none";
      if (headerWrapper) headerWrapper.style.display = "none";
      return;
    }

    // User is signed in → show form + intro/stepper
    if (notLoggedInEl) notLoggedInEl.style.display = "none";
    if (thankYouEl) thankYouEl.style.display = "none";
    if (formEl) {
      formEl.style.display = "flex";
    }

    initStepper();
    initOptionCards();

    // Pre-fill email if available
    if (user.email && document.getElementById("student-email")) {
      const emailInput = document.getElementById("student-email");
      if (!emailInput.value) emailInput.value = user.email;
    }

    setStatus("Loading your feedback (if any)…", "loading");
    const existing = await loadExistingFeedback(user);
    if (existing) {
      fillFormFromData(existing);
      setStatus(
        "Loaded your saved feedback. You can update it below.",
        "success"
      );
    } else {
      setStatus(
        "You haven’t submitted feedback yet. Answer the questions below.",
        "loading"
      );
    }

    formEl.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!user) return;

      const values = collectFormValues();

      submitBtn.disabled = true;
      setStatus("Saving your feedback…", "loading");

      try {
        await saveFeedback(user, values);
        setStatus(
          "Feedback saved. Thank you for helping improve BibleBoard! 👀",
          "success"
        );
        showThankYouScreen();
      } catch (err) {
        console.error("[Feedback] save error", err);
        setStatus(
          "Something went wrong while saving. Please try again.",
          "error"
        );
      } finally {
        submitBtn.disabled = false;
      }
    });
  } catch (err) {
    console.error("[Feedback] init error", err);
    setStatus("Unexpected error loading the page. Please refresh.", "error");
  }
}

document.addEventListener("DOMContentLoaded", initFeedbackPage);