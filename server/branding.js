// ============================================================================
// Branding — the single source of truth for names.
//
// This is a generic demo build. To re-skin it (new app name, new store names),
// change the values here, then re-run `npm run build:db` so the store labels in the
// database match. The app display name also appears in the front-end (see the BRAND
// constant near the top of public/storefront/app.js and the page <title>s).
// ============================================================================
module.exports = {
  // The app / platform name shown in the UI.
  appName: 'FreshCart',
  tagline: 'סופרמרקט · משלוחים', // "supermarket · delivery" (generic, not a brand)

  // Price-comparison stores (admin-only). Ubi + Dabach shown under their real names.
  // Keys are the internal store codes in the DB; values are the display labels.
  stores: {
    ubi:    'Ubi',
    dabach: 'Dabach'
  },

  // The user's own store(s) are kept OUT of the comparison entirely (removed on export).
  hiddenStores: ['rosmarin']
};
