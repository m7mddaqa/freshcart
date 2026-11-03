// Excel bulk operations for the admin: download a template, upload it, preview the
// changes, apply them (logged + undoable), and make backups.
//
// The flow for the user is: pick an operation -> download its .xlsx template ->
// fill it in Excel -> upload -> we show a preview of exactly what will change ->
// they confirm -> we apply it all in one transaction and log every change so the
// whole batch can be undone with one click.
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// The operations we support. For each, `cols` describes the spreadsheet columns:
//   kind 'key'  = used to find the product (the barcode)
//   kind 'ref'  = read-only, just shown to the user for reference (ignored on import)
//   kind 'edit' = a value we actually write (with a `type` so we know how to read it)
const TYPES = {
  prices: {
    title: 'עדכון מחירים', target: 'products',
    cols: [
      { k: 'barcode', h: 'ברקוד', kind: 'key' },
      { k: 'name', h: 'שם המוצר (לעיון)', kind: 'ref' },
      { k: 'current', h: 'מחיר נוכחי (לעיון)', kind: 'ref' },
      { k: 'regular_price', h: 'מחיר חדש', kind: 'edit', type: 'num' }
    ]
  },
  stock: {
    title: 'עדכון מלאי', target: 'products',
    cols: [
      { k: 'barcode', h: 'ברקוד', kind: 'key' },
      { k: 'name', h: 'שם המוצר (לעיון)', kind: 'ref' },
      { k: 'current', h: 'מלאי נוכחי (לעיון)', kind: 'ref' },
      { k: 'stock_qty', h: 'מלאי חדש', kind: 'edit', type: 'int' }
    ]
  },
  products: {
    title: 'עריכת מוצרים', target: 'products',
    cols: [
      { k: 'barcode', h: 'ברקוד', kind: 'key' },
      { k: 'name_he', h: 'שם בעברית', kind: 'edit', type: 'text' },
      { k: 'name_en', h: 'שם באנגלית', kind: 'edit', type: 'text' },
      { k: 'regular_price', h: 'מחיר', kind: 'edit', type: 'num' },
      { k: 'stock_qty', h: 'מלאי', kind: 'edit', type: 'int' },
      { k: 'is_visible', h: 'מוצג בחנות (1/0)', kind: 'edit', type: 'bit' }
    ]
  },
  descriptions: {
    title: 'עריכת תיאורים', target: 'product_content',
    cols: [
      { k: 'barcode', h: 'ברקוד', kind: 'key' },
      { k: 'name', h: 'שם המוצר (לעיון)', kind: 'ref' },
      { k: 'description_he', h: 'תיאור', kind: 'edit', type: 'text' },
      { k: 'ingredients_he', h: 'רכיבים', kind: 'edit', type: 'text' },
      { k: 'warnings_he', h: 'אזהרות', kind: 'edit', type: 'text' },
      { k: 'storage_he', h: 'אחסון', kind: 'edit', type: 'text' }
    ]
  },
  new_products: {
    title: 'הוספת מוצרים חדשים', target: 'insert',
    cols: [
      { k: 'barcode', h: 'ברקוד', kind: 'key' },
      { k: 'name_he', h: 'שם בעברית', kind: 'edit', type: 'text' },
      { k: 'name_en', h: 'שם באנגלית', kind: 'edit', type: 'text' },
      { k: 'regular_price', h: 'מחיר', kind: 'edit', type: 'num' },
      { k: 'stock_qty', h: 'מלאי', kind: 'edit', type: 'int' }
    ]
  }
};

// Whitelists of columns an import is allowed to touch. We check against these before
// ever putting a column name into SQL — so a crafted spreadsheet header can't become
// an injection (see safeCol at the bottom).
const PRODUCT_COLS = { regular_price: 1, stock_qty: 1, is_visible: 1, name_he: 1, name_en: 1, barcode: 1 };
const CONTENT_COLS = { description_he: 1, ingredients_he: 1, warnings_he: 1, storage_he: 1 };

// Turn a raw cell value into the right type. Blank cells become null (= "leave alone").
// num accepts a comma as a decimal point (Hebrew Excel habit); bit accepts 1/true/כן/yes.
function coerce(v, type) {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'num') { const n = Number(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
  if (type === 'int') { const n = parseInt(v); return isNaN(n) ? null : n; }
  if (type === 'bit') { const s = String(v).trim().toLowerCase(); return (s === '1' || s === 'true' || s === 'כן' || s === 'yes') ? 1 : 0; }
  return String(v);
}
// Read a cell by its header, tolerating stray spaces Excel sometimes adds to headers.
function getCell(row, header) {
  if (row[header] !== undefined) return row[header];
  const want = String(header).trim();
  for (const key of Object.keys(row)) if (String(key).trim() === want) return row[key];
  return undefined;
}

// Wires the bulk routes onto the app. `ctx` hands us the db helpers + admin gate.
function registerBulk(app, ctx) {
  const { sql, query, getPool, requireAdmin, cfg } = ctx;
  const backupsDir = path.join(__dirname, 'backups');
  try { fs.mkdirSync(backupsDir, { recursive: true }); } catch (e) {}

  // The admin UI calls this to list the operations + their column headers.
  app.get('/api/admin/import-types', requireAdmin, (req, res) => {
    res.json(Object.entries(TYPES).map(([id, t]) => ({ id, title: t.title,
      columns: t.cols.map(c => ({ h: c.h, kind: c.kind })) })));
  });

  // Build and send an .xlsx template: a header row, plus up to 5 real products as
  // example rows so the user can see the expected format (new_products gets one fake row).
  app.get('/api/admin/template/:type', requireAdmin, async (req, res, next) => {
    try {
      const T = TYPES[req.params.type]; if (!T) return res.status(404).json({ error: 'unknown type' });
      const headers = T.cols.map(c => c.h);
      const aoa = [headers]; // "array of arrays" — row 0 is the headers
      if (req.params.type !== 'new_products') {
        const rows = await query(`SELECT TOP 5 p.barcode, p.name_he, p.name_en, p.regular_price, p.stock_qty, p.is_visible
          FROM dbo.products p WHERE p.barcode IS NOT NULL ORDER BY p.id`);
        for (const r of rows) {
          // Fill each column of the sample row based on what that column means.
          aoa.push(T.cols.map(c => {
            if (c.k === 'barcode') return r.barcode;
            if (c.k === 'name') return r.name_he;
            if (c.k === 'current') return (req.params.type === 'stock') ? r.stock_qty : r.regular_price;
            if (c.k === 'name_he') return r.name_he;
            if (c.k === 'name_en') return r.name_en;
            if (c.k === 'regular_price') return r.regular_price;
            if (c.k === 'stock_qty') return r.stock_qty;
            if (c.k === 'is_visible') return r.is_visible;
            return '';
          }));
        }
      } else {
        aoa.push(['1234567890123', 'מוצר לדוגמה', 'Sample Product', 9.90, 50]);
      }
      // Turn the rows into a real .xlsx and stream it as a download.
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = headers.map(() => ({ wch: 22 })); // make columns a bit wider
      XLSX.utils.book_append_sheet(wb, ws, 'template');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="freshcart_${req.params.type}_template.xlsx"`);
      res.send(buf);
    } catch (e) { next(e); }
  });

  // Read an uploaded .xlsx (sent as base64) into tidy rows: { _row, barcode, values{} }.
  // _row is the spreadsheet line number (for error messages). We drop empty rows.
  function parseFile(type, b64) {
    const T = TYPES[type];
    const wb = XLSX.read(Buffer.from(b64, 'base64'), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
    return raw.map((row, i) => {
      const o = { _row: i + 2, barcode: null, values: {} }; // +2: header is row 1, data starts at 2
      for (const c of T.cols) {
        const v = getCell(row, c.h);
        if (c.kind === 'key') o.barcode = v == null ? null : String(v).trim();
        else if (c.kind === 'edit') { const cv = coerce(v, c.type); if (cv !== null) o.values[c.k] = cv; }
      }
      return o;
    }).filter(r => r.barcode || Object.keys(r.values).length);
  }

  // The workhorse: with apply=false it returns a PREVIEW (what would change + any
  // errors); with apply=true it actually makes the changes, in one transaction, logged.
  app.post('/api/admin/import/:type', requireAdmin, async (req, res, next) => {
    const type = req.params.type; const T = TYPES[type];
    if (!T) return res.status(404).json({ error: 'unknown type' });
    const apply = !!(req.body && req.body.apply);
    try {
      const rows = parseFile(type, req.body.fileB64);
      // Look up the current DB state for every barcode in the file (so we can show
      // old→new and skip rows that don't actually change anything).
      const barcodes = rows.map(r => r.barcode).filter(Boolean);
      const current = {};
      if (barcodes.length) {
        const pool = await getPool(); const reqdb = pool.request();
        const inList = barcodes.map((b, i) => { reqdb.input('b' + i, sql.NVarChar(32), b); return '@b' + i; }).join(',');
        const r = await reqdb.query(`SELECT id, product_id, barcode, name_he, name_en, regular_price, stock_qty, is_visible
          FROM dbo.products WHERE barcode IN (${inList})`);
        r.recordset.forEach(p => current[p.barcode] = p);
      }
      // Walk every row and decide: is it a valid change, or an error we should report?
      const changes = [], errors = [];
      for (const row of rows) {
        if (!row.barcode) { errors.push({ row: row._row, msg: 'חסר ברקוד' }); continue; }
        const cur = current[row.barcode];
        if (type === 'new_products') {
          if (cur) { errors.push({ row: row._row, barcode: row.barcode, msg: 'ברקוד כבר קיים' }); continue; }
          if (!row.values.name_he) { errors.push({ row: row._row, barcode: row.barcode, msg: 'חסר שם' }); continue; }
          changes.push({ row: row._row, barcode: row.barcode, action: 'insert', name: row.values.name_he, values: row.values });
          continue;
        }
        if (!cur) { errors.push({ row: row._row, barcode: row.barcode, msg: 'מוצר לא נמצא' }); continue; }
        if (type === 'descriptions') {
          // description edits live in product_content, one change per filled field
          for (const f of Object.keys(row.values))
            changes.push({ row: row._row, barcode: row.barcode, pid: cur.product_id, id: cur.id, name: cur.name_he, entity: 'product_content', field: f, old: null, new: row.values[f] });
        } else {
          for (const f of Object.keys(row.values)) {
            const oldV = cur[f];
            if (String(oldV) === String(row.values[f])) continue; // value is the same — nothing to do
            changes.push({ row: row._row, barcode: row.barcode, id: cur.id, name: cur.name_he, entity: 'products', field: f, old: oldV, new: row.values[f] });
          }
        }
      }

      // Preview mode: just tell the UI what WOULD happen (capped so the response stays small).
      if (!apply) {
        return res.json({ preview: true, type, totalRows: rows.length, changeCount: changes.length,
          errorCount: errors.length, changes: changes.slice(0, 200), errors: errors.slice(0, 100) });
      }

      // ---- APPLY: everything inside one transaction, and every change logged, so the
      //      whole batch is all-or-nothing and can be undone later via the batch id. ----
      const batch = 'B' + Date.now().toString(36).toUpperCase();
      const pool = await getPool(); const tx = new sql.Transaction(pool); await tx.begin();
      try {
        let applied = 0;
        let nextId = null; // only computed if we actually insert new products
        for (const ch of changes) {
          if (ch.action === 'insert') {
            // New product: give it a fresh id above anything existing, then insert.
            if (nextId === null) { const m = await new sql.Request(tx).query('SELECT ISNULL(MAX(id),20000000)+1 AS n FROM dbo.products'); nextId = m.recordset[0].n; }
            const id = nextId++; const v = ch.values;
            await new sql.Request(tx)
              .input('id', sql.Int, id).input('pid', sql.BigInt, id)
              .input('bc', sql.NVarChar(32), ch.barcode)
              .input('nh', sql.NVarChar(300), v.name_he || null).input('ne', sql.NVarChar(300), v.name_en || null)
              .input('pr', sql.Decimal(12, 2), v.regular_price != null ? v.regular_price : 0)
              .input('st', sql.Int, v.stock_qty != null ? v.stock_qty : 0)
              .query(`INSERT INTO dbo.products (id,product_id,barcode,name_he,name_en,regular_price,tax_amount,stock_qty,is_active,is_visible,branch_id)
                      VALUES (@id,@pid,@bc,@nh,@ne,@pr,0.18,@st,1,1,2902)`);
            await logChange(tx, batch, 'insert', 'products:new', id, null, null, ch.barcode);
            applied++;
          } else if (ch.entity === 'product_content') {
            // Description field: make sure a content row exists, record the OLD value
            // (so undo can restore it), then write the new value.
            const ex = await new sql.Request(tx).input('p', sql.Int, ch.pid).query('SELECT * FROM dbo.product_content WHERE product_id=@p');
            if (!ex.recordset.length) await new sql.Request(tx).input('p', sql.Int, ch.pid).query('INSERT INTO dbo.product_content (product_id) VALUES (@p)');
            const oldV = ex.recordset.length ? ex.recordset[0][ch.field] : null;
            await new sql.Request(tx).input('p', sql.Int, ch.pid).input('v', sql.NVarChar(sql.MAX), ch.new)
              .query(`UPDATE dbo.product_content SET [${safeCol(ch.field, CONTENT_COLS)}]=@v WHERE product_id=@p`);
            await logChange(tx, batch, 'content', 'product_content', ch.pid, ch.field, oldV, ch.new);
            applied++;
          } else { // a plain products field update (price/stock/name/visibility)
            const col = safeCol(ch.field, PRODUCT_COLS);
            await new sql.Request(tx).input('id', sql.Int, ch.id).input('v', sql.NVarChar(sql.MAX), ch.new == null ? null : String(ch.new))
              .query(`UPDATE dbo.products SET [${col}]=@v WHERE id=@id`);
            await logChange(tx, batch, 'update', 'products', ch.id, ch.field, ch.old, ch.new);
            applied++;
          }
        }
        // A one-line summary row for the batch (what shows in the Logs tab list).
        await new sql.Request(tx).input('b', sql.NVarChar(40), batch).input('t', sql.NVarChar(40), type)
          .input('s', sql.NVarChar(400), `${T.title}: ${applied} שינויים`).input('c', sql.Int, applied)
          .query('INSERT INTO dbo.import_batches (batch_id,type,summary,changes) VALUES (@b,@t,@s,@c)');
        await tx.commit();
        res.json({ applied: true, batch_id: batch, changes: applied, errors: errors.length });
      } catch (e) { try { await tx.rollback(); } catch (_) {} next(e); } // any failure → undo the whole batch
    } catch (e) { next(e); }

    // Writes one row to the audit_log for a single change (old → new). Runs inside the
    // same transaction as the change itself, so logs and data commit/rollback together.
    async function logChange(tx, batch, action, entity, entityId, field, oldV, newV) {
      await new sql.Request(tx)
        .input('b', sql.NVarChar(40), batch).input('a', sql.NVarChar(60), action)
        .input('e', sql.NVarChar(40), entity).input('eid', sql.Int, entityId)
        .input('f', sql.NVarChar(60), field)
        .input('o', sql.NVarChar(sql.MAX), oldV == null ? null : String(oldV))
        .input('n', sql.NVarChar(sql.MAX), newV == null ? null : String(newV))
        .query('INSERT INTO dbo.audit_log (batch_id,action,entity,entity_id,field,old_value,new_value) VALUES (@b,@a,@e,@eid,@f,@o,@n)');
    }
  });

  // Logs tab data: recent import batches + the recent individual change entries.
  app.get('/api/admin/logs', requireAdmin, async (req, res, next) => {
    try {
      const batches = await query(`SELECT TOP 50 batch_id,type,summary,changes,reverted,
        CONVERT(varchar(19),ts,120) AS ts FROM dbo.import_batches ORDER BY ts DESC`);
      const entries = await query(`SELECT TOP 150 id,batch_id,action,entity,entity_id,field,old_value,new_value,reverted,actor,
        CONVERT(varchar(19),ts,120) AS ts FROM dbo.audit_log ORDER BY id DESC`);
      res.json({ batches, entries });
    } catch (e) { next(e); }
  });

  // Undo an entire import batch: walk its log entries NEWEST first and reverse each —
  // delete inserted products, restore old values for edits — then mark it reverted.
  app.post('/api/admin/undo/:batch', requireAdmin, async (req, res, next) => {
    const batch = req.params.batch;
    try {
      const pool = await getPool(); const tx = new sql.Transaction(pool); await tx.begin();
      try {
        const rows = (await new sql.Request(tx).input('b', sql.NVarChar(40), batch)
          .query('SELECT * FROM dbo.audit_log WHERE batch_id=@b AND reverted=0 ORDER BY id DESC')).recordset;
        let n = 0;
        for (const r of rows) {
          if (r.entity === 'products:new') {
            await new sql.Request(tx).input('id', sql.Int, r.entity_id).query('DELETE FROM dbo.products WHERE id=@id');
          } else if (r.entity === 'product_content') {
            await new sql.Request(tx).input('id', sql.Int, r.entity_id).input('v', sql.NVarChar(sql.MAX), r.old_value)
              .query(`UPDATE dbo.product_content SET [${safeCol(r.field, CONTENT_COLS)}]=@v WHERE product_id=@id`);
          } else if (r.entity === 'products') {
            await new sql.Request(tx).input('id', sql.Int, r.entity_id).input('v', sql.NVarChar(sql.MAX), r.old_value)
              .query(`UPDATE dbo.products SET [${safeCol(r.field, PRODUCT_COLS)}]=@v WHERE id=@id`);
          }
          await new sql.Request(tx).input('id', sql.Int, r.id).query('UPDATE dbo.audit_log SET reverted=1 WHERE id=@id');
          n++;
        }
        await new sql.Request(tx).input('b', sql.NVarChar(40), batch).query('UPDATE dbo.import_batches SET reverted=1 WHERE batch_id=@b');
        await tx.commit();
        res.json({ reverted: true, batch, changes: n });
      } catch (e) { try { await tx.rollback(); } catch (_) {} next(e); }
    } catch (e) { next(e); }
  });

  // Backup: dump all products (+ their content) to a timestamped JSON file on disk.
  app.post('/api/admin/backup', requireAdmin, async (req, res, next) => {
    try {
      const products = await query('SELECT * FROM dbo.products');
      const content = await query('SELECT * FROM dbo.product_content');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(backupsDir, `backup_${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify({ created: new Date().toISOString(), products, content }), 'utf8');
      res.json({ ok: true, file: path.basename(file), products: products.length, sizeKB: Math.round(fs.statSync(file).size / 1024) });
    } catch (e) { next(e); }
  });
  // List the backup files we've made.
  app.get('/api/admin/backups', requireAdmin, (req, res) => {
    try {
      const list = fs.readdirSync(backupsDir).filter(f => f.endsWith('.json'))
        .map(f => ({ file: f, sizeKB: Math.round(fs.statSync(path.join(backupsDir, f)).size / 1024) }))
        .sort((a, b) => b.file.localeCompare(a.file));
      res.json(list);
    } catch (e) { res.json([]); }
  });

  // Guard: only let whitelisted column names reach SQL. Column names can't be passed
  // as parameters, so this is our defense against a malicious spreadsheet header.
  function safeCol(c, allow) { if (!allow[c]) throw new Error('bad column ' + c); return c; }
}

module.exports = { registerBulk };
