// Sends the one-time codes (OTP) for phone login. It's "pluggable": which sender is
// active is decided by the SMS_PROVIDER env var. Out of the box it's 'console' — dev
// mode — where no real text is sent; the code is just logged and handed back by the
// API so the whole login flow can be tested without paying for a gateway. Swap in a
// real provider later by setting the env vars below.
const PROVIDER = process.env.SMS_PROVIDER || 'console';

const providers = {
  // Dev mode: don't actually send anything. Log the code to the server console — and
  // the login route also returns it to the caller — so testing works end to end.
  console: {
    label: 'מצב פיתוח (ללא SMS אמיתי)',
    configured: () => true,
    async send(phone, text) { console.log(`[SMS→${phone}] ${text}`); return { sent: true, dev: true }; }
  },
  // A real Israeli SMS gateway (019 / Inforu / SMS4free / …). Set SMS_URL, SMS_USER,
  // SMS_KEY and SMS_SENDER in the env to switch this on. The request body below is a
  // placeholder shape — match it to whichever provider we actually sign up with.
  gateway: {
    label: 'ספק SMS חיצוני',
    configured: () => !!(process.env.SMS_USER && process.env.SMS_KEY && process.env.SMS_SENDER),
    async send(phone, text) {
      if (!this.configured()) throw new Error('SMS gateway not configured');
      const url = process.env.SMS_URL;
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: process.env.SMS_USER, key: process.env.SMS_KEY,
                               sender: process.env.SMS_SENDER, to: phone, message: text })
      });
      if (!r.ok) throw new Error('SMS send failed: ' + r.status);
      return { sent: true };
    }
  }
};

// Whichever provider SMS_PROVIDER names — falls back to the dev 'console' sender.
const active = providers[PROVIDER] || providers.console;

module.exports = {
  provider: PROVIDER,
  dev: PROVIDER === 'console',   // the login route reads this to decide whether to reveal the code
  send: (phone, text) => active.send(phone, text),
  // Small status object the admin "integrations" panel uses to show if SMS is live.
  status: () => ({ provider: PROVIDER, label: active.label, configured: active.configured(), dev: PROVIDER === 'console' })
};
