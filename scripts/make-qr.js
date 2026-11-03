// One-time build helper: generate QR codes that point at the APK download links, so you
// can scan from a phone and install. Output PNGs go in public/storefront/ (served by the app).
// Run:  npm i --no-save qrcode && node scripts/make-qr.js
const QR = require('qrcode');
const path = require('path');
const out = p => path.join(__dirname, '..', 'public', 'storefront', p);
const opts = { width: 360, margin: 1, color: { dark: '#141414', light: '#ffffff' } };

(async () => {
  await QR.toFile(out('store-qr.png'), 'https://daqa.me/store.apk', opts);
  await QR.toFile(out('manager-qr.png'), 'https://daqa.me/manager.apk', opts);
  console.log('QR codes written to public/storefront/');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
