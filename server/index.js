// ============================================================================
// FreshCart — main app server.
//
// This is the whole backend in one file: it serves the two front-ends (the
// customer storefront at "/" and the management console at "/admin") and all the
// JSON APIs they talk to. Data lives in a single SQLite file (see config.dbPath and
// db.js): the product catalog the storefront shows, plus the app's own orders,
// customers and audit log.
//
// Everything is wired up here, then `getPool().then(...)` at the very bottom opens
// the database and starts listening (plain http on cfg.port, and a self-signed
// https on cfg.httpsPort for installing as a phone PWA).
// ============================================================================
const express = require('express');
const path = require('path');
const { sql, getPool, query } = require('./db');
const cfg = require('./config');

// Feature modules — each one hangs its own routes off the app (see the register* calls below).
const { registerBulk } = require('./bulk');     // Excel import/export, logs, undo, backups
const { registerAuth } = require('./auth');     // customer phone-OTP login + "my account"
const priority = require('./priority');         // Priority ERP connector (not live yet)
const payment = require('./payment');           // payment gateway status (placeholder)
const sms = require('./sms');                    // OTP text sender (dev mode by default)

const fs = require('fs');
const app = express();
app.use(express.json({ limit: '30mb' })); // big limit so Excel uploads (base64) fit in the body

// APK downloads — served in one shot as a plain attachment so mobile browsers
// (esp. Samsung Internet) finalize the download instead of hanging at 100%.
app.get(['/store.apk', '/manager.apk'], (req, res) => {
  const name = req.path.endsWith('manager.apk') ? 'manager.apk' : 'store.apk';
  try {
    const buf = fs.readFileSync(path.join(cfg.publicDir, 'storefront', name));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(buf);
  } catch (e) { res.status(404).send('not found'); }
});

// Clean install-page URLs: /app and /install both serve the APK install page.
app.get(['/app', '/install'], (req, res) => res.sendFile(path.join(cfg.publicDir, 'storefront', 'install.html')));

// ---- static: images + the two front-end apps ----
// app shell (html/js/css) must never be cached so changes show immediately; images can cache
const freshShell = (res, p) => { if (!/\.(png|jpe?g|gif|svg|ico|webp|woff2?)$/i.test(p)) res.setHeader('Cache-Control', 'no-store'); };
app.use('/images', express.static(cfg.imagesDir, { fallthrough: true, maxAge: '7d' }));
app.use('/admin', express.static(path.join(cfg.publicDir, 'admin'), { setHeaders: freshShell }));
app.use('/', express.static(path.join(cfg.publicDir, 'storefront'), { setHeaders: freshShell }));

// Escape %, _ and \ with a backslash so LIKE treats them literally, then wrap in %...%
// for a "contains" match. The db layer pairs this with an ESCAPE '\' on every LIKE @param,
// so a search for "50%" doesn't match everything.
const like = v => '%' + String(v).replace(/[\\%_]/g, m => '\\' + m) + '%';

// ---- admin auth (simple token gate) ----
// Admin routes just check a fixed token in the header. The token is handed out by
// /api/admin/login below after a correct password. (Fine for a single-shop setup.)
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] === cfg.adminToken) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// shared audit-log writer. actor: null/'admin' = employee action, 'customer:<id|phone>' = customer action
// Swallows its own errors on purpose — a failed log should never break the real action.
async function logAudit(batch, action, entity, entityId, oldVal, newVal, field, actor) {
  try {
    await query(`INSERT INTO dbo.audit_log (batch_id,action,entity,entity_id,field,old_value,new_value,actor)
                 VALUES (@b,@a,@e,@eid,@f,@o,@n,@act)`, {
      b: { type: sql.NVarChar(40), value: batch }, a: { type: sql.NVarChar(60), value: action },
      e: { type: sql.NVarChar(40), value: entity }, eid: { type: sql.Int, value: entityId },
      f: { type: sql.NVarChar(60), value: field || null },
      o: { type: sql.NVarChar(sql.MAX), value: oldVal == null ? null : String(oldVal) },
      n: { type: sql.NVarChar(sql.MAX), value: newVal == null ? null : String(newVal) },
      act: { type: sql.NVarChar(80), value: actor || 'admin' }
    });
  } catch (e) { console.error('audit', e.message); }
}
// Employee login: trade the shop password for the admin token the UI then sends on every call.
app.post('/api/admin/login', (req, res) => {
  if ((req.body && req.body.password) === cfg.adminPassword) res.json({ token: cfg.adminToken });
  else res.status(401).json({ error: 'סיסמה שגויה' });
});

// ---- customer accounts: phone OTP login, /api/me, order history ----
// registerAuth returns helpers we reuse below (e.g. figuring out the customer at checkout).
const auth = registerAuth(app, { sql, query, logAudit });

// ---------------- CATALOG ----------------
// Top-level categories for the storefront menu. We only count VISIBLE products and
// hide any category that ends up empty, so the menu never shows a dead link.
app.get('/api/categories', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT c.id, c.name_he, c.name_en, COUNT(DISTINCT pc.product_id) AS n
      FROM dbo.product_categories pc
      JOIN dbo.categories c ON c.id = pc.category_id
      JOIN dbo.products p   ON p.id = pc.product_id AND p.is_visible = 1
      WHERE pc.level = 0
      GROUP BY c.id, c.name_he, c.name_en
      HAVING COUNT(DISTINCT pc.product_id) > 0
      ORDER BY n DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

// sub-categories of a given category (derived from the product category paths)
// Each product stores its category as a path (level 0 > 1 > 2...); here we find the
// level just below the parent by joining the path to itself on the same product+path.
app.get('/api/categories/:id/children', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT child.category_id AS id, c.name_he, c.name_en,
             COUNT(DISTINCT child.product_id) AS n
      FROM dbo.product_categories parent
      JOIN dbo.product_categories child
        ON child.product_id = parent.product_id
       AND child.path_index = parent.path_index
       AND child.level = parent.level + 1
      JOIN dbo.categories c ON c.id = child.category_id
      JOIN dbo.products p   ON p.id = child.product_id AND p.is_visible = 1
      WHERE parent.category_id = @id
      GROUP BY child.category_id, c.name_he, c.name_en
      HAVING COUNT(DISTINCT child.product_id) > 0
      ORDER BY n DESC`, { id: { type: sql.Int, value: parseInt(req.params.id) } });
    res.json(rows);
  } catch (e) { next(e); }
});

// The main product listing — powers search, category browsing, sorting and paging.
app.get('/api/products', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(60, Math.max(1, parseInt(req.query.pageSize) || 24)); // cap page size at 60
    // Only these sort options are allowed — the value is dropped straight into ORDER BY,
    // so it must come from this map, never from the raw query string.
    const sortMap = {
      name: 'p.name_he ASC',
      price_asc: 'p.regular_price ASC',
      price_desc: 'p.regular_price DESC'
    };
    const order = sortMap[req.query.sort] || sortMap.name;

    // Shoppers only ever see visible products that have a real price.
    const where = ['p.is_visible = 1', 'p.regular_price > 0'];
    const params = {};
    if (req.query.q) {
      where.push('(p.name_he LIKE @q OR p.name_en LIKE @q OR p.local_name LIKE @q OR p.barcode LIKE @q)');
      params.q = like(req.query.q);
    }
    if (req.query.category) {
      where.push('EXISTS (SELECT 1 FROM dbo.product_categories pc WHERE pc.product_id = p.id AND pc.category_id = @cat)');
      params.cat = { type: sql.Int, value: parseInt(req.query.category) };
    }
    const W = where.join(' AND ');

    // Count first (for the pager), then fetch just this page's rows.
    const totalRow = await query(`SELECT COUNT(*) AS n FROM dbo.products p WHERE ${W}`, params);
    const total = totalRow[0].n;
    const items = await query(`
      SELECT p.id, p.product_id, p.barcode, p.name_he, p.name_en, p.regular_price,
             p.image_file, p.stock_qty, p.is_weighable, p.uom_he, p.weight,
             b.name_he AS brand_he, a.name AS aisle
      FROM dbo.products p
      LEFT JOIN dbo.brands b ON b.brand_id = p.brand_id
      LEFT JOIN dbo.aisles a ON a.aisle_id = p.aisle_id
      WHERE ${W}
      ORDER BY ${order}
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`,
      { ...params, off: { type: sql.Int, value: (page - 1) * size }, lim: { type: sql.Int, value: size } });
    res.json({ total, page, pageSize: size, items });
  } catch (e) { next(e); }
});

// One product in full — the product-detail page. Pulls the core row plus its long-form
// content, all images, and the category breadcrumb (following the product's MAIN path).
app.get('/api/products/:id', async (req, res, next) => {
  try {
    const id = { type: sql.Int, value: parseInt(req.params.id) };
    const p = await query(`
      SELECT p.*, b.name_he AS brand_he, b.name_en AS brand_en,
             d.name AS department, o.name AS origin_country, a.name AS aisle
      FROM dbo.products p
      LEFT JOIN dbo.brands b ON b.brand_id = p.brand_id
      LEFT JOIN dbo.departments d ON d.department_id = p.department_id
      LEFT JOIN dbo.origin_countries o ON o.code = p.origin_code
      LEFT JOIN dbo.aisles a ON a.aisle_id = p.aisle_id
      WHERE p.id = @id`, { id });
    if (!p.length) return res.status(404).json({ error: 'not found' });
    const content = await query(`SELECT * FROM dbo.product_content WHERE product_id = @id`, { id });
    const images = await query(`SELECT url, position FROM dbo.product_images WHERE product_id = @id ORDER BY position`, { id });
    // Breadcrumb: the category chain for this product's main path (path_index), in order.
    const cats = await query(`
      SELECT c.id, c.name_he, pc.level FROM dbo.product_categories pc
      JOIN dbo.categories c ON c.id = pc.category_id
      WHERE pc.product_id = @id AND pc.path_index = COALESCE((SELECT main_category_path_index FROM dbo.products WHERE id=@id),0)
      ORDER BY pc.level`, { id });
    res.json({ product: p[0], content: content[0] || null, images, categoryPath: cats });
  } catch (e) { next(e); }
});

// ---------------- ORDERS (checkout) ----------------
// Place an order. Note we re-price every line from the DB — the client's prices are
// never trusted. The order (orders + order_items) goes in one transaction; the stock
// decrement happens AFTER commit so the (best-effort) catalog update is never what
// holds the order transaction open.
app.post('/api/orders', async (req, res, next) => {
  const { customer = {}, items = [] } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'empty cart' });
  // if a logged-in customer placed this, link it to their account
  const customerId = await auth.customerFromToken(req.headers['x-customer-token']);
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  try {
    await tx.begin();
    // price every line from the DB (never trust client prices)
    let total = 0, count = 0;
    const lines = [];
    for (const it of items) {
      const r = await new sql.Request(tx)
        .input('id', sql.Int, parseInt(it.id))
        .query('SELECT id, barcode, name_he, regular_price, stock_qty FROM dbo.products WHERE id=@id AND is_visible=1');
      if (!r.recordset.length) continue; // skip anything that vanished or got hidden
      const p = r.recordset[0];
      const qty = Math.max(1, Math.min(999, parseInt(it.qty) || 1)); // clamp to a sane range
      const lineTotal = Math.round(p.regular_price * qty * 100) / 100;
      total += lineTotal; count += qty;
      lines.push({ product_id: p.id, barcode: p.barcode, name: p.name_he, unit_price: p.regular_price, qty, line_total: lineTotal });
    }
    if (!lines.length) { await tx.rollback(); return res.status(400).json({ error: 'no valid items' }); }

    // Create the order header and grab its new id.
    const ins = await new sql.Request(tx)
      .input('cn', sql.NVarChar(200), customer.name || null)
      .input('cp', sql.NVarChar(40), customer.phone || null)
      .input('ca', sql.NVarChar(400), customer.address || null)
      .input('note', sql.NVarChar(500), customer.note || null)
      .input('cid', sql.Int, customerId)
      .input('ic', sql.Int, count)
      .input('tot', sql.Decimal(12, 2), total)
      .query(`INSERT INTO dbo.orders (customer_name,customer_phone,customer_address,note,customer_id,item_count,total)
              OUTPUT INSERTED.id VALUES (@cn,@cp,@ca,@note,@cid,@ic,@tot)`);
    const orderId = ins.recordset[0].id;

    // One row per line.
    for (const l of lines) {
      await new sql.Request(tx)
        .input('oid', sql.Int, orderId).input('pid', sql.Int, l.product_id)
        .input('bc', sql.NVarChar(32), l.barcode).input('nm', sql.NVarChar(300), l.name)
        .input('up', sql.Decimal(12, 2), l.unit_price).input('q', sql.Int, l.qty)
        .input('lt', sql.Decimal(12, 2), l.line_total)
        .query(`INSERT INTO dbo.order_items (order_id,product_id,barcode,name,unit_price,qty,line_total)
                VALUES (@oid,@pid,@bc,@nm,@up,@q,@lt)`);
    }
    await tx.commit();
    // decrement stock after commit (kept out of the order transaction on purpose)
    for (const l of lines) {
      try {
        await query(`UPDATE dbo.products SET stock_qty = CASE WHEN stock_qty IS NULL THEN NULL
                ELSE CASE WHEN stock_qty-@q < 0 THEN 0 ELSE stock_qty-@q END END WHERE id=@pid`,
          { q: { type: sql.Int, value: l.qty }, pid: { type: sql.Int, value: l.product_id } });
      } catch (e) { /* stock is best-effort on the placeholder catalog */ }
    }
    // Log it under the customer (id if known, else phone, else "guest").
    await logAudit('C' + Date.now().toString(36).toUpperCase(), 'order_placed', 'order', orderId,
      null, `${count} פריטים · ${Math.round(total * 100) / 100} ₪`, null,
      customerId ? 'customer:' + customerId : 'customer:' + (customer.phone || 'אורח'));
    res.json({ id: orderId, total, item_count: count });
  } catch (e) { try { await tx.rollback(); } catch (_) {} next(e); }
});

// ---------------- ADMIN ----------------
// Dashboard tiles: a handful of counts/sums in one round trip.
app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
  try {
    const s = await query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.products) AS products,
        (SELECT COUNT(*) FROM dbo.products WHERE is_visible=1) AS visible,
        (SELECT COUNT(*) FROM dbo.products WHERE stock_qty <= 5) AS low_stock,
        (SELECT COUNT(*) FROM dbo.orders) AS orders,
        (SELECT ISNULL(SUM(total),0) FROM dbo.orders) AS revenue,
        (SELECT COUNT(*) FROM dbo.orders WHERE status='new') AS new_orders`);
    res.json(s[0]);
  } catch (e) { next(e); }
});

// Quick single-product edit from the admin grid (price / stock / visibility). COALESCE
// means "only change the fields that were actually sent" — leave the rest as they are.
app.put('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const { regular_price, stock_qty, is_visible } = req.body || {};
    await query(`UPDATE dbo.products SET
        regular_price = COALESCE(@price, regular_price),
        stock_qty     = COALESCE(@stock, stock_qty),
        is_visible    = COALESCE(@vis, is_visible)
       WHERE id=@id`, {
      id: { type: sql.Int, value: parseInt(req.params.id) },
      price: { type: sql.Decimal(12, 2), value: regular_price != null ? Number(regular_price) : null },
      stock: { type: sql.Int, value: stock_qty != null ? parseInt(stock_qty) : null },
      vis: { type: sql.Bit, value: is_visible != null ? (is_visible ? 1 : 0) : null }
    });
    const row = await query('SELECT id, regular_price, stock_qty, is_visible FROM dbo.products WHERE id=@id',
      { id: { type: sql.Int, value: parseInt(req.params.id) } });
    await logAudit('P' + Date.now().toString(36).toUpperCase(), 'product_edit', 'products', parseInt(req.params.id),
      null, `מחיר:${regular_price ?? '-'} מלאי:${stock_qty ?? '-'} מוצג:${is_visible ?? '-'}`);
    res.json(row[0]);
  } catch (e) { next(e); }
});

// Orders list for the admin (newest 200).
app.get('/api/orders', requireAdmin, async (req, res, next) => {
  try {
    const rows = await query(`SELECT TOP 200 id, customer_name, customer_phone, status, item_count, total,
      CONVERT(varchar(19), created_at, 120) AS created_at FROM dbo.orders ORDER BY id DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

// One order for the admin — header, its items, and (if it was ever edited) the original
// snapshot we saved so staff can see what the customer first ordered.
app.get('/api/orders/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = { type: sql.Int, value: parseInt(req.params.id) };
    const o = await query('SELECT *, CONVERT(varchar(19), created_at, 120) AS created FROM dbo.orders WHERE id=@id', { id });
    if (!o.length) return res.status(404).json({ error: 'not found' });
    const items = await query('SELECT * FROM dbo.order_items WHERE order_id=@id', { id });
    let original = null;
    if (o[0].original_json) { try { original = JSON.parse(o[0].original_json); } catch (e) {} }
    res.json({ order: o[0], items, original });
  } catch (e) { next(e); }
});

// Change just an order's status (new / packing / ready / ...).
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const status = String(req.body.status || 'new');
    await query('UPDATE dbo.orders SET status=@s WHERE id=@id',
      { id: { type: sql.Int, value: id }, s: { type: sql.NVarChar(30), value: status } });
    await logAudit('O' + Date.now().toString(36).toUpperCase(), 'order_status', 'order', id, null, status);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// edit an order: replace its items (add/remove/qty/price), recompute totals, log the change
app.put('/api/admin/orders/:id', requireAdmin, async (req, res, next) => {
  const id = parseInt(req.params.id);
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  const status = req.body.status;
  const pool = await getPool(); const tx = new sql.Transaction(pool); await tx.begin();
  try {
    const curO = (await new sql.Request(tx).input('id', sql.Int, id).query('SELECT * FROM dbo.orders WHERE id=@id')).recordset[0];
    if (!curO) { await tx.rollback(); return res.status(404).json({ error: 'not found' }); }
    let newTotal = curO.total, newCount = curO.item_count;
    if (items) {
      // snapshot the customer's original order the first time it is edited
      if (curO.original_json == null) {
        const origItems = (await new sql.Request(tx).input('id', sql.Int, id)
          .query('SELECT name,barcode,qty,unit_price,line_total FROM dbo.order_items WHERE order_id=@id')).recordset;
        const snap = JSON.stringify({ at: new Date().toISOString(), total: curO.total, item_count: curO.item_count, items: origItems });
        await new sql.Request(tx).input('id', sql.Int, id).input('j', sql.NVarChar(sql.MAX), snap)
          .query('UPDATE dbo.orders SET original_json=@j WHERE id=@id');
      }
      // wipe and re-insert the lines, recomputing the totals as we go
      await new sql.Request(tx).input('id', sql.Int, id).query('DELETE FROM dbo.order_items WHERE order_id=@id');
      newTotal = 0; newCount = 0;
      for (const it of items) {
        const qty = Math.max(1, Math.min(999, parseInt(it.qty) || 1));
        const price = Math.round((Number(it.unit_price) || 0) * 100) / 100;
        const line = Math.round(price * qty * 100) / 100;
        newTotal += line; newCount += qty;
        await new sql.Request(tx)
          .input('oid', sql.Int, id).input('pid', sql.Int, it.product_id ? parseInt(it.product_id) : null)
          .input('bc', sql.NVarChar(32), it.barcode || null).input('nm', sql.NVarChar(300), it.name || null)
          .input('up', sql.Decimal(12, 2), price).input('q', sql.Int, qty).input('lt', sql.Decimal(12, 2), line)
          .query('INSERT INTO dbo.order_items (order_id,product_id,barcode,name,unit_price,qty,line_total) VALUES (@oid,@pid,@bc,@nm,@up,@q,@lt)');
      }
      newTotal = Math.round(newTotal * 100) / 100;
      await new sql.Request(tx).input('id', sql.Int, id).input('t', sql.Decimal(12, 2), newTotal).input('c', sql.Int, newCount)
        .query('UPDATE dbo.orders SET total=@t, item_count=@c WHERE id=@id');
    }
    if (status) await new sql.Request(tx).input('id', sql.Int, id).input('s', sql.NVarChar(30), String(status)).query('UPDATE dbo.orders SET status=@s WHERE id=@id');
    // log the before→after totals so the edit shows up in the history
    const batch = 'O' + Date.now().toString(36).toUpperCase();
    await new sql.Request(tx)
      .input('b', sql.NVarChar(40), batch).input('a', sql.NVarChar(60), 'order_edit').input('e', sql.NVarChar(40), 'order').input('eid', sql.Int, id)
      .input('o', sql.NVarChar(sql.MAX), `${curO.item_count} פריטים · ${curO.total} ₪`)
      .input('n', sql.NVarChar(sql.MAX), `${newCount} פריטים · ${newTotal} ₪`)
      .query('INSERT INTO dbo.audit_log (batch_id,action,entity,entity_id,old_value,new_value) VALUES (@b,@a,@e,@eid,@o,@n)');
    await tx.commit();
    res.json({ ok: true, total: newTotal, item_count: newCount });
  } catch (e) { try { await tx.rollback(); } catch (_) {} next(e); }
});

// Cancel an order (soft — just flips the status, keeps the record).
app.post('/api/admin/orders/:id/cancel', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await query('UPDATE dbo.orders SET status=\'cancelled\' WHERE id=@id', { id: { type: sql.Int, value: id } });
    await logAudit('O' + Date.now().toString(36).toUpperCase(), 'order_cancel', 'order', id, null, 'cancelled');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- bulk Excel import/export, logs, undo, backup ----
registerBulk(app, { sql, query, getPool, requireAdmin, cfg });

// ---- integrations status (ERP / payment) ----
// What the admin "integrations" panel reads to show whether each service is connected.
app.get('/api/admin/integrations', requireAdmin, (req, res) => {
  res.json({ priority: priority.status(), payment: payment.status(), sms: sms.status() });
});
// "Test connection" button for Priority — tries a small fetch and reports ok/error.
app.post('/api/admin/priority/test', requireAdmin, async (req, res) => {
  try { const d = await priority.fetchProducts(); res.json({ ok: true, sample: d }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---- cross-store catalog comparison ----
// These power the admin tool that compares a product's price across our stores
// (Greenfield / ValueMart / SuperSaver). The data lives in catalog_items + catalog_stores.
// List the stores we compare, with how many items each one has.
app.get('/api/admin/compare/stores', requireAdmin, async (req, res, next) => {
  try {
    const rows = await query(`SELECT s.store, s.label, s.accent, s.sort,
        (SELECT COUNT(*) FROM dbo.catalog_items ci WHERE ci.store=s.store) AS items
      FROM dbo.catalog_stores s ORDER BY s.sort`);
    res.json(rows);
  } catch (e) { next(e); }
});

// search by name or barcode -> each matching product with its price in every store
// We first find up to 40 matching barcodes, then pull every store's row for those
// barcodes and fold them into one object per barcode with a prices-by-store map.
app.get('/api/admin/compare', requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const stores = await query(`SELECT store,label,accent,sort FROM dbo.catalog_stores ORDER BY sort`);
    if (q.length < 2) return res.json({ stores, items: [] }); // need at least 2 chars to search
    const bcs = await query(`SELECT TOP 40 barcode, MAX(name) AS name
        FROM dbo.catalog_items
        WHERE barcode IS NOT NULL AND (barcode LIKE @bq OR name LIKE @q)
        GROUP BY barcode ORDER BY MAX(name)`, { bq: like(q), q: like(q) });
    if (!bcs.length) return res.json({ stores, items: [] });
    // Build a safe IN (...) list of the matched barcodes as individual parameters.
    const barcodes = bcs.map(r => r.barcode);
    const inClause = barcodes.map((_, i) => '@b' + i).join(',');
    const params = {}; barcodes.forEach((b, i) => params['b' + i] = { type: sql.NVarChar(32), value: b });
    const rows = await query(`SELECT store,barcode,name,brand,price,image_file,image_url
        FROM dbo.catalog_items WHERE barcode IN (${inClause})`, params);
    // Group by barcode; take the first non-empty name/brand/image we see across stores.
    const byBc = {};
    for (const r of rows) {
      const g = byBc[r.barcode] || (byBc[r.barcode] = { barcode: r.barcode, name: null, brand: null, image_file: null, image_url: null, prices: {} });
      g.prices[r.store] = r.price;
      if (r.name && !g.name) g.name = r.name;
      if (r.brand && !g.brand) g.brand = r.brand;
      if (r.image_file && !g.image_file) g.image_file = r.image_file;
      if (r.image_url && !g.image_url) g.image_url = r.image_url;
    }
    // Return in the same order as the barcode search results.
    res.json({ stores, items: barcodes.map(b => byBc[b]).filter(Boolean) });
  } catch (e) { next(e); }
});

// browse one store's full product list (paginated)
app.get('/api/admin/store-products', requireAdmin, async (req, res, next) => {
  try {
    const store = String(req.query.store || '');
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(60, Math.max(1, parseInt(req.query.pageSize) || 30));
    const where = ['store=@store']; const params = { store: { type: sql.NVarChar(40), value: store } };
    if (q) { where.push('(name LIKE @q OR barcode LIKE @q OR brand LIKE @q)'); params.q = like(q); }
    const W = where.join(' AND ');
    const tot = await query(`SELECT COUNT(*) AS n FROM dbo.catalog_items WHERE ${W}`, params);
    const items = await query(`SELECT barcode,name,brand,price,image_file,image_url,category,uom,is_weighable
        FROM dbo.catalog_items WHERE ${W} ORDER BY name
        OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`,
      { ...params, off: { type: sql.Int, value: (page - 1) * size }, lim: { type: sql.Int, value: size } });
    res.json({ total: tot[0].n, page, pageSize: size, items });
  } catch (e) { next(e); }
});

// full per-store details for one barcode
app.get('/api/admin/catalog/:barcode', requireAdmin, async (req, res, next) => {
  try {
    const bc = String(req.params.barcode);
    const stores = await query(`SELECT store,label,accent,sort FROM dbo.catalog_stores ORDER BY sort`);
    const rows = await query(`SELECT * FROM dbo.catalog_items WHERE barcode=@bc`,
      { bc: { type: sql.NVarChar(32), value: bc } });
    res.json({ barcode: bc, stores, rows });
  } catch (e) { next(e); }
});

// Catch-all error handler: log it server-side, send a clean 500 to the client.
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: err.message });
});

// Spin up HTTPS with a self-signed cert. Phones refuse to install a PWA / trust some
// features over plain http, so we generate a throwaway cert on boot and serve https too.
async function startHttps() {
  try {
    const https = require('https');
    const selfsigned = require('selfsigned');
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'FreshCart' }],
      { days: 3650, keySize: 2048 });
    https.createServer({ key: pems.private, cert: pems.cert }, app)
      .listen(cfg.httpsPort, '0.0.0.0',
        () => console.log(`FreshCart (https): https://localhost:${cfg.httpsPort}   <-- use this URL to install as a phone PWA`));
  } catch (e) { console.log('HTTPS not started (http still works):', e.message); }
}

// Boot: make sure the DB pool connects first (fail fast if it can't), then start
// listening on http, then bring up https alongside it.
getPool().then(async () => {
  app.listen(cfg.port, '0.0.0.0',
    () => console.log(`FreshCart (http):  http://localhost:${cfg.port}   (admin: /admin)`));
  await startHttps();
}).catch(e => { console.error('DB connect failed:', e.message); process.exit(1); });
