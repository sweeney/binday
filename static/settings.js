// settings.js — where identity and config live.
//
// This replaces the /spa-config.json endpoint the old Go server served.
// Nothing here is secret: `bindays` is a public OAuth client (it holds no
// secret and relies on PKCE), and the two URLs are published endpoints. A
// committed file is the honest representation of that.
//
// Changing an origin here means changing it in index.html's Content-Security
// -Policy too — connect-src has to name the same hosts, or the browser
// blocks the request. There is a test for that in test/csp.test.mjs.

export const settings = {
  identity_url: 'https://id.swee.net',
  config_url: 'https://config.swee.net',
  client_id: 'bindays',
  sites_namespace: 'sites',
  schemes_namespace: 'bin_schemes',
};
