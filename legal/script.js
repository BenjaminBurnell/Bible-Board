// ========== NAVBAR / SCROLL EFFECTS ==========
const START_FADE   = 50;   // px
const END_FADE     = 250;  // px
// 0 = demo, 1 = used-by, 2 = features text, 3 = features images/videos, 4 = testimonials text
let loadedSections = [false, false, false, false, false];

let lastScrollTop = 0;
const navbar = document.getElementById("nav-bar")

window.addEventListener("scroll", () => {
  const windowHeight = window.innerHeight;

  if (!navbar) return;

  const scrollTop =
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0;

  const scrollingDown = scrollTop > lastScrollTop;

  // ========== NAVBAR BACKGROUND/BLUR ==========
  const topTRaw = (scrollTop - START_FADE) / (END_FADE - START_FADE);
  const tTop    = Math.min(Math.max(topTRaw, 0), 1); // 0..1

  const tBottom    = 0; // 0..1

  // Combined strength: fade in from top, fade out near bottom
  const navStrength = tTop * (1 - tBottom); // 0..1

  if (navStrength <= 0) {
    // Fully transparent
    navbar.style.background     = "transparent";
    navbar.style.backdropFilter = "none";
    navbar.style.borderBottom   = "none";
  } else {
    const bgOpacity             = 0.5 * navStrength;
    const blurAmountRem         = 1.5 * navStrength;
    const borderOpacity         = 0.8 * navStrength;

    navbar.style.background     = `rgba(23, 23, 23, ${bgOpacity})`;
    navbar.style.backdropFilter = `blur(${blurAmountRem}rem)`;
    navbar.style.borderBottom   = `1px solid rgba(47, 47, 47, ${borderOpacity})`;
  }

  lastScrollTop = scrollTop;
});

// ========== LOADER SEQUENCE ==========
function loadPage() {
}


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
