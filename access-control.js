/**
 * SOKONI ACCESS CONTROL MODULE
 * Manages role-based registration and management access
 * All pages are PUBLIC for browsing but management requires registration
 * Include FIRST after security.js on pages that need role checks
 */

const SokoniAccessControl = (() => {

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. USER ROLES & DEFINITIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  const ROLE_DEFINITIONS = {
    buyer: { label: "Buyer", description: "Browse & buy products/services", icon: "🛍️" },
    seller: { label: "Seller", description: "Sell products/services & manage store", icon: "🏪" },
    healthcare: { label: "Healthcare Provider", description: "Offer healthcare services", icon: "⚕️" },
    mechanic: { label: "Mechanic", description: "Offer mechanical services", icon: "🔧" },
    driver: { label: "Driver", description: "Provide ride/delivery services", icon: "🚗" },
    delivery: { label: "Delivery Partner", description: "Offer delivery services", icon: "📦" },
    landlord: { label: "Landlord/Property Manager", description: "Manage properties for rent", icon: "🏠" },
    legal: { label: "Legal Professional", description: "Offer legal services", icon: "⚖️" },
  };

  // Pages that check if user is registered for editing/management
  const MANAGEMENT_PAGES = {
    "seller.html": "seller",
    "ministore.html": "seller",
    "bnb-manage.html": "seller",
    "healthcare.html": "healthcare",
    "mechanic.html": "mechanic",
    "driver.html": "driver",
    "delivery.html": "delivery",
    "landlord.html": "landlord",
    "legal-hub.html": "legal",
    "property.html": "landlord",
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. USER INFO HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function getCurrentUser() {
    try {
      const user = safeGetJSON("sokoniUser", null);
      return user;
    } catch (e) {
      console.warn("[AccessControl] Failed to get current user:", e);
      return null;
    }
  }

  function getUserRoles() {
    const user = getCurrentUser();
    if (!user) return { roles: ["buyer"], registeredAs: {} };
    
    const registeredAs = user.registeredAs || {};
    const roles = Object.keys(registeredAs).filter(role => registeredAs[role] === true);
    
    // Everyone defaults to buyer
    if (roles.length === 0) {
      roles.push("buyer");
    }
    
    return { roles, registeredAs };
  }

  function hasRole(role) {
    if (!role) return false;
    const { roles } = getUserRoles();
    return roles.includes(role);
  }

  function hasAnyRole(roleArray) {
    if (!Array.isArray(roleArray)) return false;
    const { roles } = getUserRoles();
    return roleArray.some(r => roles.includes(r));
  }

  function isLoggedIn() {
    return getCurrentUser() !== null && localStorage.getItem("loggedIn") === "true";
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. PAGE & ROLE CHECKING
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function getPageName() {
    const path = window.location.pathname;
    const filename = path.split("/").pop();
    return filename || "index.html";
  }

  function isManagementPage(pageName) {
    pageName = pageName || getPageName();
    return MANAGEMENT_PAGES[pageName] !== undefined;
  }

  function getRequiredRoleForPage(pageName) {
    pageName = pageName || getPageName();
    return MANAGEMENT_PAGES[pageName] || null;
  }

  function canManagePage(pageName) {
    pageName = pageName || getPageName();
    const requiredRole = MANAGEMENT_PAGES[pageName];
    if (!requiredRole) return true; // Not a management page
    return hasRole(requiredRole);
  }

  function getMissingRole(pageName) {
    pageName = pageName || getPageName();
    return MANAGEMENT_PAGES[pageName] || null;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. REGISTRATION & ROLE MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function registerUserRole(role) {
    const user = getCurrentUser();
    if (!user) {
      console.warn("[AccessControl] No user logged in");
      return false;
    }

    if (!ROLE_DEFINITIONS[role]) {
      console.warn("[AccessControl] Invalid role:", role);
      return false;
    }

    user.registeredAs = user.registeredAs || {};
    user.registeredAs[role] = true;
    safeSetJSON("sokoniUser", user);
    return true;
  }

  function unregisterUserRole(role) {
    const user = getCurrentUser();
    if (!user) return false;

    user.registeredAs = user.registeredAs || {};
    user.registeredAs[role] = false;
    safeSetJSON("sokoniUser", user);
    return true;
  }

  function getRoleStatus() {
    const user = getCurrentUser();
    if (!user) return {};
    return user.registeredAs || {};
  }

  function toggleRole(role) {
    if (!hasRole(role)) {
      registerUserRole(role);
    } else {
      unregisterUserRole(role);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. UI MODALS & HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function showRoleSelectionModal() {
    const roles = Object.entries(ROLE_DEFINITIONS).map(([key, def]) => {
      const checked = hasRole(key) ? "checked" : "";
      return `
        <label class="sokoni-role-option">
          <input type="checkbox" value="${key}" ${checked} onchange="SokoniAccessControl.toggleRole('${key}')">
          <span class="role-icon">${def.icon}</span>
          <span class="role-info">
            <strong>${def.label}</strong>
            <small>${def.description}</small>
          </span>
        </label>
      `;
    }).join("");

    const modal = document.createElement("div");
    modal.className = "sokoni-access-modal";
    modal.innerHTML = `
      <div class="sokoni-access-modal-content">
        <div class="sokoni-access-modal-icon">👤</div>
        <h2>Select Your Roles</h2>
        <p>You can be multiple roles on SOKONI. Choose all that apply:</p>
        <div class="sokoni-role-selector">
          ${roles}
        </div>
        <div class="sokoni-access-modal-actions">
          <button onclick="window.location.href = 'profile.html';" class="sokoni-btn-primary">
            Done
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add("show"), 100);
  }

  function showRoleRegistrationPrompt(roleName) {
    const role = ROLE_DEFINITIONS[roleName];
    if (!role) return;

    const modal = document.createElement("div");
    modal.className = "sokoni-role-prompt-modal";
    modal.innerHTML = `
      <div class="sokoni-role-prompt-content">
        <div class="prompt-icon">${role.icon}</div>
        <h2>Register as ${role.label}?</h2>
        <p>${role.description}</p>
        <div class="sokoni-access-modal-actions">
          <button onclick="SokoniAccessControl.registerUserRole('${roleName}'); location.reload();" class="sokoni-btn-primary">
            Register Now
          </button>
          <button onclick="window.history.back();" class="sokoni-btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add("show"), 100);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. NAVIGATION FILTERING
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function filterNavigationItems() {
    // Show/hide nav items based on user's roles
    const navItems = document.querySelectorAll("[data-role-required]");
    navItems.forEach(item => {
      const requiredRoles = item.getAttribute("data-role-required").split(",").map(r => r.trim());
      const hasAccess = hasAnyRole(requiredRoles);
      item.style.display = hasAccess ? "" : "none";
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 7. AUTO-INIT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function init() {
    // Filter nav items on page load
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", filterNavigationItems);
    } else {
      filterNavigationItems();
    }

    const user = getCurrentUser();
    if (user) { getUserRoles(); }
  }

  // Run init when DOM is ready
  if (typeof document !== "undefined") {
    init();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 8. EXPORT PUBLIC API
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  return {
    // User info
    getCurrentUser,
    getUserRoles,
    hasRole,
    hasAnyRole,
    isLoggedIn,
    getRoleStatus,

    // Page checks
    getPageName,
    isManagementPage,
    getRequiredRoleForPage,
    canManagePage,
    getMissingRole,

    // Role management
    registerUserRole,
    unregisterUserRole,
    toggleRole,

    // UI
    showRoleSelectionModal,
    showRoleRegistrationPrompt,
    filterNavigationItems,

    // Metadata
    ROLE_DEFINITIONS,
    MANAGEMENT_PAGES
  };

})();

// Make globally accessible
window.SokoniAccessControl = SokoniAccessControl;

// Add CSS styles for modals
(function() {
  const css = document.createElement("style");
  css.textContent = `
    .sokoni-access-modal,
    .sokoni-role-prompt-modal {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      overflow-y: auto;
      padding: 24px;
      z-index: 9999;
      opacity: 0;
      transition: opacity 0.3s;
    }

    .sokoni-access-modal.show,
    .sokoni-role-prompt-modal.show {
      opacity: 1;
    }

    .sokoni-access-modal-content,
    .sokoni-role-prompt-content {
      background: #1a1a1a;
      border: 1px solid rgba(113,255,0,0.3);
      border-radius: 12px;
      padding: 40px 30px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      color: #fff;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      animation: slideUp 0.3s;
      margin: auto;
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .sokoni-access-modal-icon,
    .prompt-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .sokoni-access-modal-content h2,
    .sokoni-role-prompt-content h2 {
      margin: 0 0 12px 0;
      font-size: 24px;
      color: #71ff00;
    }

    .sokoni-access-modal-content p,
    .sokoni-role-prompt-content p {
      margin: 0 0 20px 0;
      color: #ccc;
      font-size: 14px;
    }

    .sokoni-role-selector {
      text-align: left;
      margin: 20px 0;
    }

    .sokoni-role-option {
      display: flex;
      align-items: center;
      padding: 12px;
      margin: 8px 0;
      background: rgba(113,255,0,0.05);
      border: 1px solid rgba(113,255,0,0.2);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .sokoni-role-option:hover {
      background: rgba(113,255,0,0.1);
      border-color: rgba(113,255,0,0.4);
    }

    .sokoni-role-option input {
      margin-right: 12px;
      cursor: pointer;
    }

    .sokoni-role-option .role-icon {
      font-size: 20px;
      margin-right: 12px;
    }

    .sokoni-role-option .role-info {
      flex: 1;
      text-align: left;
    }

    .sokoni-role-option strong {
      display: block;
      color: #71ff00;
      margin-bottom: 4px;
    }

    .sokoni-role-option small {
      display: block;
      color: #999;
      font-size: 12px;
    }

    .sokoni-access-modal-actions {
      display: flex;
      gap: 12px;
      justify-content: center;
    }

    .sokoni-btn-primary,
    .sokoni-btn-secondary {
      padding: 12px 24px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .sokoni-btn-primary {
      background: #71ff00;
      color: #000;
      flex: 1;
    }

    .sokoni-btn-primary:hover {
      background: #8aff1a;
      transform: translateY(-2px);
    }

    .sokoni-btn-secondary {
      background: transparent;
      border: 1px solid rgba(113,255,0,0.3);
      color: #71ff00;
      flex: 1;
    }

    .sokoni-btn-secondary:hover {
      background: rgba(113,255,0,0.1);
      border-color: rgba(113,255,0,0.6);
    }

    @media (max-width: 520px) {
      .sokoni-access-modal-content,
      .sokoni-role-prompt-content {
        margin: 20px;
        max-width: calc(100% - 40px);
      }

      .sokoni-access-modal-actions {
        flex-direction: column;
      }
    }
  `;
  document.head.appendChild(css);
})();
