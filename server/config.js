// Central settings. Everything that could differ between machines comes from the
// environment (see .env.example), with sensible local defaults — so there are no
// secrets committed to the repo.
const path = require('path');
const crypto = require('crypto');

// Admin password: taken from ADMIN_PASSWORD if set, otherwise a random one is made
// at boot and printed to the console. That way the repo never ships a real password
// and the running server is never left on an obvious default.
const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
if (!process.env.ADMIN_PASSWORD) {
  console.log('\n  ⚠  No ADMIN_PASSWORD set — using a random one for this run:');
  console.log('     admin password: ' + adminPassword + '\n');
}

module.exports = {
  // Ports (PORT / HTTPS_PORT override the defaults).
  port: process.env.PORT || 4000,
  httpsPort: process.env.HTTPS_PORT || 4443,

  // The SQLite database file. Build it once with `npm run build:db` (or ship the file).
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'freshcart.db'),

  // Where product images live on disk (served at /images/<file>). If the folder is
  // missing or empty the UI just falls back to category emoji — so images are optional.
  imagesDir: process.env.IMAGES_DIR || path.join(__dirname, '..', 'data', 'images'),

  // The two front-ends (storefront + admin) live in ../public.
  publicDir: path.join(__dirname, '..', 'public'),

  // Admin login: `adminPassword` is typed on the login screen; the browser then holds
  // `adminToken` and sends it on every admin request. The token is random per boot, so
  // nothing sensitive is hard-coded.
  adminPassword,
  adminToken: process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex')
};
