// Comparison tool store naming: show Ubi + Dabach under their real names, and remove the
// user's own store (was 'greenfield'/rosmarin) from the comparison entirely. Idempotent.
// Run:  node scripts/set-compare-stores.js
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freshcart.db'));
db.pragma('busy_timeout = 15000');

const run = db.transaction(() => {
  // drop the own-store rows (greenfield = the renamed Rosmarin; also guard the raw name)
  db.prepare("DELETE FROM catalog_items  WHERE store IN ('greenfield','rosmarin')").run();
  db.prepare("DELETE FROM catalog_stores WHERE store IN ('greenfield','rosmarin')").run();
  // revert the two compared stores to their real codes + labels
  db.prepare("UPDATE catalog_items  SET store='ubi'    WHERE store='valuemart'").run();
  db.prepare("UPDATE catalog_items  SET store='dabach' WHERE store='supersaver'").run();
  db.prepare("UPDATE catalog_stores SET store='ubi',    label='Ubi'    WHERE store='valuemart'").run();
  db.prepare("UPDATE catalog_stores SET store='dabach', label='Dabach' WHERE store='supersaver'").run();
});
run();

console.log('comparison stores now:');
db.prepare("SELECT s.store, s.label, (SELECT COUNT(*) FROM catalog_items ci WHERE ci.store=s.store) n FROM catalog_stores s ORDER BY s.sort")
  .all().forEach(r => console.log(`  ${r.store}  "${r.label}"  items=${r.n}`));
db.close();
