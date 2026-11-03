// Add the indexes the app's queries need. The SQLite export copies table data but not
// SQL Server's indexes, so category/product queries full-scan and block the (synchronous)
// better-sqlite3 event loop. This restores them. Safe to re-run (IF NOT EXISTS).
// Run:  node scripts/add-indexes.js
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freshcart.db'));
db.pragma('busy_timeout = 15000');

const IDX = [
  // the big one: category filtering + joins on product_categories
  'CREATE INDEX IF NOT EXISTS ix_pc_pid       ON product_categories(product_id)',
  'CREATE INDEX IF NOT EXISTS ix_pc_cat       ON product_categories(category_id, level)',
  'CREATE INDEX IF NOT EXISTS ix_pc_pid_path  ON product_categories(product_id, path_index, level)',
  // products: the storefront listing filter/sort + lookups/joins
  'CREATE INDEX IF NOT EXISTS ix_prod_vis     ON products(is_visible, regular_price)',
  'CREATE INDEX IF NOT EXISTS ix_prod_id      ON products(id)',
  'CREATE INDEX IF NOT EXISTS ix_prod_barcode ON products(barcode)',
  'CREATE INDEX IF NOT EXISTS ix_prod_brand   ON products(brand_id)',
  'CREATE INDEX IF NOT EXISTS ix_prod_aisle   ON products(aisle_id)',
  'CREATE INDEX IF NOT EXISTS ix_prod_dept    ON products(department_id)',
  // detail-page companions
  'CREATE INDEX IF NOT EXISTS ix_pcont_pid    ON product_content(product_id)',
  'CREATE INDEX IF NOT EXISTS ix_pimg_pid     ON product_images(product_id)',
  // lookup tables joined by id/code
  'CREATE INDEX IF NOT EXISTS ix_cat_id       ON categories(id)',
  'CREATE INDEX IF NOT EXISTS ix_brand_id     ON brands(brand_id)',
  'CREATE INDEX IF NOT EXISTS ix_aisle_id     ON aisles(aisle_id)',
  'CREATE INDEX IF NOT EXISTS ix_dept_id      ON departments(department_id)',
  'CREATE INDEX IF NOT EXISTS ix_origin_code  ON origin_countries(code)',
  // cross-store comparison
  'CREATE INDEX IF NOT EXISTS ix_ci_barcode   ON catalog_items(barcode)',
  'CREATE INDEX IF NOT EXISTS ix_ci_store     ON catalog_items(store)',
  // app tables
  'CREATE INDEX IF NOT EXISTS ix_orders_id    ON orders(id)',
  'CREATE INDEX IF NOT EXISTS ix_oitems_oid   ON order_items(order_id)',
  'CREATE INDEX IF NOT EXISTS ix_cust_phone   ON customers(phone)',
  'CREATE INDEX IF NOT EXISTS ix_tok          ON customer_tokens(token)',
  'CREATE INDEX IF NOT EXISTS ix_otp_phone    ON otp_codes(phone)'
];

for (const s of IDX) {
  try { db.exec(s); console.log('ok  ', s.split(' ON ')[1]); }
  catch (e) { console.log('skip ', e.message); }
}
db.exec('ANALYZE'); // let the query planner use the new indexes well
console.log('done; total indexes =', db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index'").get().c);
db.close();
