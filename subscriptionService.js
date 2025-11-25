import { sb } from "./supabaseClient.js";

// --- CONFIGURATION ---
const RC_API_KEY = "rcb_KCKetekybYnxljduUvbMWucwhJmN"; 
// Ensure this matches your RevenueCat Entitlement identifier exactly
const ENTITLEMENT_ID = "BibleBoard Pro"; 

let rcInstance = null;

export const SubscriptionService = {
  
  async getRcInstance() {
    if (rcInstance) return rcInstance;

    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;

    const Purchases = window.Purchases?.Purchases || window.Purchases;
    if (!Purchases) {
        console.error("RevenueCat SDK not loaded.");
        return null;
    }

    rcInstance = Purchases.configure({
      apiKey: RC_API_KEY,
      appUserId: session.user.id 
    });

    return rcInstance;
  },

  async initAndCheck() {
    const purchases = await this.getRcInstance();
    if (!purchases) return false;

    try {
      const customerInfo = await purchases.getCustomerInfo();
      
      // --- DEBUG LOGGING ---
      console.log("🔍 DEBUG: Checking Access...");
      console.log("👤 User ID:", await purchases.getAppUserId());
      console.log("📦 All Entitlements:", customerInfo.entitlements.all);
      console.log("✅ Active Entitlements:", customerInfo.entitlements.active);
      
      // 1. PRIMARY CHECK: Do they have the entitlement?
      const hasAccess = customerInfo.entitlements.active[ENTITLEMENT_ID] !== undefined;

      if (hasAccess) {
        console.log("🎉 Access Granted via Entitlement");
        localStorage.setItem("bb_sub_status", "active");
        return true;
      } 
      
      // 2. EMERGENCY FALLBACK (Debug Mode)
      // Fix: Safely check for purchase dates to prevent crash
      const allDates = customerInfo.allPurchaseDates || {};
      const hasTransactions = Object.keys(allDates).length > 0;

      if (hasTransactions && !hasAccess) {
        console.warn("⚠️ User PAID but has NO entitlement. RevenueCat config issue.");
        console.log("Purchase History:", allDates);
        
        // UNCOMMENT THE NEXT LINE TO FORCE ACCESS FOR DEBUGGING:
        // return true; 
      }

      console.log("❌ Access Denied.");
      localStorage.removeItem("bb_sub_status");
      return false;

    } catch (e) {
      console.error("RC Check Error:", e);
      // If check crashes, allow access if they were previously valid (offline mode)
      return localStorage.getItem("bb_sub_status") === "active";
    }
  },

  async subscribe() {
    const purchases = await this.getRcInstance();
    if (!purchases) return alert("Please log in.");

    try {
      // Check status before trying to buy
      const info = await purchases.getCustomerInfo();
      if (info.entitlements.active[ENTITLEMENT_ID]) {
        window.location.href = "dashboard/";
        return;
      }

      const offerings = await purchases.getOfferings();
      const currentOffering = offerings.current;
      
      if (currentOffering && currentOffering.availablePackages.length > 0) {
        const packageToBuy = currentOffering.availablePackages[0];
        const { customerInfo } = await purchases.purchasePackage(packageToBuy);
        
        if (customerInfo.entitlements.active[ENTITLEMENT_ID]) {
          window.location.href = "dashboard/";
        } else {
            alert("Payment successful, but access setup is incomplete. Please contact support.");
            console.error("Missing Entitlement after purchase:", customerInfo);
        }
      } else {
        alert("No packages found.");
      }
    } catch (e) {
      // Handle "Already Purchased" error gracefully
      const msg = e.message || "";
      if (msg.includes("already active") || msg.includes("409")) {
         window.location.href = "dashboard/";
         return;
      }

      if (!e.userCancelled) {
        console.error("Purchase error:", e);
        alert("Purchase failed. Please try again.");
      }
    }
  },

  async manage() {
    const purchases = await this.getRcInstance();
    if (!purchases) return;
    const info = await purchases.getCustomerInfo();
    if (info.managementURL) window.location.href = info.managementURL;
    else alert("Manage via Stripe email.");
  },

  async logout() {
    await sb.auth.signOut();
    rcInstance = null;
    localStorage.removeItem("bb_sub_status");
    window.location.href = "index.html";
  }
};