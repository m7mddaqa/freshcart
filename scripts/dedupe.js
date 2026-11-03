// Collapse duplicate products: the source catalog lists some items multiple times under
// the same barcode. Keep one row per barcode visible (the lowest id) and hide the rest
// (is_visible=0 — non-destructive, the data stays). Safe to re-run.
// Run:  node scripts/dedupe.js
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freshcart.db'));
db.pragma('busy_timeout = 15000');

const before = db.prepare("SELECT COUNT(*) c FROM products WHERE is_visible=1").get().c;
const info = db.prepare(`
  UPDATE products SET is_visible = 0
  WHERE is_visible = 1 AND barcode IS NOT NULL AND barcode <> ''
    AND id NOT IN (
      SELECT MIN(id) FROM products
      WHERE is_visible = 1 AND barcode IS NOT NULL AND barcode <> ''
      GROUP BY barcode
    )`).run();
const after = db.prepare("SELECT COUNT(*) c FROM products WHERE is_visible=1").get().c;
console.log('hidden duplicate rows:', info.changes, '| visible', before, '->', after);
db.close();
