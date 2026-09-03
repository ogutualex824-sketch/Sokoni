/* ================================================================
   SOKONI dashboard identity widget — pure client-side core (Part 5-7)

   No DOM, no Firebase, no network. Loaded as a plain classic script by
   sokoni-dashboard-profile.js (window.SokoniDashboardProfileCore) so the
   one safety-relevant decision in that widget — may clicking THIS
   workspace item actually trigger a switch — is directly certifiable with
   Node, the same "pure core, certified in isolation" methodology
   sokoni-pay-q-core.js (Q8) already established for this project's other
   client-side surface.

   THE INVARIANT THIS FILE EXISTS TO PROVE BY CONSTRUCTION: a workspace
   item can only ever trigger a switch when it is BOTH server-marked
   active (isActive !== false) AND not already the current workspace. The
   widget never re-derives "is this a valid shop" itself — that server
   answer (getMyShopWorkspaces, Part 4) is the only input; this file just
   makes sure the click handler cannot be tricked into acting on a
   disabled entry or a redundant no-op switch.
================================================================ */
(function (root) {
  'use strict';

  /**
   * Given one workspace list entry ({id, name, isActive, current, roleLabel}),
   * decide whether tapping it should call onSwitchWorkspace.
   */
  function shouldSwitchWorkspace(w) {
    if (!w) return false;
    if (w.current === true) return false;       /* already here — no-op, not a re-trigger */
    if (w.isActive === false) return false;      /* server marked it inactive/disabled */
    return true;
  }

  /** Display state for one workspace row — text + badge, one place for both. */
  function workspaceItemState(w) {
    if (!w) return { badge: null, disabled: true };
    if (w.current === true) return { badge: 'Active', disabled: true };
    if (w.isActive === false) return { badge: 'Disabled', disabled: true };
    return { badge: null, disabled: false };
  }

  /**
   * Given the server-derived workspace list and the currently active shop
   * id, mark exactly one entry `current:true` — never the client's own
   * guess, never more than one. Pure so "exactly one active entry, matching
   * the server's own activeShopId" is a directly provable property.
   */
  function markCurrent(workspaces, activeShopId) {
    return (workspaces || []).map(function (w) {
      return Object.assign({}, w, { current: !!activeShopId && w.id === activeShopId });
    });
  }

  var api = { shouldSwitchWorkspace: shouldSwitchWorkspace, workspaceItemState: workspaceItemState, markCurrent: markCurrent };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SokoniDashboardProfileCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
