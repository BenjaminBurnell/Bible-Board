// subscriptionService.js

import { sb } from "./supabaseClient.js";

// --- CONFIGURATION ---
const RC_API_KEY = "rcb_KCKetekybYnxljduUvbMWucwhJmN"; 
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
    if (info.managementURL) open(info.managementURL);
    else alert("Manage via Stripe email.");
  },

  async logout() {
    await sb.auth.signOut();
    rcInstance = null;
    window.location.href = "index.html";
  }
};