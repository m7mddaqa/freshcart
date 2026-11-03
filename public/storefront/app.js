// ============================================================================
// FreshCart storefront — the whole customer-facing app, vanilla JS, no framework.
//
// It's a single-page app: everything renders into #view, the bottom tab bar switches
// between home / categories / search / cart, and product details + order details slide
// up in a bottom sheet. State that must survive a refresh (the cart, the login token)
// lives in localStorage. All data comes from the /api/* endpoints in server/index.js.
// ============================================================================

// Brand identity shown in the UI — the one place to rename the app on the front-end
// (keep in sync with server/branding.js and the page <title>s).
const BRAND = { name: 'FreshCart', tagline: 'סופרמרקט · משלוחים' };

// ---- tiny formatting + helper utilities used all over the UI ----
const money = n => '₪' + Number(n || 0).toFixed(2);
// never show a raw null/empty name: fall back to brand, then a generic label
const pname = p => (p && (p.name_he || p.name_en || p.local_name || p.brand_he)) || 'מוצר ללא שם';
// weighable items are priced per kg; packaged items show their net size, never a per-gram price
const unitText = p => {
  if (!p) return '';
  if (p.is_weighable) return 'ק"ג';
  const u = p.uom_he, w = Number(p.weight);
  if (w > 0 && /גרם|ק"ג|מ"ל|ליטר|אונקיה/.test(u || '')) return (+w.toFixed(2)) + ' ' + u;
  return '';
};
const imgUrl = f => f ? '/images/' + encodeURIComponent(f) : null;
const api = p => fetch(p).then(r => r.json()); // GET + parse JSON in one go
// Make a DOM element with an optional class and innerHTML — our mini "createElement".
function el(tag, cls, html){ const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
const NOIMG = '<div class="noimg">🛍️</div>'; // shown when a product has no / a broken image
function imgFail(img){ try{ if(img&&img.parentElement) img.parentElement.innerHTML = NOIMG; }catch(e){} }
// true when running inside the installed app (Android WebView) or an installed PWA — lets us
// hide the "get the app" prompt where it would be pointless.
function isInApp(){ try{ const ua=navigator.userAgent||''; return /\bwv\b/.test(ua) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone===true; }catch(e){ return false; } }
const view = () => document.getElementById('view');     // the scrolling content area
const appbar = () => document.getElementById('appbar');  // the top bar

/* WebView Hebrew-input hardening: predictive text / autofill can break IME typing (esp. Samsung Keyboard) */
// Turn off autocomplete/correct/capitalize/spellcheck on every input so Hebrew & Arabic
// type correctly inside the Android WebView. (The native side also has a fix; this is belt-and-braces.)
function hardenInputs(){ try{ document.querySelectorAll('input:not([data-hk]),textarea:not([data-hk])').forEach(function(i){
  i.setAttribute('autocomplete','off'); i.setAttribute('autocorrect','off'); i.setAttribute('autocapitalize','off'); i.setAttribute('spellcheck','false'); i.dataset.hk='1'; }); }catch(e){} }
// Re-run the hardening whenever new DOM is added (debounced), since we build screens dynamically.
(function(){ var t; try{ new MutationObserver(function(){ clearTimeout(t); t=setTimeout(hardenInputs,150); }).observe(document.documentElement,{childList:true,subtree:true}); }catch(e){} hardenInputs(); })();

// Pick a fitting emoji for a category from keywords in its name — cheap way to give the
// category circles/tiles an icon without needing real artwork for each one.
function emojiFor(name){
  const n = (name||'');
  const m = [[/ירק|פיר|produce|אורגני/, '🥦'],[/קירור|חלב|גבינ|יוגורט|ביצ|dairy/, '🥛'],
    [/בשר|עוף|הודו|דג|meat|chicken|fish/, '🍗'],[/שימור|בישול|אפי|יסוד|grocery|תבלin|קטני/, '🥫'],
    [/לחם|מאפ|חל[הת]|bak/, '🍞'],[/דגנ|בוקר|cereal|גרנול/, '🥣'],[/מעדני|deli|נקני|סלט/, '🧀'],
    [/קפוא|גליד|frozen/, '🧊'],[/משק|שתי|מיץ|קפה|תה|bever|drink/, '🥤'],[/בריא|תזונ|דיאט|health/, '🥗'],
    [/חטיף|ממתק|שוקול|snack|candy|sweet/, '🍫'],[/ניקי|כביס|clean/, '🧽'],[/פארם|תינוק|היגיינ|baby|beauty/, '🧴'],
    [/כלי בית|פנאי|חד פעמי|house/, '🏠'],[/סיטונ|whole/, '📦']];
  for(const [rx,e] of m) if(rx.test(n)) return e;
  return '🛒';
}

/* ---------------- Cart ---------------- */
// The shopping cart, kept in localStorage so it survives a refresh / app restart.
// Shape: { [productId]: {id,name,price,image,qty,uom,weighable,weight} }.
const Cart = {
  items: JSON.parse(localStorage.getItem('freshcart_cart')||'{}'),
  // Persist, then refresh anything on screen that shows cart state (badge, cart tab, qty buttons).
  save(){ localStorage.setItem('freshcart_cart', JSON.stringify(this.items)); this.badge(); if(App.tab==='cart') App.renderCart(); refreshQtys(); },
  count(){ return Object.values(this.items).reduce((a,i)=>a+i.qty,0); },
  total(){ return Object.values(this.items).reduce((a,i)=>a+i.qty*i.price,0); },
  // Add one of a product (creating the line if it's the first).
  add(p){ const i=this.items[p.id]||{id:p.id,name:pname(p),price:p.regular_price,image:p.image_file,qty:0,uom:p.uom_he,weighable:p.is_weighable,weight:p.weight}; i.qty++; this.items[p.id]=i; this.save(); },
  // Remove one; drop the line entirely when it hits zero.
  dec(id){ const i=this.items[id]; if(!i)return; i.qty--; if(i.qty<=0) delete this.items[id]; this.save(); },
  qtyOf(id){ return this.items[id]?this.items[id].qty:0; },
  // The little number badge on the cart tab.
  badge(){ const b=document.getElementById('tabBadge'); const c=this.count(); b.textContent=c; b.classList.toggle('show',c>0); }
};

/* ---------------- Auth (phone + OTP) ---------------- */
// Customer login state. The token is our proof of identity for "my account" calls; we
// keep it plus a cached copy of the customer profile in localStorage.
const Auth = {
  token: localStorage.getItem('freshcart_token') || null,
  customer: JSON.parse(localStorage.getItem('freshcart_customer') || 'null'),
  isIn(){ return !!this.token; },
  // Save after a successful login.
  set(token, customer){ this.token=token; this.customer=customer;
    localStorage.setItem('freshcart_token', token); localStorage.setItem('freshcart_customer', JSON.stringify(customer||{})); },
  // Update just the cached profile (after editing it), keep the same token.
  update(customer){ this.customer=customer; localStorage.setItem('freshcart_customer', JSON.stringify(customer||{})); },
  clear(){ this.token=null; this.customer=null; localStorage.removeItem('freshcart_token'); localStorage.removeItem('freshcart_customer'); },
  // Add the token header to a request (merging with any extra headers).
  headers(extra){ const h=Object.assign({}, extra||{}); if(this.token) h['x-customer-token']=this.token; return h; }
};
/* fetch with the customer token; auto-logout on an expired token */
function authApi(p, opts){ opts=opts||{}; opts.headers=Auth.headers(opts.headers);
  return fetch(p,opts).then(r=>{ if(r.status===401 && Auth.isIn()) Auth.clear(); return r.json(); }); }

/* qty control used on every product card / sheet */
// Renders either a "+" (not in cart), a "− N +" stepper (in cart), or "אזל" (out of stock).
// We stash the id+price on the element so refreshQtys() can rebuild it without a product fetch.
function qtyControl(p){
  const q=Cart.qtyOf(p.id);
  const w=el('div'); w.dataset.ctl=p.id; w.dataset.price=p.regular_price;
  if(p.stock_qty===0){ w.innerHTML='<span class="sold">אזל</span>'; return w; }
  if(!q){ const b=el('button','add','+'); b.onclick=e=>{e.stopPropagation();Cart.add(p);}; w.appendChild(b); }
  else{ const d=el('div','qty',`<button>−</button><span>${q}</span><button>+</button>`);
    d.children[0].onclick=e=>{e.stopPropagation();Cart.dec(p.id);};
    d.children[2].onclick=e=>{e.stopPropagation();Cart.add(p);}; w.appendChild(d); }
  return w;
}
// After the cart changes, swap every on-screen qty control for a fresh one (no re-fetch).
function refreshQtys(){
  document.querySelectorAll('[data-ctl]').forEach(w=>{
    const id=+w.dataset.ctl, price=+w.dataset.price, q=Cart.qtyOf(id);
    const p={id,regular_price:price};
    w.replaceWith(qtyControl(p));
  });
}

/* product card element */
// One product tile for the grids and carousels: image, brand, name, price + qty control.
function productCard(p){
  const url=imgUrl(p.image_file);
  const c=el('div','pcard');
  c.innerHTML=`<div class="ph">${url?`<img src="${url}" loading="lazy" onerror="imgFail(this)">`:NOIMG}</div>
    <div class="body"><div class="br">${p.brand_he||'&nbsp;'}</div>
    <div class="nm">${pname(p)}</div>
    <div class="foot"><div class="price">${money(p.regular_price)}<small>${p.is_weighable?('ל'+unitText(p)):(unitText(p)||'&nbsp;')}</small></div><span class="slot"></span></div></div>`;
  // Tapping the image or name opens the product; the "slot" becomes the +/qty control.
  c.querySelector('.ph').onclick=()=>App.openProduct(p.id);
  c.querySelector('.nm').onclick=()=>App.openProduct(p.id);
  c.querySelector('.slot').replaceWith(qtyControl(p));
  return c;
}

/* ---------------- App ---------------- */
// The main controller: holds the current tab + cached data and renders each screen.
const App = {
  tab:'home',
  cats:null,   // categories, fetched once and reused
  list:null,   // state for the current product-list screen (filter, paging)

  // Wire up the tab bar + sheet overlay, then show the home screen.
  async init(){
    document.querySelectorAll('.tabbar .tab').forEach(t=>t.onclick=()=>App.go(t.dataset.tab));
    document.getElementById('sheetOv').onclick=()=>App.closeSheet();
    Cart.badge();
    this.go('home');
  },

  // Switch tabs: update the active state, reset scroll, and render that screen.
  go(tab){
    this.tab=tab;
    document.querySelectorAll('.tabbar .tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
    view().scrollTop=0; view().onscroll=null; // drop any infinite-scroll handler from a list screen
    if(tab==='home') this.renderHome();
    else if(tab==='categories') this.renderCategories();
    else if(tab==='search') this.renderSearch();
    else if(tab==='cart') this.renderCart();
  },

  setBar(html){ appbar().innerHTML=html; },
  // The default top bar: logo + the account button on the left.
  brandBar(){ this.setBar(`<img class="ab-logo" src="logo.svg" alt=""><div><div class="ab-title">${BRAND.name}</div><div class="ab-sub">${BRAND.tagline}</div></div><div class="ab-grow"></div><button class="ab-ic" onclick="App.openAccount()" aria-label="אזור אישי"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.2 4-6.5 8-6.5s8 2.3 8 6.5"/></svg></button>`); },

  /* ---------- HOME ---------- */
  // Landing screen: search pill, hero banner, a row of category circles, and a product
  // carousel for each of the top few categories (loaded lazily so the page paints fast).
  async renderHome(){
    this.brandBar();
    const v=view(); v.innerHTML='';
    // search pill
    const sp=el('div','searchpill','<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg> חיפוש מוצרים…');
    sp.onclick=()=>App.go('search'); v.appendChild(sp);
    // hero
    v.appendChild(el('div','hero',`<span class="pill">משלוח מהיר</span><h2>ברוכים הבאים ל‑${BRAND.name}</h2><p>אלפי מוצרים טריים עד הבית</p>`));
    // "get the app" banner — only in a regular browser (hidden inside the installed app / PWA)
    if(!isInApp()){
      const ab=el('div','getapp','<span class="ga-ic">📱</span><div class="ga-txt"><b>התקינו את האפליקציה</b><span>חווית קנייה מהירה יותר במכשיר שלכם</span></div><span class="ga-arrow">‹</span>');
      ab.onclick=()=>{ location.href='/app'; };
      v.appendChild(ab);
    }
    // categories row (placeholder then fill)
    const circWrap=el('div','section'); circWrap.innerHTML='<div class="section-head"><h3>קטגוריות</h3></div>';
    const circRow=el('div','circ-row'); circWrap.appendChild(circRow); v.appendChild(circWrap);
    const sectionsHost=el('div'); v.appendChild(sectionsHost);

    if(!this.cats) this.cats=await api('/api/categories');
    // the circular category shortcuts (first 12)
    this.cats.slice(0,12).forEach(c=>{
      const ci=el('div','circ',`<div class="ring">${emojiFor(c.name_he||c.name_en)}</div><div class="lbl">${c.name_he||c.name_en}</div>`);
      ci.onclick=()=>App.openList({category:c.id},c.name_he||c.name_en);
      circRow.appendChild(ci);
    });
    // product carousels for top categories
    for(const c of this.cats.slice(0,5)){
      const sec=el('div','section');
      sec.innerHTML=`<div class="section-head"><h3>${c.name_he||c.name_en}</h3><a>הצג הכל ›</a></div>`;
      sec.querySelector('a').onclick=()=>App.openList({category:c.id},c.name_he||c.name_en);
      const car=el('div','carousel'); sec.appendChild(car); sectionsHost.appendChild(sec);
      // fill each carousel independently so one slow category doesn't block the rest
      api(`/api/products?category=${c.id}&pageSize=10`).then(d=>{
        (d.items||[]).forEach(p=>car.appendChild(productCard(p)));
      });
    }
    sectionsHost.appendChild(el('div',null,'<div style="height:16px"></div>')); // bottom breathing room
  },

  /* ---------- CATEGORIES tab ---------- */
  // Full grid of every top-level category with its product count.
  async renderCategories(){
    this.setBar('<div class="ab-title" style="letter-spacing:0;font-size:20px">קטגוריות</div>');
    const v=view(); v.innerHTML='';
    const g=el('div','cat-grid'); v.appendChild(g);
    if(!this.cats) this.cats=await api('/api/categories');
    this.cats.forEach(c=>{
      const t=el('div','cat-tile',`<div class="emoji">${emojiFor(c.name_he||c.name_en)}</div><div><div class="cn">${c.name_he||c.name_en}</div><div class="cc">${c.n} מוצרים</div></div>`);
      t.onclick=()=>App.openList({category:c.id},c.name_he||c.name_en);
      g.appendChild(t);
    });
  },

  /* ---------- SEARCH tab ---------- */
  // Live search box; debounced so we don't fire a request on every keystroke.
  renderSearch(){
    this.setBar('<div class="ab-title" style="letter-spacing:0;font-size:20px">חיפוש</div>');
    const v=view(); v.innerHTML='';
    const bar=el('div','searchbar','<input id="sq" type="search" placeholder="חפשו מוצר, מותג או ברקוד…" autocomplete="off">');
    v.appendChild(bar);
    const results=el('div'); v.appendChild(results);
    const inp=document.getElementById('sq'); inp.focus();
    let t=null;
    inp.oninput=()=>{ clearTimeout(t); const q=inp.value.trim();
      t=setTimeout(async()=>{ if(q.length<2){results.innerHTML='';return;} // wait for 2+ chars
        const d=await api(`/api/products?q=${encodeURIComponent(q)}&pageSize=24`);
        results.innerHTML=''; const g=el('div','grid'); results.appendChild(g);
        if(!d.items.length){ results.innerHTML='<div class="empty">לא נמצאו מוצרים</div>'; return; }
        d.items.forEach(p=>g.appendChild(productCard(p)));
      },300);
    };
  },

  /* ---------- product LIST screen (infinite scroll) ---------- */
  // A filtered product listing (by category or query) that loads more as you scroll.
  async openList(filter,title){
    this.list={filter,page:0,size:20,total:1,loading:false};
    this.setBar(`<button class="ab-back" onclick="App.go('${this.tab}')">›</button><div class="ab-title" style="letter-spacing:0;font-size:18px">${title}</div><div class="ab-grow"></div><button class="ab-ic" onclick="App.go('search')"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></button>`);
    const v=view(); v.innerHTML=''; v.scrollTop=0;
    // subcategory chips
    if(filter.category){
      const chips=el('div','chips'); v.appendChild(chips);
      api(`/api/categories/${filter.category}/children`).then(kids=>{
        if(!kids.length) return;
        kids.forEach(k=>{ const ch=el('button','chip',k.name_he||k.name_en);
          ch.onclick=()=>App.openList({category:k.id},k.name_he||k.name_en); chips.appendChild(ch); });
      });
    }
    const g=el('div','grid'); v.appendChild(g); this.list.grid=g;
    await this.loadMore();
    // load the next page when we get within 400px of the bottom
    v.onscroll=()=>{ if(v.scrollTop+v.clientHeight > v.scrollHeight-400) App.loadMore(); };
  },
  // Fetch and append the next page; guarded so we don't double-load or run past the end.
  async loadMore(){
    const L=this.list; if(!L||L.loading) return;
    if(L.page>0 && L.page*L.size>=L.total) return; // already have everything
    L.loading=true; L.page++;
    const f=L.filter;
    let url=`/api/products?page=${L.page}&pageSize=${L.size}&sort=name`;
    if(f.category) url+=`&category=${f.category}`; if(f.q) url+=`&q=${encodeURIComponent(f.q)}`;
    const d=await api(url); L.total=d.total;
    d.items.forEach(p=>L.grid.appendChild(productCard(p)));
    if(L.page===1 && !d.items.length) L.grid.innerHTML='<div class="empty">אין מוצרים בקטגוריה זו</div>';
    L.loading=false;
  },

  /* ---------- CART ---------- */
  // The cart screen: each line with a qty stepper, plus a sticky total + checkout bar.
  renderCart(){
    this.setBar('<div class="ab-title" style="letter-spacing:0;font-size:20px">העגלה שלי</div>');
    const v=view(); v.innerHTML='';
    const list=Object.values(Cart.items);
    if(!list.length){ v.innerHTML='<div class="empty"><div class="big">🛒</div><h3>העגלה ריקה</h3><p>הוסיפו מוצרים כדי להתחיל</p></div>'; return; }
    const wrap=el('div','cart-wrap'); v.appendChild(wrap);
    list.forEach(i=>{
      const row=el('div','ci',`<div class="ci-main">${i.image?`<img src="${imgUrl(i.image)}" onerror="this.style.display='none'">`:''}
        <div class="cnm">${i.name||'מוצר ללא שם'}<small>${money(i.price)}${i.weighable?' / ק"ג':''}</small></div></div>
        <div class="qty"><button>−</button><span>${i.qty}</span><button>+</button></div>`);
      row.querySelector('.ci-main').onclick=()=>App.openProduct(i.id);
      const b=row.querySelectorAll('.qty button');
      // rebuild a product-ish object so Cart.add can re-store all its fields
      b[0].onclick=()=>Cart.dec(i.id); b[1].onclick=()=>Cart.add({id:i.id,name_he:i.name,regular_price:i.price,image_file:i.image,uom_he:i.uom,is_weighable:i.weighable,weight:i.weight});
      wrap.appendChild(row);
    });
    const bar=el('div','checkout-bar',`<div class="tot"><b>${money(Cart.total())}</b><small>${Cart.count()} פריטים</small></div><button class="btn" onclick="App.checkout()">המשך לתשלום ›</button>`);
    v.appendChild(bar);
  },

  // Checkout form: name / phone / address / note. Prefilled from the account if logged in.
  checkout(){
    const v=view(); v.scrollTop=0; v.innerHTML='';
    this.setBar(`<button class="ab-back" onclick="App.renderCart()">›</button><div class="ab-title" style="letter-spacing:0;font-size:18px">פרטי משלוח</div>`);
    const f=el('div','cart-wrap');
    f.innerHTML=`<label>שם מלא<input id="coName" class="co"></label><label>טלפון<input id="coPhone" class="co" inputmode="tel"></label>
      <label>כתובת<input id="coAddr" class="co"></label><label>הערה לשליח<input id="coNote" class="co"></label>
      <div style="height:90px"></div>`;
    f.querySelectorAll('.co').forEach(x=>x.style='width:100%;margin:5px 0 12px;padding:13px;border:1px solid var(--line);border-radius:12px;font-size:15px');
    v.appendChild(f);
    // prefill from the logged-in customer
    if(Auth.isIn()){ const c=Auth.customer||{};
      coName.value=c.name||''; coPhone.value=c.phone||''; coAddr.value=c.address||''; }
    v.appendChild(el('div','checkout-bar',`<div class="tot"><b>${money(Cart.total())}</b><small>${Cart.count()} פריטים</small></div><button class="btn" onclick="App.placeOrder()">שליחת הזמנה</button>`));
  },

  // Submit the order. On success: clear the cart and show a thank-you screen.
  async placeOrder(){
    const name=coName.value.trim(), phone=coPhone.value.trim();
    if(!name||!phone){ alert('נא למלא שם וטלפון'); return; }
    const body={customer:{name,phone,address:coAddr.value.trim(),note:coNote.value.trim()},items:Object.values(Cart.items).map(i=>({id:i.id,qty:i.qty}))};
    // send the token too so the order links to the account when logged in
    const r=await fetch('/api/orders',{method:'POST',headers:Auth.headers({'Content-Type':'application/json'}),body:JSON.stringify(body)}).then(x=>x.json());
    if(r.id){ Cart.items={}; Cart.save();
      this.setBar('<div class="ab-title" style="letter-spacing:0;font-size:20px">תודה!</div>');
      view().innerHTML=`<div class="empty"><div class="big">✅</div><h3>ההזמנה התקבלה</h3><p>מספר הזמנה <b>#${r.id}</b><br>סה״כ ${money(r.total)}</p><button class="btn" style="margin-top:16px" onclick="App.go('home')">חזרה לחנות</button></div>`;
    } else alert('שגיאה בשליחת ההזמנה');
  },

  /* ---------- product SHEET ---------- */
  // Bottom sheet with full product details. Shows a skeleton immediately, then fills in
  // once the fetch returns, so the tap feels instant.
  async openProduct(id){
    const sheet=document.getElementById('sheet'), ov=document.getElementById('sheetOv');
    sheet.innerHTML='<div class="grab"></div><div class="sc"><div class="simg skeleton" style="height:210px"></div><div class="skeleton" style="height:22px;margin:14px 0"></div></div>';
    ov.classList.add('show'); sheet.classList.add('show');
    const d=await api('/api/products/'+id); const p=d.product, c=d.content||{};
    const url=imgUrl(p.image_file);
    // helper: render a titled section only if there's content for it (escaping <)
    const sec=(t,x)=>x?`<div class="sec"><h4>${t}</h4><p>${String(x).replace(/</g,'&lt;')}</p></div>`:'';
    sheet.innerHTML=`<div class="grab"></div>
      <div class="sc">
        <div class="simg">${url?`<img src="${url}" onerror="imgFail(this)">`:NOIMG}</div>
        <div class="sbr">${p.brand_he||''} ${p.department?'· '+p.department:''}</div>
        <h2>${pname(p)}</h2>
        <div class="spr">${money(p.regular_price)} ${unitText(p)?`<small style="font-size:14px;color:#8a8178">${p.is_weighable?'/ ':''}${unitText(p)}</small>`:''}</div>
        ${sec('תיאור',c.description_he)}${sec('רכיבים',c.ingredients_he)}${sec('אזהרות',c.warnings_he)}${sec('אחסון',c.storage_he)}
        <div class="smeta">ברקוד: ${p.barcode||'—'}${p.origin_country?' · ארץ ייצור: '+p.origin_country:''}</div>
      </div>
      <div class="sbtnbar"><div class="tot" style="flex:1"><b style="font-size:20px">${money(p.regular_price)}</b></div><span class="sheetslot"></span></div>`;
    const slot=sheet.querySelector('.sheetslot'); const ctl=qtyControl(p);
    ctl.style.minWidth='120px'; ctl.querySelector('.add')?.classList.add('block');
    // make the add button wide in the sheet
    const addBtn=ctl.querySelector('.add'); if(addBtn){ addBtn.style.width='160px'; addBtn.textContent='הוסף לסל'; addBtn.style.fontSize='16px'; }
    slot.replaceWith(ctl);
  },
  /* ---------- ACCOUNT / LOGIN ---------- */
  // Account button: if logged in show the account screen, otherwise the login flow.
  openAccount(){ if(Auth.isIn()) this.renderAccount(); else this.renderLogin(); },
  accountBar(title){ this.setBar(`<button class="ab-back" onclick="App.go(App.tab)">›</button><div class="ab-title" style="letter-spacing:0;font-size:18px">${title}</div>`); },

  // Login screen scaffold; the actual steps (phone → code) render into #loginStep.
  renderLogin(){
    this.accountBar('כניסה / הרשמה');
    const v=view(); v.scrollTop=0; v.innerHTML='';
    const c=el('div','acct');
    c.innerHTML=`<div class="acct-hero"><img src="logo.svg" alt=""><h3>התחברות עם הטלפון</h3><p>נשלח אליכם קוד אימות חד‑פעמי ב‑SMS</p></div><div id="loginStep"></div>`;
    v.appendChild(c);
    this._renderPhoneStep();
  },
  // Step 1: ask for the phone number.
  _renderPhoneStep(){
    const s=document.getElementById('loginStep');
    s.innerHTML=`<label class="fld">מספר טלפון<input id="lgPhone" class="co" inputmode="tel" placeholder="050-0000000" value="${(Auth.customer&&Auth.customer.phone)||''}"></label>
      <button class="btn block" onclick="App.requestOtp()">שליחת קוד</button><div id="lgMsg" class="lgmsg"></div>`;
    setTimeout(()=>{ const i=document.getElementById('lgPhone'); if(i) i.focus(); },50);
  },
  // Step 1 action: send the OTP, then swap in the code-entry step.
  async requestOtp(){
    const phone=document.getElementById('lgPhone').value.trim();
    const msg=document.getElementById('lgMsg');
    if(phone.replace(/\D/g,'').length<7){ msg.textContent='מספר טלפון לא תקין'; return; }
    msg.textContent='שולח…';
    const r=await fetch('/api/auth/request-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})}).then(x=>x.json());
    if(r.error){ msg.textContent=r.error; return; }
    this._loginPhone=phone;
    const s=document.getElementById('loginStep');
    s.innerHTML=`<p class="lgto">נשלח קוד ל‑<b dir="ltr">${phone}</b></p>
      <label class="fld">קוד אימות<input id="lgCode" class="co otp" inputmode="numeric" maxlength="6" placeholder="______"></label>
      <button class="btn block" onclick="App.verifyOtp()">אימות והתחברות</button>
      <button class="lnk" onclick="App._renderPhoneStep()">שינוי מספר טלפון</button>
      <div id="lgMsg" class="lgmsg"></div>`;
    // in dev mode the server returns the code so we can show it for testing
    if(r.devCode) document.getElementById('lgMsg').innerHTML=`<span class="devhint">מצב פיתוח · קוד לבדיקה: <b>${r.devCode}</b></span>`;
    setTimeout(()=>{ const i=document.getElementById('lgCode'); if(i) i.focus(); },50);
  },
  // Step 2 action: verify the code; on success store the session and go to the account.
  async verifyOtp(){
    const code=document.getElementById('lgCode').value.trim();
    const msg=document.getElementById('lgMsg');
    msg.textContent='מאמת…';
    const r=await fetch('/api/auth/verify-otp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:this._loginPhone,code})}).then(x=>x.json());
    if(r.error||!r.token){ msg.textContent=r.error||'קוד שגוי'; return; }
    Auth.set(r.token, r.customer);
    this.renderAccount();
  },

  // The account screen: header card, personal details (view/edit), order history, logout.
  renderAccount(){
    this.accountBar('האזור האישי');
    const v=view(); v.scrollTop=0; v.innerHTML='';
    const wrap=el('div','acct');
    wrap.innerHTML=`<div id="acHead"></div>
      <div class="acct-sec">
        <div class="acct-sec-head"><h3>פרטים אישיים</h3><button id="acEditBtn" class="edit-btn" onclick="App.editProfile()">עריכה</button></div>
        <div id="acBody"></div>
      </div>
      <h3 class="acct-h">ההזמנות שלי</h3>
      <div id="myOrders" class="orders"><div class="muted2">טוען…</div></div>
      <button class="out-btn" onclick="App.logout()"><svg viewBox="0 0 24 24"><path d="M15 12H4m0 0l4-4m-4 4l4 4"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/></svg>התנתקות</button>
      <div style="height:30px"></div>`;
    v.appendChild(wrap);
    this._renderAcctHead();
    this._renderAcctView();
    this.loadMyOrders();
    // refresh from server so the header shows the customer's current full name
    authApi('/api/me').then(me=>{ if(me&&me.id){ Auth.update(me); this._renderAcctHead(); if(!this._editing) this._renderAcctView(); } }).catch(()=>{});
  },
  // Prefer "first last" if we have them, else the combined name field.
  _displayName(){ const c=Auth.customer||{}; const fl=[(c.first_name||''),(c.last_name||'')].join(' ').trim(); return fl||c.name||''; },
  // The avatar + name + phone card at the top of the account.
  _renderAcctHead(){
    const c=Auth.customer||{}; const nm=this._displayName();
    document.getElementById('acHead').innerHTML=`<div class="acct-card"><div class="acct-ph">${nm?nm.charAt(0):'🙂'}</div>
      <div><div class="acct-nm">${nm||'לקוח/ה'}</div><div class="acct-tel" dir="ltr">${c.phone||''}</div></div></div>`;
  },
  // Read-only view of the personal details.
  _renderAcctView(){
    this._editing=false;
    const c=Auth.customer||{}; const nm=this._displayName();
    const eb=document.getElementById('acEditBtn'); if(eb) eb.style.display='';
    const row=(lbl,val)=>`<div class="info-row"><span class="info-l">${lbl}</span><span class="info-v ${val?'':'empty'}">${val||'— לא הוזן —'}</span></div>`;
    document.getElementById('acBody').innerHTML=row('שם',nm)+row('טלפון',c.phone)+row('כתובת למשלוח',c.address);
  },
  // Switch the details section into an editable form (first/last name + address).
  editProfile(){
    this._editing=true;
    const c=Auth.customer||{};
    document.getElementById('acEditBtn').style.display='none';
    document.getElementById('acBody').innerHTML=`
      <div class="edit-grid">
        <label class="fld">שם פרטי<input id="acFirst" class="co"></label>
        <label class="fld">שם משפחה<input id="acLast" class="co"></label>
      </div>
      <label class="fld">כתובת למשלוח<input id="acAddr" class="co"></label>
      <div class="edit-acts">
        <button class="btn" onclick="App.saveProfile()">שמירה</button>
        <button class="btn-ghost" onclick="App._renderAcctView()">ביטול</button>
      </div>
      <div id="acMsg" class="lgmsg"></div>`;
    document.getElementById('acFirst').value=c.first_name||c.name||'';
    document.getElementById('acLast').value=c.last_name||'';
    document.getElementById('acAddr').value=c.address||'';
    document.getElementById('acFirst').focus();
  },
  // Save the edited profile back to the server, then return to the read-only view.
  async saveProfile(){
    const first_name=document.getElementById('acFirst').value.trim();
    const last_name=document.getElementById('acLast').value.trim();
    const address=document.getElementById('acAddr').value.trim();
    const msg=document.getElementById('acMsg');
    msg.textContent='שומר…';
    const r=await authApi('/api/me',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({first_name,last_name,address})});
    if(r&&r.id){ Auth.update(r); this._renderAcctHead(); this._renderAcctView(); }
    else msg.textContent='שגיאה בשמירה';
  },
  // Map an order status code to a Hebrew label.
  statusLabel(s){ return ({new:'חדשה',packing:'בליקוט',done:'הושלמה',cancelled:'בוטלה'})[s]||s; },
  // Load and render the customer's order history.
  async loadMyOrders(){
    const host=document.getElementById('myOrders');
    const list=await authApi('/api/me/orders');
    if(!Array.isArray(list)||!list.length){ host.innerHTML='<div class="muted2">עדיין אין הזמנות</div>'; return; }
    host.innerHTML='';
    list.forEach(o=>{
      const row=el('div','orow',`<div><div class="orid">הזמנה #${o.id}</div><div class="odt" dir="ltr">${o.created_at}</div></div>
        <div class="omid"><span class="ost ost-${o.status}">${App.statusLabel(o.status)}</span></div>
        <div class="otot">${money(o.total)}<small>${o.item_count} פריטים</small></div>`);
      row.onclick=()=>App.openMyOrder(o.id);
      host.appendChild(row);
    });
  },
  // One past order's details, in the bottom sheet.
  async openMyOrder(id){
    const sheet=document.getElementById('sheet'), ov=document.getElementById('sheetOv');
    sheet.innerHTML='<div class="grab"></div><div class="sc"><div class="skeleton" style="height:22px;margin:14px 0"></div><div class="skeleton" style="height:120px"></div></div>';
    ov.classList.add('show'); sheet.classList.add('show');
    const d=await authApi('/api/me/orders/'+id); const o=d.order||{}, items=d.items||[];
    sheet.innerHTML=`<div class="grab"></div><div class="sc">
      <h2 style="margin-top:8px">הזמנה #${o.id}</h2>
      <div class="sbr" dir="ltr" style="text-align:right">${o.created||''} · <span class="ost ost-${o.status}">${App.statusLabel(o.status)}</span></div>
      <div class="odet">${items.map(i=>`<div class="odi"><span class="odn">${i.name||''}</span><span class="odq">×${i.qty}</span><span>${money(i.line_total)}</span></div>`).join('')}</div>
      <div class="odtot"><span>סה״כ</span><b>${money(o.total)}</b></div><div style="height:12px"></div></div>`;
  },
  // Log out: tell the server to drop the token (best effort), clear local state, show login.
  logout(){ authApi('/api/auth/logout',{method:'POST'}).catch(()=>{}); Auth.clear(); this.renderLogin(); },

  // Close the bottom sheet.
  closeSheet(){ document.getElementById('sheet').classList.remove('show'); document.getElementById('sheetOv').classList.remove('show'); }
};

App.init(); // kick everything off
