// ============================================================================
// ERP connector — stub.
//
// In the original app this talked to a Priority ERP to sync the real product
// catalog. The public demo has no ERP, so this just reports "not connected" to the
// admin integrations panel. Everything the storefront shows comes from the seeded
// SQLite catalog instead.
// ============================================================================
module.exports = {
  status: () => ({ name: 'Priority ERP', provider: 'none', connected: false, configured: false }),
  async fetchProducts() { throw new Error('ERP integration is disabled in this demo build'); }
};
