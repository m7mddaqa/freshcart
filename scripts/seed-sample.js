// Build a small, fully synthetic sample database so anyone can clone the repo and run the
// app with `npm run seed && npm start` — no private data needed. Creates the schema the app
// expects (with proper primary keys), seeds a handful of categories/products, two demo
// comparison stores, and the indexes the queries need. Safe to re-run (drops + recreates).
//
// Run:  npm run seed            (writes data/freshcart.db)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freshcart.db');
fs.mkdirSync(path.dirname(DB), { recursive: true });
if (fs.existsSync(DB)) fs.unlinkSync(DB);
const db = new Database(DB);
db.pragma('journal_mode = WAL');

// ---- schema (ids are real INTEGER PRIMARY KEYs so inserts/lookups behave) ----
db.exec(`
CREATE TABLE departments      (department_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE aisles           (aisle_id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE brands           (brand_id INTEGER PRIMARY KEY, name_he TEXT, name_en TEXT);
CREATE TABLE origin_countries (code TEXT PRIMARY KEY, name TEXT);
CREATE TABLE categories       (id INTEGER PRIMARY KEY, name_he TEXT, name_en TEXT);
CREATE TABLE products (
  id INTEGER PRIMARY KEY, product_id INTEGER, barcode TEXT, name_he TEXT, name_en TEXT,
  local_name TEXT, regular_price REAL, image_file TEXT, stock_qty INTEGER, is_weighable INTEGER,
  uom_he TEXT, weight REAL, brand_id INTEGER, aisle_id INTEGER, department_id INTEGER,
  origin_code TEXT, is_visible INTEGER, main_category_path_index INTEGER, tax_amount REAL,
  is_active INTEGER, branch_id INTEGER);
CREATE TABLE product_categories (product_id INTEGER, category_id INTEGER, level INTEGER, path_index INTEGER);
CREATE TABLE product_content (product_id INTEGER PRIMARY KEY, description_he TEXT, ingredients_he TEXT,
  warnings_he TEXT, storage_he TEXT, usage_he TEXT, nutrition_he TEXT);
CREATE TABLE product_images (product_id INTEGER, url TEXT, position INTEGER);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_name TEXT, customer_phone TEXT, customer_address TEXT,
  note TEXT, customer_id INTEGER, item_count INTEGER, total REAL, status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now')), original_json TEXT);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product_id INTEGER, barcode TEXT,
  name TEXT, unit_price REAL, qty INTEGER, line_total REAL);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, first_name TEXT, last_name TEXT,
  phone TEXT, email TEXT, address TEXT);
CREATE TABLE customer_tokens (token TEXT PRIMARY KEY, customer_id INTEGER);
CREATE TABLE otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, code TEXT, used INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT, action TEXT, entity TEXT, entity_id INTEGER,
  field TEXT, old_value TEXT, new_value TEXT, reverted INTEGER DEFAULT 0, actor TEXT,
  ts TEXT DEFAULT (datetime('now')));
CREATE TABLE import_batches (batch_id TEXT PRIMARY KEY, type TEXT, summary TEXT, changes INTEGER,
  reverted INTEGER DEFAULT 0, ts TEXT DEFAULT (datetime('now')));
CREATE TABLE catalog_stores (store TEXT PRIMARY KEY, label TEXT, accent TEXT, sort INTEGER);
CREATE TABLE catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT, barcode TEXT, name TEXT, brand TEXT,
  price REAL, image_file TEXT, image_url TEXT, category TEXT, uom TEXT, is_weighable INTEGER);
`);

// ---- reference rows ----
db.prepare("INSERT INTO departments VALUES (1,'מזון'),(2,'משקאות'),(3,'בית')").run();
db.prepare("INSERT INTO aisles VALUES (1,'כללי')").run();
db.prepare("INSERT INTO brands VALUES (1,'מותג א',''),(2,'מותג ב',''),(3,'מותג ג','')").run();
db.prepare("INSERT INTO origin_countries VALUES ('IL','ישראל'),('IT','איטליה')").run();

// top-level categories (id, he, en) + a couple of beverage sub-categories
const cats = [
  [10, 'חלב וביצים', 'Dairy & Eggs'], [20, 'משקאות', 'Beverages'], [30, 'מאפים', 'Bakery'],
  [40, 'חטיפים', 'Snacks'], [50, 'ניקיון', 'Cleaning'], [60, 'ירקות ופירות', 'Produce'],
  [21, 'מים', 'Water'], [22, 'מיצים', 'Juice'] // sub-cats of 20
];
const insCat = db.prepare("INSERT INTO categories (id,name_he,name_en) VALUES (?,?,?)");
cats.forEach(c => insCat.run(c));

// sample products: [topCat, name_he, price, uom, weight, subCat?]
const items = [
  [10, 'חלב 3% בקרטון', 6.9, 'ליטר', 1000], [10, 'ביצים L תריסר', 13.5, 'יחידה', 0],
  [10, 'גבינה צהובה פרוסה', 18.9, 'גרם', 400], [10, 'יוגורט טבעי', 5.2, 'גרם', 300],
  [20, 'מים מינרלים 1.5 ליטר', 4.5, 'ליטר', 1500, 21], [20, 'מים מוגזים', 5.0, 'ליטר', 1500, 21],
  [20, 'מיץ תפוזים טבעי', 11.9, 'ליטר', 1000, 22], [20, 'מיץ תפוחים', 10.5, 'ליטר', 1000, 22],
  [30, 'לחם פרוס מלא', 7.9, 'גרם', 500], [30, 'לחמניות', 9.9, 'יחידה', 0],
  [30, 'חלה', 12.0, 'יחידה', 0], [30, 'בייגלה', 6.5, 'גרם', 200],
  [40, 'חטיף תירס', 5.9, 'גרם', 50], [40, 'שוקולד חלב', 7.5, 'גרם', 100],
  [40, 'עוגיות', 8.9, 'גרם', 300], [40, 'צ׳יפס', 6.9, 'גרם', 150],
  [50, 'נוזל כלים', 12.9, 'מ"ל', 750], [50, 'מרכך כביסה', 19.9, 'ליטר', 2000],
  [50, 'מגבונים לחים', 8.9, 'יחידה', 0], [50, 'שקיות אשפה', 14.5, 'יחידה', 0],
  [60, 'עגבניות', 7.9, 'ק"ג', 0, null, 1], [60, 'מלפפונים', 6.9, 'ק"ג', 0, null, 1],
  [60, 'בננות', 8.9, 'ק"ג', 0, null, 1], [60, 'תפוחים', 9.9, 'ק"ג', 0, null, 1]
];
const insP = db.prepare(`INSERT INTO products
  (id,product_id,barcode,name_he,name_en,local_name,regular_price,image_file,stock_qty,is_weighable,
   uom_he,weight,brand_id,aisle_id,department_id,origin_code,is_visible,main_category_path_index,tax_amount,is_active,branch_id)
  VALUES (@id,@pid,@bc,@nh,@ne,@ln,@price,@img,@stock,@weigh,@uom,@weight,@brand,1,@dept,'IL',1,0,0.17,1,1)`);
const insPC = db.prepare("INSERT INTO product_categories (product_id,category_id,level,path_index) VALUES (?,?,?,?)");
const insContent = db.prepare("INSERT INTO product_content (product_id,description_he,ingredients_he) VALUES (?,?,?)");

let id = 1001;
const barcodes = [];
items.forEach((it, i) => {
  const [cat, nh, price, uom, weight, sub, weigh] = it;
  const bc = '729' + String(1000000000 + id).slice(-10);
  insP.run({ id, pid: id, bc, nh, ne: null, ln: null, price, img: null,
    stock: 20 + (i * 7) % 60, weigh: weigh ? 1 : 0, uom, weight: weight || null,
    brand: (i % 3) + 1, dept: cat === 20 ? 2 : (cat === 50 ? 3 : 1) });
  insPC.run(id, cat, 0, 0);               // top-level category
  if (sub) insPC.run(id, sub, 1, 0);      // sub-category (same path) for the children view
  if (i % 4 === 0) insContent.run(id, 'מוצר לדוגמה בקטלוג ההדגמה.', 'רכיבים לדוגמה.');
  barcodes.push({ bc, nh, price });
  id++;
});

// ---- demo cross-store comparison (two generic sample stores) ----
db.prepare("INSERT INTO catalog_stores VALUES ('market_a','Market A','#2e9e5b',1),('market_b','Market B','#2a7de1',2)").run();
const insCI = db.prepare("INSERT INTO catalog_items (store,barcode,name,brand,price,image_file,image_url,category,uom,is_weighable) VALUES (?,?,?,?,?,?,?,?,?,0)");
// put the first 12 products in both stores, with a small price difference so the compare shows something
barcodes.slice(0, 12).forEach((p, i) => {
  insCI.run('market_a', p.bc, p.nh, 'מותג א', p.price, null, null, null, null);
  insCI.run('market_b', p.bc, p.nh, 'מותג א', Math.round((p.price + (i % 2 ? -0.6 : 0.8)) * 100) / 100, null, null, null, null);
});

// ---- indexes (same set the real build uses) ----
for (const s of [
  'CREATE INDEX ix_pc_pid ON product_categories(product_id)',
  'CREATE INDEX ix_pc_cat ON product_categories(category_id, level)',
  'CREATE INDEX ix_pc_pid_path ON product_categories(product_id, path_index, level)',
  'CREATE INDEX ix_prod_vis ON products(is_visible, regular_price)',
  'CREATE INDEX ix_prod_barcode ON products(barcode)',
  'CREATE INDEX ix_ci_barcode ON catalog_items(barcode)',
  'CREATE INDEX ix_ci_store ON catalog_items(store)'
]) db.exec(s);
db.exec('ANALYZE');

const n = db.prepare('SELECT COUNT(*) c FROM products').get().c;
console.log(`seeded sample DB -> ${DB}  (${n} products, ${cats.length} categories, 2 compare stores)`);
db.close();
