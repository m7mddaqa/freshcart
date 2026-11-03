// ============================================================================
// Data layer — SQLite edition.
//
// The original app was written against SQL Server (the `mssql` package). This demo
// runs on a Raspberry Pi, where SQL Server can't run, so the store is a single
// SQLite file instead (see config.dbPath).
//
// To avoid rewriting every route, this module re-implements the small slice of the
// `mssql` API the app actually uses — `query()`, `sql.Transaction`, `sql.Request`,
// `.input()` and the `sql.Int`/`sql.NVarChar`/... type tags — on top of
// better-sqlite3. The route code in index.js / auth.js / bulk.js is therefore
// unchanged; it still writes T-SQL and this layer translates it to SQLite dialect
// on the fly (see `translate()` below).
//
// Everything imports { sql, getPool, query } from here, exactly as before.
// ============================================================================
const Database = require('better-sqlite3');
const cfg = require('./config');

// One shared database handle for the whole process. better-sqlite3 is synchronous,
// so a single connection is both simplest and fastest here.
const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');   // better read/write concurrency for a web server
db.pragma('busy_timeout = 5000');  // wait a bit rather than failing if the file is briefly locked

// ---------------------------------------------------------------------------
// T-SQL  ->  SQLite translation.
//
// The app's queries are written in SQL Server dialect. These are the only
// constructs it actually uses, each mapped to its SQLite equivalent. The patterns
// are deliberately narrow — they match the exact shapes used in the code, not
// arbitrary SQL — so the rewrite stays predictable.
// ---------------------------------------------------------------------------
function translate(text) {
  let s = text;
  let returnsId = false;

  // `INSERT ... OUTPUT INSERTED.id VALUES ...` — SQL Server's way of getting the new
  // row's id back. In SQLite we drop the clause and read lastInsertRowid afterwards.
  if (/OUTPUT\s+INSERTED\.id/i.test(s)) { returnsId = true; s = s.replace(/\s+OUTPUT\s+INSERTED\.id/i, ''); }

  // `dbo.` schema prefix doesn't exist in SQLite — strip it. ([table] brackets are fine.)
  s = s.replace(/\bdbo\./gi, '');

  // Date/time helpers. Do the composite DATEADD forms first (the two the app uses),
  // then the bare "now" functions, so the nested calls come out clean.
  s = s.replace(/DATEADD\(\s*second\s*,\s*-?30\s*,\s*SYSUTCDATETIME\(\)\s*\)/gi, "datetime('now','-30 seconds')");
  s = s.replace(/DATEADD\(\s*minute\s*,\s*5\s*,\s*SYSUTCDATETIME\(\)\s*\)/gi, "datetime('now','+5 minutes')");
  s = s.replace(/SYSUTCDATETIME\(\)/gi, "datetime('now')");
  s = s.replace(/GETDATE\(\)/gi, "datetime('now')");

  // We store timestamps as ISO text ("YYYY-MM-DD HH:MM:SS"), which is exactly what
  // CONVERT(varchar(19), <col>, 120) produced — so the conversion is a no-op.
  s = s.replace(/CONVERT\(\s*varchar\(19\)\s*,\s*([A-Za-z0-9_.]+)\s*,\s*120\s*\)/gi, '$1');

  // ISNULL -> IFNULL (same two-argument meaning).
  s = s.replace(/\bISNULL\(/gi, 'IFNULL(');

  // Paging: OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY  ->  LIMIT @lim OFFSET @off
  s = s.replace(/OFFSET\s+(@\w+)\s+ROWS\s+FETCH\s+NEXT\s+(@\w+)\s+ROWS\s+ONLY/gi, 'LIMIT $2 OFFSET $1');

  // TOP N  ->  trailing LIMIT N. The app only uses TOP on single, simple statements,
  // so appending LIMIT at the end is safe.
  const top = s.match(/\bSELECT\s+TOP\s+(\d+)\s+/i);
  if (top) { s = s.replace(/\bSELECT\s+TOP\s+\d+\s+/i, 'SELECT '); s = s.trim() + ' LIMIT ' + top[1]; }

  // LIKE @param -> LIKE @param ESCAPE '\'  (paired with the escaping in index.js's
  // like() helper, so %, _ and \ in a search term are treated literally).
  s = s.replace(/\bLIKE\s+(@\w+)/gi, "LIKE $1 ESCAPE '\\'");

  return { sql: s, returnsId };
}

// Pull a value out of an mssql-style { type, value } wrapper, and coerce the few JS
// types better-sqlite3 won't bind directly (undefined, booleans).
function coerce(v) {
  if (v && typeof v === 'object' && 'value' in v && 'type' in v) v = v.value;
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

// Run one translated statement. Builds the bind object from only the @params the
// statement actually references (so, like mssql, extra inputs are simply ignored),
// then calls .all() for reads or .run() for writes.
function exec(rawSql, rawParams) {
  const { sql: text, returnsId } = translate(rawSql);
  const used = new Set();
  for (const m of text.matchAll(/@(\w+)/g)) used.add(m[1]);
  const bind = {};
  for (const name of used) if (rawParams && name in rawParams) bind[name] = coerce(rawParams[name]);
  const hasBind = Object.keys(bind).length > 0;

  const stmt = db.prepare(text);
  if (/^\s*(SELECT|WITH|PRAGMA)/i.test(text)) {
    return { rows: hasBind ? stmt.all(bind) : stmt.all() };
  }
  const info = hasBind ? stmt.run(bind) : stmt.run();
  // INSERT ... (OUTPUT INSERTED.id) — hand back the new id the way the app expects.
  return { rows: returnsId ? [{ id: Number(info.lastInsertRowid) }] : [], info };
}

// ---------------------------------------------------------------------------
// mssql-compatible surface the rest of the app imports.
// ---------------------------------------------------------------------------

// Type tags (sql.Int, sql.NVarChar(40), sql.Decimal(12,2), ...). SQLite is
// dynamically typed, so these carry no real meaning here — each is just a callable
// token that returns itself, so both `sql.Int` and `sql.NVarChar(40)` are valid.
function tag() { const f = function () { return f; }; return f; }
const sql = {
  Int: tag(), BigInt: tag(), SmallInt: tag(), TinyInt: tag(),
  NVarChar: tag(), VarChar: tag(), Text: tag(), NText: tag(), Char: tag(),
  Decimal: tag(), Numeric: tag(), Float: tag(), Real: tag(), Money: tag(),
  Bit: tag(), DateTime: tag(), DateTime2: tag(), Date: tag(), UniqueIdentifier: tag(),
  MAX: 'max'
};

// A single global lock serialises transactions. better-sqlite3 allows only one
// open transaction per connection, and Express can interleave handlers at every
// `await`, so we queue begin()..commit() to keep them from overlapping.
let lock = Promise.resolve();
function acquire() {
  let release;
  const next = new Promise(r => { release = r; });
  const prev = lock; lock = next;
  return prev.then(() => release);
}

// Request: mirrors `new sql.Request(txOrPool)` with chainable `.input()` and
// `.query()` returning { recordset }. input() accepts either (name, value) or
// (name, type, value) — the type is ignored, as above.
class Request {
  constructor() { this.params = {}; }
  input(name, a, b) { this.params[name] = (arguments.length >= 3) ? b : a; return this; }
  async query(text) { const r = exec(text, this.params); return { recordset: r.rows }; }
  async batch(text) { db.exec(translate(text).sql); return { recordset: [] }; }
}

// Transaction: mirrors `new sql.Transaction(pool)` with begin/commit/rollback,
// backed by SQLite's own BEGIN/COMMIT/ROLLBACK plus the lock above.
class Transaction {
  constructor() { this._release = null; }
  async begin() { this._release = await acquire(); db.exec('BEGIN'); }
  async commit() { db.exec('COMMIT'); if (this._release) { this._release(); this._release = null; } }
  async rollback() { try { db.exec('ROLLBACK'); } finally { if (this._release) { this._release(); this._release = null; } } }
}
sql.Request = Request;
sql.Transaction = Transaction;

// The pool is just a handle that can hand out Requests; kept so `pool.request()` and
// `new sql.Transaction(pool)` keep working. getPool() stays async so the boot code
// (`getPool().then(...)`) is unchanged.
const pool = { request: () => new Request() };
async function getPool() { return pool; }

// Top-level query(): run a parameterised statement and return just the rows.
// `params` is { name: value } or { name: { type, value } }, same as before.
async function query(text, params = {}) {
  return exec(text, params).rows;
}

module.exports = { sql, getPool, query, _db: db };
