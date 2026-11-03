// ============================================================================
// Payment gateway — scaffold, not wired to a real provider yet.
//
// The idea: keep the rest of the app provider-agnostic. Checkout just asks for a
// payment "intent" and gets back a URL to redirect the customer to; when they come
// back we verify the result. Swapping Hyp for Tranzila/PayPlus/Cardcom later means
// adding one more entry below — the checkout code doesn't change.
//
// Pick the active one with the PAYMENT_PROVIDER env var and supply its credentials
// via env too (so secrets never sit in this file).
// ============================================================================

const PROVIDER = process.env.PAYMENT_PROVIDER || 'none';

const providers = {
  // No real gateway yet. Checkout just records the order and treats it as
  // cash-on-delivery — this is the current behaviour.
  none: {
    configured: () => true,
    async createPayment() { return { url: null, mode: 'cash-on-delivery' }; },
    async verify() { return { paid: false }; }
  },

  // Hyp (hyp.co.il), a common Israeli gateway. Fill in MASOF (the terminal number)
  // and the API key once the account is open — until then `configured()` is false
  // and we won't try to use it.
  hyp: {
    configured: () => !!(process.env.HYP_MASOF && process.env.HYP_APIKEY),
    async createPayment({ amount, orderId, description }) {
      if (!this.configured()) throw new Error('Hyp is not configured yet');
      // Builds the query string for Hyp's hosted payment page. The exact parameter
      // names should be double-checked against Hyp's docs when we go live.
      const qs = new URLSearchParams({
        action: 'pay', Masof: process.env.HYP_MASOF, KEY: process.env.HYP_APIKEY,
        Amount: String(amount), Info: description || ('Order ' + orderId),
        Order: String(orderId), UTF8: 'True', UTF8out: 'True', tmp: '1'
      });
      return { url: 'https://pay.hyp.co.il/p/?' + qs.toString() };
    },
    // Hyp sends the customer back with query params; CCode '0' means approved.
    async verify(query) { return { paid: query && query.CCode === '0', ref: query && query.Id }; }
  }
};

// Whichever provider PAYMENT_PROVIDER names (falls back to 'none' if unknown).
const active = providers[PROVIDER] || providers.none;

module.exports = {
  provider: PROVIDER,
  createPayment: (o) => active.createPayment(o),
  verify: (q) => active.verify(q),
  // Small status object the admin "integrations" panel reads to show if it's set up.
  status: () => ({ name: 'Payment', provider: PROVIDER, configured: active.configured() })
};
