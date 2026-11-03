// ============================================================================
// FreshCart management console — the staff-facing admin app (vanilla JS).
//
// One big `Admin` object holds all the screens: dashboard, products, orders,
// Excel import, the cross-store price comparison, and the change logs. Tabs switch
// which panel is visible. Every call to the server goes through Admin.af(), which
// attaches the admin token and bounces back to the login screen on a 401.
// ============================================================================
const money = n => '₪' + Number(n || 0).toFixed(2);
const imgUrl = f => f ? '/images/' + encodeURIComponent(f) : null;

/* WebView Hebrew-input hardening: predictive text / autofill can break IME typing (esp. Samsung Keyboard) */
// Same keyboard fix as the storefront — turn off autocomplete/correct on every field so
// Hebrew & Arabic type correctly inside the Android WebView wrapper.
function hardenInputs(){ try{ document.querySelectorAll('input:not([data-hk]),textarea:not([data-hk])').forEach(function(i){
  i.setAttribute('autocomplete','off'); i.setAttribute('autocorrect','off'); i.setAttribute('autocapitalize','off'); i.setAttribute('spellcheck','false'); i.dataset.hk='1'; }); }catch(e){} }
(function(){ var t; try{ new MutationObserver(function(){ clearTimeout(t); t=setTimeout(hardenInputs,150); }).observe(document.documentElement,{childList:true,subtree:true}); }catch(e){} hardenInputs(); })();

const Admin = {
  p: { page: 1, pages: 1, q: '' }, // products-tab paging/search state

  // Switch tabs: toggle the active button + panel, then load that panel's data.
  tab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === name));
    if (name === 'dash') this.loadStats();
    if (name === 'products') this.loadProducts(1);
    if (name === 'orders') this.loadOrders();
    if (name === 'import') this.renderImport();
    if (name === 'compare') this.renderCompare();
    if (name === 'logs') this.renderLogs();
  },

  // ---------- CROSS-STORE COMPARISON ----------
  // Compares one product's price across our stores (Greenfield / ValueMart / SuperSaver). The user's
  // column choices + order are remembered in localStorage (see _loadCmpPrefs).
  async renderCompare() {
    const host = document.getElementById('cmpStores');
    try {
      Admin._cmpStores = await Admin.af('/api/admin/compare/stores').then(r => r.json());
      Admin._loadCmpPrefs();
      Admin._renderChips();
    } catch (e) { host.innerHTML = ''; }
  },
  // The store chips: tap to show/hide that store's column; "רשימה" opens its full list.
  _renderChips() {
    const host = document.getElementById('cmpStores'); if (!host) return;
    host.innerHTML = (Admin._cmpStores || []).map(s => {
      const sel = Admin._selStores.includes(s.store);
      return `<span class="cmp-chip ${sel ? 'sel' : 'off'}" style="--c:${s.accent || '#888'}" onclick="Admin.toggleStore('${s.store}')" title="הצג/הסתר עמודה">
        <i></i><b>${s.label}</b> · ${Number(s.items).toLocaleString()}
        <a class="cmp-browse" onclick="event.stopPropagation();Admin.browseStore('${s.store}')">רשימה ›</a></span>`;
    }).join('') + `<span class="cmp-hint">לחיצה על חנות = הצגה/הסתרה · חצים ‹ › בכותרת העמודה = הזזה</span>`;
  },
  // Show/hide a store column, persist the choice, and re-render results if any are showing.
  toggleStore(store) {
    const i = Admin._selStores.indexOf(store);
    if (i >= 0) Admin._selStores.splice(i, 1); else Admin._selStores.push(store);
    Admin._saveCmpPrefs(); Admin._renderChips();
    if (Admin._cmpData) Admin.renderResults();
  },
  // All possible columns keyed by id: fixed ones (product/barcode/diff) + one per store ("s:<store>").
  _allCols() {
    const cols = { product: { label: 'מוצר' }, barcode: { label: 'ברקוד' }, diff: { label: 'הפרש' } };
    (Admin._cmpStores || []).forEach(s => cols['s:' + s.store] = { label: s.label, store: s.store, accent: s.accent });
    return cols;
  },
  // Load the saved column selection + order from localStorage, falling back to sensible
  // defaults and dropping anything stale (a store that no longer exists, etc.).
  _loadCmpPrefs() {
    const ids = (Admin._cmpStores || []).map(s => s.store);
    try { Admin._selStores = JSON.parse(localStorage.getItem('cmp_sel') || 'null'); } catch (e) {}
    if (!Array.isArray(Admin._selStores)) Admin._selStores = ids.slice();
    Admin._selStores = Admin._selStores.filter(s => ids.includes(s));
    if (!Admin._selStores.length) Admin._selStores = ids.slice();
    const allKeys = Object.keys(Admin._allCols());
    const def = ['product', 'barcode', ...ids.map(s => 's:' + s), 'diff'];
    try { Admin._colOrder = JSON.parse(localStorage.getItem('cmp_order') || 'null'); } catch (e) {}
    if (!Array.isArray(Admin._colOrder)) Admin._colOrder = def;
    Admin._colOrder = Admin._colOrder.filter(k => allKeys.includes(k)); // drop unknown cols
    def.forEach(k => { if (!Admin._colOrder.includes(k)) Admin._colOrder.push(k); }); // add any new ones
  },
  _saveCmpPrefs() {
    try { localStorage.setItem('cmp_sel', JSON.stringify(Admin._selStores)); localStorage.setItem('cmp_order', JSON.stringify(Admin._colOrder)); } catch (e) {}
  },
  // browse all products of one store (paginated)
  browseStore(store) { Admin._browse = { store, page: 1, q: '' }; Admin._loadBrowse(); },
  browseSearch() { Admin._browse.q = document.getElementById('browseQ').value.trim(); Admin._browse.page = 1; Admin._loadBrowse(); },
  browsePage(d) { Admin._browse.page += d; Admin._loadBrowse(); window.scrollTo(0, 0); },
  // Render one page of a single store's catalog into the results area.
  async _loadBrowse() {
    const b = Admin._browse, box = document.getElementById('cmpResults');
    box.innerHTML = '<p class="muted">טוען…</p>';
    const label = ((Admin._cmpStores || []).find(s => s.store === b.store) || {}).label || b.store;
    const d = await Admin.af(`/api/admin/store-products?store=${encodeURIComponent(b.store)}&q=${encodeURIComponent(b.q)}&page=${b.page}`).then(r => r.json());
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const rows = (d.items || []).map(it => {
      const src = it.image_file ? imgUrl(it.image_file) : (it.image_url || ''); // local file first, else remote URL
      return `<tr onclick="Admin.openCatalog('${(it.barcode || '').replace(/'/g, '')}')">
        <td><span class="cmp-prod">${src ? `<img src="${src}" onerror="this.style.display='none'">` : ''}<span class="nmcell">${it.name || '—'}</span></span></td>
        <td>${it.barcode || ''}</td><td>${it.brand || ''}</td><td>${it.category || ''}</td><td>${it.price != null ? money(it.price) : '—'}</td><td class="cmp-go">פרטים ›</td></tr>`;
    }).join('');
    box.innerHTML = `
      <div class="ptools" style="margin-top:4px;flex-wrap:wrap">
        <b style="font-size:16px">${label}</b><span class="muted">${Number(d.total).toLocaleString()} מוצרים</span>
        <input id="browseQ" placeholder="סינון בחנות זו…" value="${b.q}" style="max-width:260px">
        <button onclick="Admin.browseSearch()">סנן</button>
        <button class="undo" onclick="document.getElementById('cmpResults').innerHTML=''">✕ סגור</button>
      </div>
      <div class="tablewrap"><table class="cmp-table"><thead><tr><th>מוצר</th><th>ברקוד</th><th>מותג</th><th>קטגוריה</th><th>מחיר</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted" style="padding:14px">אין תוצאות</td></tr>'}</tbody></table></div>
      <div class="pager"><button ${b.page <= 1 ? 'disabled' : ''} onclick="Admin.browsePage(-1)">הקודם</button><span>עמוד ${b.page} / ${pages}</span><button ${b.page >= pages ? 'disabled' : ''} onclick="Admin.browsePage(1)">הבא</button></div>`;
    const qi = document.getElementById('browseQ'); if (qi) qi.onkeydown = e => { if (e.key === 'Enter') Admin.browseSearch(); };
  },
  // Run a comparison search (name or barcode) and render the grid.
  async runCompare() {
    const q = document.getElementById('cmpSearch').value.trim();
    const box = document.getElementById('cmpResults'), cnt = document.getElementById('cmpCount');
    if (q.length < 2) { box.innerHTML = '<p class="muted">הקלד לפחות 2 תווים.</p>'; cnt.textContent = ''; Admin._cmpData = null; return; }
    box.innerHTML = '<p class="muted">מחפש…</p>';
    Admin._cmpData = await Admin.af('/api/admin/compare?q=' + encodeURIComponent(q)).then(r => r.json());
    cnt.textContent = (Admin._cmpData.items || []).length + ' תוצאות';
    Admin.renderResults();
  },
  // Build the comparison table from the last search, honoring column visibility + order.
  // Cheapest price per row gets .cmp-min, dearest .cmp-max, and "diff" shows the spread.
  renderResults() {
    const d = Admin._cmpData, box = document.getElementById('cmpResults'); if (!d) return;
    if (!(d.items || []).length) { box.innerHTML = '<p class="muted">לא נמצאו מוצרים.</p>'; return; }
    const cols = Admin._allCols();
    // visible columns, in the saved order, skipping store columns the user hid
    const order = Admin._colOrder.filter(k => cols[k] && (!k.startsWith('s:') || Admin._selStores.includes(k.slice(2))));
    const visStores = order.filter(k => k.startsWith('s:')).map(k => k.slice(2));
    // header row — each cell carries ‹ › buttons to move the column (RTL, so ‹ = left/later)
    const head = order.map((k, i) => `<th data-col="${k}" ${cols[k].accent ? `style="color:${cols[k].accent}"` : ''}><span class="colhead"><span class="collbl">${cols[k].label}</span><span class="colmove" dir="ltr"><button class="cmv" ${i < order.length - 1 ? '' : 'disabled'} onclick="Admin.moveCol(event,'${k}',1)" title="הזז שמאלה">‹</button><button class="cmv" ${i > 0 ? '' : 'disabled'} onclick="Admin.moveCol(event,'${k}',-1)" title="הזז ימינה">›</button></span></span></th>`).join('') + '<th class="nodrag"></th>';
    const rows = d.items.map(it => {
      // work out the min/max price across the visible stores for this product
      const nums = visStores.map(s => it.prices[s]).filter(v => v != null).map(Number);
      const min = nums.length ? Math.min(...nums) : null, max = nums.length ? Math.max(...nums) : null;
      const cells = order.map(k => {
        if (k === 'product') { const src = it.image_file ? imgUrl(it.image_file) : (it.image_url || ''); return `<td><span class="cmp-prod">${src ? `<img src="${src}" onerror="this.style.display='none'">` : ''}<span class="nmcell">${it.name || '—'}</span></span></td>`; }
        if (k === 'barcode') return `<td>${it.barcode || ''}</td>`;
        if (k === 'diff') { const diff = (min != null && max > min) ? ('₪' + (max - min).toFixed(2)) : '—'; return `<td class="cmp-diff">${diff}</td>`; }
        const s = k.slice(2), v = it.prices[s]; // a store price column
        if (v == null) return `<td class="cmp-na">—</td>`;
        const cls = nums.length > 1 && Number(v) === min ? 'cmp-min' : (nums.length > 1 && Number(v) === max ? 'cmp-max' : '');
        return `<td class="${cls}">${money(v)}</td>`;
      }).join('');
      return `<tr onclick="Admin.openCatalog('${(it.barcode || '').replace(/'/g, '')}')">${cells}<td class="cmp-go">פרטים ›</td></tr>`;
    }).join('');
    box.innerHTML = `<div class="tablewrap"><table class="cmp-table"><thead><tr id="cmpHead">${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  },
  // move a column one step: dir=-1 → right (earlier in RTL), dir=+1 → left (later)
  // We reorder only the visible columns, then stitch the hidden ones back on the end.
  moveCol(e, key, dir) {
    if (e) e.stopPropagation();
    const cols = Admin._allCols();
    const vis = Admin._colOrder.filter(k => cols[k] && (!k.startsWith('s:') || Admin._selStores.includes(k.slice(2))));
    const i = vis.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= vis.length) return; // can't move past the edge
    const t = vis[i]; vis[i] = vis[j]; vis[j] = t;
    Admin._colOrder = [...vis, ...Admin._colOrder.filter(k => !vis.includes(k))];
    Admin._saveCmpPrefs(); Admin.renderResults();
  },
  // The per-barcode detail modal: a column per store, a row per field, only showing
  // fields at least one store has data for (keeps the table from being mostly dashes).
  async openCatalog(barcode) {
    const d = await Admin.af('/api/admin/catalog/' + encodeURIComponent(barcode)).then(r => r.json());
    const stores = d.stores || [], byStore = {};
    (d.rows || []).forEach(r => byStore[r.store] = r);
    const field = (label, key) => {
      if (!stores.some(s => byStore[s.store] && byStore[s.store][key])) return ''; // skip empty-everywhere rows
      const cells = stores.map(s => { const r = byStore[s.store], v = r ? r[key] : null;
        return `<td>${v == null || v === '' ? '<span class="cmp-na">—</span>' : String(v).replace(/</g, '&lt;')}</td>`; }).join('');
      return `<tr><th class="cmp-lbl">${label}</th>${cells}</tr>`;
    };
    const imgRow = `<tr><th class="cmp-lbl"></th>${stores.map(s => { const r = byStore[s.store];
      const src = r && (r.image_file ? imgUrl(r.image_file) : r.image_url);
      return `<td>${src ? `<img class="cmp-dimg" src="${src}" onerror="this.style.display='none'">` : `<span class="cmp-na">${r ? '—' : 'לא קיים בחנות'}</span>`}</td>`; }).join('')}</tr>`;
    const priceRow = `<tr><th class="cmp-lbl">מחיר</th>${stores.map(s => { const r = byStore[s.store];
      return `<td class="cmp-price">${r && r.price != null ? money(r.price) : '<span class="cmp-na">—</span>'}</td>`; }).join('')}</tr>`;
    document.getElementById('omcard').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">פרטי מוצר · ${d.barcode}</h2>
        <button onclick="document.getElementById('omodal').classList.remove('show')" style="border:none;background:none;font-size:22px">✕</button>
      </div>
      <div class="tablewrap" style="margin-top:12px"><table class="cmp-detail">
        <thead><tr><th></th>${stores.map(s => `<th style="color:${s.accent}">${s.label}</th>`).join('')}</tr></thead>
        <tbody>${imgRow}${priceRow}${field('שם', 'name')}${field('מותג', 'brand')}${field('קטגוריה', 'category')}${field('יחידה', 'uom')}${field('ארץ ייצור', 'origin')}${field('תיאור', 'description')}${field('רכיבים', 'ingredients')}${field('אזהרות', 'warnings')}${field('אחסון', 'storage')}</tbody>
      </table></div>`;
    document.getElementById('omodal').classList.add('show');
  },

  // ---------- EXCEL IMPORT ----------
  // Shows the integration status chips, then a card per import type (download template /
  // upload file). Uploading triggers a server-side preview before anything is applied.
  async renderImport() {
    const integ = document.getElementById('integrations');
    try {
      const s = await Admin.af('/api/admin/integrations').then(r => r.json());
      const dot = on => `<span class="dot ${on ? 'on' : ''}"></span>`; // green/grey status dot
      integ.innerHTML =
        `<span class="chip2">${dot(s.priority.configured)} Priority ERP ${s.priority.configured ? '' : '(לא מוגדר)'}</span>
         <span class="chip2">${dot(s.payment.configured && s.payment.provider !== 'none')} תשלום: ${s.payment.provider}</span>`;
    } catch (e) { integ.innerHTML = ''; }

    const types = await Admin.af('/api/admin/import-types').then(r => r.json());
    const host = document.getElementById('importCards'); host.innerHTML = '';
    types.forEach(t => {
      const cols = t.columns.map(c => c.h).join(', ');
      const card = document.createElement('div'); card.className = 'imp-card';
      card.innerHTML = `<h4>${t.title}</h4><p>עמודות: ${cols}</p>
        <div class="acts">
          <button class="dl">⬇ הורד תבנית</button>
          <label class="up">⬆ העלה קובץ<input type="file" accept=".xlsx,.xls"></label>
        </div>`;
      card.querySelector('.dl').onclick = () => Admin.downloadTemplate(t.id);
      card.querySelector('input').onchange = e => Admin.onFile(t.id, e.target);
      host.appendChild(card);
    });
    document.getElementById('importPreview').innerHTML = '';
  },

  // Fetch the .xlsx template and trigger a browser download of it.
  async downloadTemplate(type) {
    const r = await Admin.af('/api/admin/template/' + type);
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'freshcart_' + type + '_template.xlsx'; document.body.appendChild(a); a.click(); a.remove();
  },

  // Read the chosen file as base64 and ask the server for a dry-run preview (apply:false).
  onFile(type, input) {
    const f = input.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      const b64 = String(rd.result).split(',')[1]; // strip the "data:...;base64," prefix
      Admin._imp = { type, b64 }; // stash so "apply" can re-send the same file
      document.getElementById('importPreview').innerHTML = '<p class="muted">מעבד קובץ…</p>';
      const r = await Admin.af('/api/admin/import/' + type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileB64: b64, apply: false }) }).then(x => x.json());
      Admin.showPreview(type, r);
    };
    rd.readAsDataURL(f);
    input.value = ''; // reset so re-picking the same file fires change again
  },

  // Render the preview: counts, a before→after table, any errors, and the "apply" button.
  showPreview(type, r) {
    const box = document.getElementById('importPreview');
    if (r.error) { box.innerHTML = `<div class="prev-head err">שגיאה: ${r.error}</div>`; return; }
    const rowsHtml = (r.changes || []).slice(0, 100).map(c => {
      if (c.action === 'insert') return `<tr><td>${c.barcode}</td><td>מוצר חדש</td><td>${c.name || ''}</td><td></td></tr>`;
      return `<tr><td>${c.barcode}</td><td>${c.field}</td><td>${c.old == null ? '' : c.old}</td><td><b>${c.new}</b></td></tr>`;
    }).join('');
    box.innerHTML = `
      <div class="prev-head"><div><b>${r.changeCount}</b> שינויים</div>
        ${r.errorCount ? `<div class="err">${r.errorCount} שגיאות</div>` : '<div class="ok">אין שגיאות</div>'}
        <div style="flex:1"></div>
        ${r.changeCount ? `<button class="save" onclick="Admin.applyImport()">אשר ועדכן ${r.changeCount} שינויים</button>` : ''}</div>
      <div class="tablewrap"><table><thead><tr><th>ברקוד</th><th>שדה</th><th>לפני</th><th>אחרי</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      ${r.errorCount ? `<div style="margin-top:10px;color:#c0392b">דוגמאות שגיאה: ${(r.errors || []).slice(0, 8).map(e => 'שורה ' + e.row + ': ' + e.msg).join(' · ')}</div>` : ''}`;
  },

  // Actually apply the import (apply:true). The result's batch id is what you'd undo in Logs.
  async applyImport() {
    if (!Admin._imp) return;
    const r = await Admin.af('/api/admin/import/' + Admin._imp.type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileB64: Admin._imp.b64, apply: true }) }).then(x => x.json());
    document.getElementById('importPreview').innerHTML = r.applied
      ? `<div class="prev-head ok"><b>✓ עודכן!</b> ${r.changes} שינויים הוחלו (אצווה ${r.batch_id}). ניתן לבטל בלשונית לוגים.</div>`
      : `<div class="prev-head err">שגיאה: ${r.error || 'לא בוצע'}</div>`;
    Admin._imp = null;
  },

  // ---------- LOGS ----------
  // Two tables: import batches (each with an "undo" button) and individual change entries.
  async renderLogs() {
    const d = await Admin.af('/api/admin/logs').then(r => r.json());
    const bt = document.querySelector('#batchTable tbody'); bt.innerHTML = '';
    if (!d.batches.length) bt.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">אין אצוות עדיין</td></tr>';
    d.batches.forEach(b => {
      const tr = document.createElement('tr'); if (b.reverted) tr.className = 'reverted';
      tr.innerHTML = `<td class="muted">${b.batch_id}</td><td>${b.type}</td><td>${b.summary}</td><td>${b.changes}</td><td class="muted">${b.ts}</td>
        <td>${b.reverted ? '<span class="muted">בוטל</span>' : `<button class="undo" onclick="Admin.undoBatch('${b.batch_id}')">בטל</button>`}</td>`;
      bt.appendChild(tr);
    });
    const lt = document.querySelector('#logTable tbody'); lt.innerHTML = '';
    d.entries.forEach(e => {
      const tr = document.createElement('tr'); if (e.reverted) tr.className = 'reverted';
      tr.innerHTML = `<td class="muted">${e.ts}</td><td>${e.action}</td><td class="muted">#${e.entity_id}</td><td>${e.field || ''}</td>
        <td class="muted">${(e.old_value || '').slice(0, 30)}</td><td>${(e.new_value || '').slice(0, 30)}</td>`;
      lt.appendChild(tr);
    });
    Admin.loadBackups();
  },
  // Show how many JSON backups exist and when the latest was made.
  async loadBackups() {
    const list = await Admin.af('/api/admin/backups').then(r => r.json());
    document.getElementById('backupInfo').textContent = list.length ? `${list.length} גיבויים · אחרון: ${list[0].file} (${list[0].sizeKB} KB)` : 'אין גיבויים עדיין';
  },
  // Undo an entire import batch (asks first).
  async undoBatch(batch) {
    if (!confirm('לבטל את כל השינויים באצווה זו?')) return;
    const r = await Admin.af('/api/admin/undo/' + batch, { method: 'POST' }).then(x => x.json());
    alert(r.reverted ? `בוטלו ${r.changes} שינויים` : 'שגיאה בביטול');
    Admin.renderLogs();
  },
  // Make a full JSON backup of the catalog.
  async doBackup() {
    document.getElementById('backupInfo').textContent = 'יוצר גיבוי…';
    const r = await Admin.af('/api/admin/backup', { method: 'POST' }).then(x => x.json());
    Admin.loadBackups();
  },

  // ---------- DASHBOARD ----------
  // The stat tiles up top (counts, low-stock, revenue).
  async loadStats() {
    const s = await Admin.af('/api/admin/stats').then(r => r.json());
    const card = (k, v, cls) => `<div class="stat ${cls || ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    document.getElementById('stats').innerHTML =
      card('מוצרים', s.products) +
      card('מוצגים בחנות', s.visible, 'good') +
      card('מלאי נמוך (≤5)', s.low_stock, 'warn') +
      card('הזמנות', s.orders) +
      card('הזמנות חדשות', s.new_orders, 'warn') +
      card('מחזור מכירות', money(s.revenue), 'good');
  },

  // ---------- PRODUCTS ----------
  // Paginated product grid with inline editing of price / stock / visibility. Each row's
  // "save" lights up (dirty) on a change and PUTs just that product.
  async loadProducts(page) {
    this.p.page = page; this.p.q = document.getElementById('psearch').value.trim();
    const qs = new URLSearchParams({ page, pageSize: 25, sort: 'name' });
    if (this.p.q) qs.set('q', this.p.q);
    const data = await fetch('/api/products?' + qs).then(r => r.json());
    this.p.pages = Math.max(1, Math.ceil(data.total / 25));
    document.getElementById('pcount').textContent = `${data.total} מוצרים`;
    document.getElementById('ppage').textContent = `עמוד ${page} / ${this.p.pages}`;
    const tb = document.querySelector('#ptable tbody'); tb.innerHTML = '';
    data.items.forEach(p => {
      const tr = document.createElement('tr');
      const url = imgUrl(p.image_file);
      tr.innerHTML = `
        <td>${url ? `<img src="${url}" onerror="this.style.display='none'">` : ''}</td>
        <td class="muted">${p.barcode || ''}</td>
        <td><span class="nmcell">${p.name_he || p.name_en || ''}</span></td>
        <td class="muted">${p.brand_he || ''}</td>
        <td><input class="inp" type="number" step="0.1" value="${p.regular_price}"></td>
        <td><input class="inp" type="number" value="${p.stock_qty ?? ''}" style="width:64px"></td>
        <td><span class="toggle">${'1'}</span></td>
        <td><button class="save">שמור</button></td>`;
      const price = tr.children[4].firstChild, stock = tr.children[5].firstChild;
      const tog = tr.children[6].firstChild; let vis = 1; // visibility toggle (local until saved)
      const paint = () => tog.textContent = vis ? '✅' : '🚫';
      paint();
      const save = tr.children[7].firstChild;
      const dirty = () => save.classList.add('dirty'); // mark the row as having unsaved edits
      price.oninput = dirty; stock.oninput = dirty;
      tog.onclick = () => { vis = vis ? 0 : 1; paint(); dirty(); };
      save.onclick = async () => {
        await Admin.af('/api/admin/products/' + p.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regular_price: parseFloat(price.value), stock_qty: stock.value === '' ? null : parseInt(stock.value), is_visible: vis }) });
        save.classList.remove('dirty'); save.textContent = '✓';
        setTimeout(() => save.textContent = 'שמור', 1200); // brief confirmation then revert the label
      };
      tb.appendChild(tr);
    });
    document.getElementById('pprev').disabled = page <= 1;
    document.getElementById('pnext').disabled = page >= this.p.pages;
  },
  page(d) { const n = this.p.page + d; if (n >= 1 && n <= this.p.pages) this.loadProducts(n); },

  // ---------- ORDERS ----------
  // The orders list; clicking a row opens the editable order modal.
  async loadOrders() {
    const rows = await Admin.af('/api/orders').then(r => r.json());
    const tb = document.querySelector('#otable tbody'); tb.innerHTML = '';
    if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:30px">אין הזמנות עדיין</td></tr>'; return; }
    const pill = s => `<span class="pill ${s === 'new' ? 'new' : s === 'done' ? 'done' : 'packing'}">${s === 'new' ? 'חדש' : s === 'done' ? 'הושלם' : s === 'packing' ? 'בליקוט' : s}</span>`;
    rows.forEach(o => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>#${o.id}</td><td>${o.customer_name || ''}</td><td class="muted">${o.customer_phone || ''}</td>
        <td>${o.item_count}</td><td><strong>${money(o.total)}</strong></td><td>${pill(o.status)}</td><td class="muted">${o.created_at}</td>`;
      tr.onclick = () => Admin.openOrder(o.id);
      tb.appendChild(tr);
    });
  },

  // Load one order into the editor. We keep an editable copy in Admin._oe so the modal can
  // add/remove lines and change qty/price locally before saving in one PUT.
  async openOrder(id) {
    const d = await Admin.af('/api/orders/' + id).then(r => r.json());
    Admin._oe = { id, order: d.order, original: d.original || null,
      items: d.items.map(i => ({ product_id: i.product_id, barcode: i.barcode, name: i.name, unit_price: Number(i.unit_price), qty: i.qty })) };
    Admin.renderOrder();
    document.getElementById('omodal').classList.add('show');
  },
  // Draw the order editor from the working copy: customer info, editable line items, an
  // add-product search, the live total, and the save / cancel / status controls.
  renderOrder() {
    const oe = Admin._oe, o = oe.order;
    const total = oe.items.reduce((a, i) => a + i.unit_price * i.qty, 0);
    const count = oe.items.reduce((a, i) => a + i.qty, 0);
    const pill = s => `<span class="pill ${s === 'done' ? 'done' : s === 'new' ? 'new' : s === 'cancelled' ? 'new' : 'packing'}">${s === 'new' ? 'חדש' : s === 'packing' ? 'בליקוט' : s === 'done' ? 'הושלם' : s === 'cancelled' ? 'בוטל' : s}</span>`;
    const rows = oe.items.map((i, idx) => `
      <div class="oi-edit">
        <span class="oi-nm">${i.name || i.barcode || ('#' + i.product_id)}</span>
        <input class="oi-price" type="number" step="0.1" value="${i.unit_price}" onchange="Admin.oePrice(${idx},this.value)">
        <span class="qty"><button onclick="Admin.oeQty(${idx},-1)">−</button><span>${i.qty}</span><button onclick="Admin.oeQty(${idx},1)">+</button></span>
        <span class="oi-lt">${money(i.unit_price * i.qty)}</span>
        <button class="oi-rm" onclick="Admin.oeRemove(${idx})" title="הסר">🗑</button>
      </div>`).join('');
    document.getElementById('omcard').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">הזמנה #${o.id} ${pill(o.status)}</h2>
        <button onclick="document.getElementById('omodal').classList.remove('show')" style="border:none;background:none;font-size:22px">✕</button>
      </div>
      <div class="cust">
        <div class="cust-name">${o.customer_name || '—'}</div>
        <a class="cust-phone" href="tel:${o.customer_phone || ''}">📞 ${o.customer_phone || '—'}</a>
        <div class="muted">${o.customer_address || ''}${o.note ? ' · ' + o.note : ''}</div>
        <div class="muted">${o.created}</div>
      </div>
      ${oe.original ? `<button class="orig-btn" onclick="Admin.showOriginal()">📋 הצג הזמנה מקורית (ההזמנה נערכה)</button>` : ''}
      <div class="oi-head"><span>מוצר</span><span>מחיר</span><span>כמות</span><span>סה״כ</span><span></span></div>
      ${rows || '<div class="muted" style="padding:10px">אין פריטים</div>'}
      <div class="oi-add">
        <input id="oeSearch" placeholder="➕ חפש מוצר להוספה…" oninput="Admin.oeSearch(this.value)" autocomplete="off">
        <div id="oeResults" class="oe-results"></div>
      </div>
      <div class="oi" style="font-size:18px;margin-top:10px"><span>סה״כ (${count} פריטים)</span><strong>${money(total)}</strong></div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="save" style="flex:1;padding:11px" onclick="Admin.saveOrder()">שמור שינויים</button>
        ${o.status !== 'cancelled' ? `<button class="undo" onclick="Admin.cancelOrder()">בטל הזמנה</button>` : ''}
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        ${['new', 'packing', 'done'].map(s => `<button onclick="Admin.setStatus('${s}')" style="flex:1;border:1px solid var(--line);background:${o.status === s ? 'var(--green)' : '#fff'};color:#141414;border-radius:10px;padding:10px;font-weight:700">${s === 'new' ? 'חדש' : s === 'packing' ? 'בליקוט' : 'הושלם'}</button>`).join('')}
      </div>`;
  },
  // Show the saved "as the customer ordered it" snapshot (only exists once an order was edited).
  showOriginal() {
    const oe = Admin._oe, og = oe.original; if (!og) return;
    const rows = (og.items || []).map(i => `
      <div class="oi"><span>${i.name || i.barcode || ''} <small class="muted">(${i.qty} × ${money(i.unit_price)})</small></span><strong>${money(i.line_total)}</strong></div>`).join('');
    const when = og.at ? new Date(og.at).toLocaleString('he-IL') : '';
    document.getElementById('omcard').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">הזמנה מקורית #${oe.order.id}</h2>
        <button onclick="document.getElementById('omodal').classList.remove('show')" style="border:none;background:none;font-size:22px">✕</button>
      </div>
      <div class="muted" style="margin:4px 0 12px">כפי שהלקוח הזמין${when ? ' · נשמר ' + when : ''}</div>
      ${rows || '<div class="muted" style="padding:10px">אין פריטים</div>'}
      <div class="oi" style="font-size:18px;margin-top:10px"><span>סה״כ מקורי (${og.item_count} פריטים)</span><strong>${money(og.total)}</strong></div>
      <button class="save" style="width:100%;padding:11px;margin-top:14px" onclick="Admin.renderOrder()">← חזרה להזמנה הנוכחית</button>`;
  },
  // ---- order-editor line operations (all act on the local working copy, then re-render) ----
  oeQty(idx, d) { const it = Admin._oe.items[idx]; it.qty = Math.max(1, it.qty + d); Admin.renderOrder(); },
  oePrice(idx, v) { Admin._oe.items[idx].unit_price = Math.round((Number(v) || 0) * 100) / 100; Admin.renderOrder(); },
  oeRemove(idx) { Admin._oe.items.splice(idx, 1); Admin.renderOrder(); },
  // Search the catalog for a product to add to the order (debounce-free; min 2 chars).
  async oeSearch(q) {
    const box = document.getElementById('oeResults');
    if (!q || q.trim().length < 2) { box.innerHTML = ''; Admin._oeRes = []; return; }
    const d = await fetch('/api/products?q=' + encodeURIComponent(q) + '&pageSize=6').then(r => r.json());
    Admin._oeRes = d.items.map(p => ({ product_id: p.id, barcode: p.barcode, name: p.name_he || p.name_en, unit_price: Number(p.regular_price) }));
    box.innerHTML = Admin._oeRes.map((p, i) => `<div class="oe-r" onclick="Admin.oeAddIdx(${i})">${p.name} · ${money(p.unit_price)}</div>`).join('');
  },
  // Add a found product (bump qty if it's already in the order).
  oeAddIdx(i) {
    const p = Admin._oeRes[i]; if (!p) return;
    const ex = Admin._oe.items.find(x => x.product_id === p.product_id);
    if (ex) ex.qty++; else Admin._oe.items.push({ ...p, qty: 1 });
    Admin.renderOrder();
  },
  // Persist the edited order (items), close the modal, refresh the list.
  async saveOrder() {
    const r = await Admin.af('/api/admin/orders/' + Admin._oe.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: Admin._oe.items }) }).then(x => x.json());
    if (r.ok) { document.getElementById('omodal').classList.remove('show'); Admin.loadOrders(); } else alert('שגיאה בשמירה');
  },
  async cancelOrder() {
    if (!confirm('לבטל את ההזמנה?')) return;
    await Admin.af('/api/admin/orders/' + Admin._oe.id + '/cancel', { method: 'POST' });
    document.getElementById('omodal').classList.remove('show'); Admin.loadOrders();
  },
  // Just change the status (new / packing / done) without touching items.
  async setStatus(s) {
    await Admin.af('/api/admin/orders/' + Admin._oe.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s }) });
    document.getElementById('omodal').classList.remove('show'); Admin.loadOrders();
  }
};

// ---- auth ----
// The admin token lives in localStorage. Admin.af() is the fetch wrapper that attaches it
// and logs out automatically if the server ever returns 401 (token wrong/expired).
const TOKEN_KEY = 'ubi_admin_token';
Admin.token = localStorage.getItem(TOKEN_KEY) || '';
Admin.af = (url, opts = {}) => {
  opts.headers = Object.assign({ 'x-admin-token': Admin.token }, opts.headers || {});
  return fetch(url, opts).then(r => { if (r.status === 401) { Admin.logout(); throw new Error('unauthorized'); } return r; });
};
// Log in with the shop password → store the token → show the dashboard.
Admin.login = async () => {
  const pass = document.getElementById('loginPass').value;
  const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pass }) });
  if (r.ok) {
    Admin.token = (await r.json()).token; localStorage.setItem(TOKEN_KEY, Admin.token);
    document.getElementById('login').style.display = 'none'; Admin.tab('dash');
  } else { document.getElementById('loginErr').textContent = 'סיסמה שגויה'; }
};
Admin.logout = () => { Admin.token = ''; localStorage.removeItem(TOKEN_KEY); document.getElementById('login').style.display = 'flex'; };

// Enter in the product search box triggers a search.
document.getElementById('psearch').addEventListener('keydown', e => { if (e.key === 'Enter') Admin.loadProducts(1); });
// On load: if we already have a token, go straight in; otherwise show the login overlay.
if (Admin.token) { document.getElementById('login').style.display = 'none'; Admin.loadStats(); }
else { document.getElementById('login').style.display = 'flex'; }
