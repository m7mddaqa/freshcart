// Customer accounts — the "log in with your phone" flow and everything behind it.
//
// How it works: the customer types their phone -> we text them a 6-digit code (OTP)
// -> they type it back -> we create (or find) their account and hand the browser a
// random session token. After that, the browser sends that token on every "my
// account" request as proof of who they are. No passwords anywhere.
const crypto = require('crypto');
const sms = require('./sms');

// Strip a phone down to just digits (and a leading +), so "050-123 4567" and
// "0501234567" are treated the same.
const normPhone = p => String(p || '').replace(/[^\d+]/g, '');
// A little id to tag each customer action in the audit log (so related rows group).
const genBatch = () => 'C' + Date.now().toString(36).toUpperCase();

// Wires all the auth routes onto the Express app. `ctx` gives us the shared db
// helpers + the audit logger from index.js.
function registerAuth(app, ctx) {
  const { sql, query, logAudit } = ctx;

  // ---- step 1: customer asks for a code to be sent to their phone ----
  app.post('/api/auth/request-otp', async (req, res, next) => {
    try {
      const phone = normPhone(req.body && req.body.phone);
      if (phone.replace('+', '').length < 7) return res.status(400).json({ error: 'מספר טלפון לא תקין' });
      // Don't spam: if we already sent a still-unused code in the last ~30s, make them wait.
      const recent = await query(
        `SELECT TOP 1 created_at FROM dbo.otp_codes WHERE phone=@p AND used=0 AND created_at > DATEADD(second,-30,SYSUTCDATETIME()) ORDER BY id DESC`,
        { p: { type: sql.NVarChar(40), value: phone } });
      if (recent.length) return res.status(429).json({ error: 'נשלח קוד לאחרונה, נסה שוב בעוד רגע' });

      // Random 6-digit code, good for 5 minutes.
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await query(
        `INSERT INTO dbo.otp_codes (phone,code,expires_at) VALUES (@p,@c,DATEADD(minute,5,SYSUTCDATETIME()))`,
        { p: { type: sql.NVarChar(40), value: phone }, c: { type: sql.NVarChar(10), value: code } });
      await sms.send(phone, `קוד האימות שלך ל-FreshCart: ${code}`);
      await logAudit(genBatch(), 'otp_request', 'customer', 0, null, phone, null, 'customer:' + phone);
      // In dev mode there's no real SMS, so hand the code straight back — that's the
      // only way to test the flow without a gateway. (In production `dev` is false.)
      res.json({ ok: true, sent: true, dev: sms.dev, devCode: sms.dev ? code : undefined });
    } catch (e) { next(e); }
  });

  // ---- step 2: customer sends the code back → log them in ----
  app.post('/api/auth/verify-otp', async (req, res, next) => {
    try {
      const phone = normPhone(req.body && req.body.phone);
      const code = String((req.body && req.body.code) || '').trim();
      // Grab the newest unused, unexpired code for this phone.
      const rows = await query(
        `SELECT TOP 1 * FROM dbo.otp_codes WHERE phone=@p AND used=0 AND expires_at > SYSUTCDATETIME() ORDER BY id DESC`,
        { p: { type: sql.NVarChar(40), value: phone } });
      if (!rows.length) return res.status(401).json({ error: 'הקוד פג תוקף, בקש קוד חדש' });
      const rec = rows[0];
      // Lock out after 5 wrong guesses so nobody can brute-force a code.
      if (rec.attempts >= 5) return res.status(429).json({ error: 'יותר מדי נסיונות, בקש קוד חדש' });
      if (rec.code !== code) {
        await query('UPDATE dbo.otp_codes SET attempts=attempts+1 WHERE id=@id', { id: { type: sql.Int, value: rec.id } });
        return res.status(401).json({ error: 'קוד שגוי' });
      }
      // Correct — burn the code so it can't be reused.
      await query('UPDATE dbo.otp_codes SET used=1 WHERE id=@id', { id: { type: sql.Int, value: rec.id } });

      // Find this customer, or create a bare account on their first ever login.
      let cust = await query('SELECT TOP 1 id,name,first_name,last_name,phone,email,address FROM dbo.customers WHERE phone=@p',
        { p: { type: sql.NVarChar(40), value: phone } });
      if (!cust.length) {
        const ins = await query('INSERT INTO dbo.customers (phone) OUTPUT INSERTED.id VALUES (@p)',
          { p: { type: sql.NVarChar(40), value: phone } });
        cust = [{ id: ins[0].id, name: null, first_name: null, last_name: null, phone, email: null, address: null }];
      }
      const customerId = cust[0].id;
      // Hand out a long random session token and remember it (one row per device).
      const token = crypto.randomBytes(24).toString('hex');
      await query('INSERT INTO dbo.customer_tokens (token,customer_id) VALUES (@t,@c)',
        { t: { type: sql.NVarChar(64), value: token }, c: { type: sql.Int, value: customerId } });
      await logAudit(genBatch(), 'login', 'customer', customerId, null, phone, null, 'customer:' + phone);
      res.json({ token, customer: cust[0] });
    } catch (e) { next(e); }
  });

  // Gate for "my account" routes: turns the token in the header into a customer id,
  // or rejects with 401 if it's missing/expired. Sets req.customerId for the handler.
  async function requireCustomer(req, res, next) {
    try {
      const t = req.headers['x-customer-token'];
      if (!t) return res.status(401).json({ error: 'יש להתחבר' });
      const r = await query('SELECT customer_id FROM dbo.customer_tokens WHERE token=@t',
        { t: { type: sql.NVarChar(64), value: String(t) } });
      if (!r.length) return res.status(401).json({ error: 'ההתחברות פגה' });
      req.customerId = r[0].customer_id;
      next();
    } catch (e) { next(e); }
  }

  // Log out = forget this device's token.
  app.post('/api/auth/logout', requireCustomer, async (req, res, next) => {
    try {
      await query('DELETE FROM dbo.customer_tokens WHERE token=@t',
        { t: { type: sql.NVarChar(64), value: String(req.headers['x-customer-token']) } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // The logged-in customer's own profile.
  app.get('/api/me', requireCustomer, async (req, res, next) => {
    try {
      const c = await query('SELECT id,name,first_name,last_name,phone,email,address FROM dbo.customers WHERE id=@id',
        { id: { type: sql.Int, value: req.customerId } });
      res.json(c[0] || null);
    } catch (e) { next(e); }
  });

  // Save profile edits. We store first/last name separately and also keep a combined
  // `name` for order displays. Address only changes if one was actually sent (COALESCE).
  app.put('/api/me', requireCustomer, async (req, res, next) => {
    try {
      const b = req.body || {};
      const fn = (b.first_name || '').trim(), ln = (b.last_name || '').trim();
      const full = (fn + ' ' + ln).trim() || null;
      await query(`UPDATE dbo.customers SET
          first_name = @fn, last_name = @ln, name = @full,
          address    = COALESCE(@a, address)
        WHERE id=@id`, {
        id: { type: sql.Int, value: req.customerId },
        fn: { type: sql.NVarChar(100), value: fn || null },
        ln: { type: sql.NVarChar(100), value: ln || null },
        full: { type: sql.NVarChar(200), value: full },
        a: { type: sql.NVarChar(400), value: b.address != null ? b.address.trim() : null }
      });
      await logAudit(genBatch(), 'profile_edit', 'customer', req.customerId, null, full || b.address || '', null, 'customer:' + req.customerId);
      const c = await query('SELECT id,name,first_name,last_name,phone,email,address FROM dbo.customers WHERE id=@id', { id: { type: sql.Int, value: req.customerId } });
      res.json(c[0]);
    } catch (e) { next(e); }
  });

  // Order history. We match on customer_id, but ALSO on phone — so orders placed as a
  // guest (before the account existed) still show up once they log in with that number.
  app.get('/api/me/orders', requireCustomer, async (req, res, next) => {
    try {
      const orders = await query(`
        SELECT o.id, o.status, o.item_count, o.total,
               CONVERT(varchar(19), o.created_at, 120) AS created_at
        FROM dbo.orders o
        WHERE o.customer_id=@id
           OR o.customer_phone = (SELECT phone FROM dbo.customers WHERE id=@id)
        ORDER BY o.id DESC`, { id: { type: sql.Int, value: req.customerId } });
      res.json(orders);
    } catch (e) { next(e); }
  });

  // One order's details — but only if it belongs to this customer (same id-or-phone check).
  app.get('/api/me/orders/:id', requireCustomer, async (req, res, next) => {
    try {
      const id = { type: sql.Int, value: parseInt(req.params.id) };
      const cid = { type: sql.Int, value: req.customerId };
      const o = await query(`SELECT *, CONVERT(varchar(19), created_at, 120) AS created FROM dbo.orders
        WHERE id=@id AND (customer_id=@cid OR customer_phone=(SELECT phone FROM dbo.customers WHERE id=@cid))`, { id, cid });
      if (!o.length) return res.status(404).json({ error: 'not found' });
      const items = await query('SELECT name, barcode, qty, unit_price, line_total FROM dbo.order_items WHERE order_id=@id', { id });
      res.json({ order: o[0], items });
    } catch (e) { next(e); }
  });

  // Used by checkout: if a logged-in customer is placing the order, figure out their
  // id from the token — but DON'T fail if there's no token (guests can check out too).
  async function customerFromToken(token) {
    if (!token) return null;
    const r = await query('SELECT customer_id FROM dbo.customer_tokens WHERE token=@t',
      { t: { type: sql.NVarChar(64), value: String(token) } });
    return r.length ? r[0].customer_id : null;
  }

  return { requireCustomer, customerFromToken };
}

module.exports = { registerAuth, normPhone };
