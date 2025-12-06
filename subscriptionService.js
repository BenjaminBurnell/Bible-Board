// subscriptionService.js

import { sb } from "./supabaseClient.js";

// --- CONFIGURATION ---
const RC_API_KEY = "rcb_KCKetekybYnxljduUvbMWucwhJmN"; 
const ENTITLEMENT_ID = "BibleBoard Pro"; 

// 👇 NEW: promo offering ID – replace with your actual RC offering identifier
const PROMO_OFFERING_ID = "monthly_bibleboard_subscription_3_months_free"; 
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

  /**
   * Performs the live RevenueCat check and returns the status.
   */
  async initAndCheck() {
    const purchases = await this.getRcInstance();
    if (!purchases) return false;

    try {
      const customerInfo = await purchases.getCustomerInfo();
      
      // FIX: Check for EITHER the Entitlement OR any active subscription product
      const hasProEntitlement = customerInfo.entitlements.active[ENTITLEMENT_ID] !== undefined;
      const hasActiveSubscription = Object.keys(customerInfo.activeSubscriptions).length > 0;
      
      const hasAccess = hasProEntitlement || hasActiveSubscription;

      if (hasAccess) {
        console.log("🎉 Access Granted (Pro/Subscription Active)");
        return true;
      } 
      
      console.log("❌ Access Denied.");
      return false;

    } catch (e) {
      console.error("RC Check Error:", e);
      return false;
    }
  },

  async hasActiveSubscription() {
    // Reuse your existing logic
    return this.initAndCheck();
  },


  // Normal upgrade (no promo)
  async subscribe() {
    const purchases = await this.getRcInstance();
    if (!purchases) return alert("Please log in.");

    const offerings = await purchases.getOfferings();
    const current = offerings.current;

    if (!current || !current.availablePackages?.length) {
      alert("No plans are available right now. Please contact support.");
      console.error("[Sub] No packages in current offering:", offerings);
      return;
    }

    // 👇 Default package identifier for your regular plan
    const NORMAL_PKG_ID = "$rc_monthly";

    const normalPackage =
      current.availablePackages.find((p) => p.identifier === NORMAL_PKG_ID) ||
      current.availablePackages[0];

    const { customerInfo } = await purchases.purchasePackage(normalPackage);

    if (customerInfo.entitlements.active[ENTITLEMENT_ID]) {
      window.location.href = "../dashboard/";
    } else {
      alert("Payment succeeded, but Pro isn’t active. Please contact support.");
      console.error("[Sub] Missing entitlement after normal purchase:", customerInfo);
    }
  },

  // Promo upgrade (3 months free)
  async redeemStudentPromo() {
    const purchases = await this.getRcInstance();
    if (!purchases) return alert("Please log in.");

    try {
      const offerings = await purchases.getOfferings();
      const current = offerings.current;

      if (!current || !current.availablePackages?.length) {
        alert("Student plan isn’t available right now. Please contact support.");
        console.error("[Promo] No packages in current offering:", offerings);
        return;
      }

      // 👇 MUST match the identifier you just set in RevenueCat
      const STUDENT_PKG_ID = "student_3mo";

      const studentPackage = current.availablePackages.find(
        (p) => p.identifier === STUDENT_PKG_ID
      );

      if (!studentPackage) {
        alert("Student promo plan is not configured correctly.");
        console.error("[Promo] Package not found:", current.availablePackages);
        return;
      }

      const { customerInfo } = await purchases.purchasePackage(studentPackage);

      if (customerInfo.entitlements.active[ENTITLEMENT_ID]) {
        window.location.href = "../dashboard/";
      } else {
        alert("Promo purchase succeeded, but Pro isn’t active. Please contact support.");
        console.error("[Promo] Missing entitlement after promo purchase:", customerInfo);
      }
    } catch (e) {
      console.error("[Promo] Promo purchase error:", e);
      const msg = e.message || "";
      if (msg.includes("already active") || msg.includes("409")) {
        window.location.href = "dashboard/";
        return;
      }
      if (!e.userCancelled) {
        alert("Couldn't apply promo code. Please try again.");
      }
    }
  },


  async manage() {
    const purchases = await this.getRcInstance();
    if (!purchases) return;
    const info = await purchases.getCustomerInfo();
    if (info.managementURL) open(info.managementURL);
    else alert("Manage via Stripe email.");
  },

  async logout() {
    await sb.auth.signOut();
    rcInstance = null;
    window.location.href = "index.html";
  }
};