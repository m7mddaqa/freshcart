// Rebuild the transactional/app tables with the CORRECT schema: a proper `id INTEGER PRIMARY KEY`
// AND the column defaults the app relies on (otp used/attempts, order status/created_at, audit
// reverted/ts). The mssql->sqlite export dropped both, which broke new orders, phone-login and undo.
//
// These tables hold only transactional data (and the source copy contained the original store's
// real customer/order records — not something a public demo should carry), so they are recreated
// EMPTY. The product catalog is untouched. Safe to re-run.
//
// Run:  node scripts/fix-ids.js     (stop the server first)
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freshcart.db'));
db.pragma('busy_timeout = 15000');

const SCHEMA = {
  orders: `CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_name TEXT, customer_phone TEXT,
    customer_address TEXT, note TEXT, customer_id INTEGER, item_count INTEGER, total REAL,
    status TEXT DEFAULT 'new', created_at TEXT DEFAULT (datetime('now')), original_json TEXT)`,
  order_items: `CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
    barcode TEXT, name TEXT, unit_price REAL, qty INTEGER, line_total REAL)`,
  customers: `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, first_name TEXT,
    last_name TEXT, phone TEXT, email TEXT, address TEXT)`,
  customer_tokens: `CREATE TABLE customer_tokens (token TEXT PRIMARY KEY, customer_id INTEGER)`,
  otp_codes: `CREATE TABLE otp_codes (id INTEGER PRIMARY KEY, phone TEXT, code TEXT,
    used INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT)`,
  audit_log: `CREATE TABLE audit_log (id INTEGER PRIMARY KEY, batch_id TEXT, action TEXT, entity TEXT,
    entity_id INTEGER, field TEXT, old_value TEXT, new_value TEXT, reverted INTEGER DEFAULT 0,
    actor TEXT, ts TEXT DEFAULT (datetime('now')))`,
  import_batches: `CREATE TABLE import_batches (batch_id TEXT PRIMARY KEY, type TEXT, summary TEXT,
    changes INTEGER, reverted INTEGER DEFAULT 0, ts TEXT DEFAULT (datetime('now')))`
};

db.transaction(() => {
  for (const [t, ddl] of Object.entries(SCHEMA)) {
    db.exec(`DROP TABLE IF EXISTS [${t}]`);
    db.exec(ddl);
  }
})();
db.exec("CREATE INDEX IF NOT EXISTS ix_oitems_oid ON order_items(order_id)");
db.exec("CREATE INDEX IF NOT EXISTS ix_cust_phone ON customers(phone)");
db.exec("CREATE INDEX IF NOT EXISTS ix_otp_phone ON otp_codes(phone)");
db.exec('ANALYZE');
console.log('rebuilt (empty, correct schema):', Object.keys(SCHEMA).join(', '));
db.close();
