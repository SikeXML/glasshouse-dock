/*
 * Glasshouse Dock: the server side. Loaded by Glasshouse's routes.js (one line
 * the installer adds) and serves:
 *   GET  /api/dock/config            the dock's settings
 *   POST /api/dock/config            change some of them (merged, checked)
 *   POST /api/dock/wallpaper         upload a picture (raw JPEG/PNG/WebP body)
 *   GET  /api/dock/wallpaper?id=...  a picture uploaded before
 *   GET  /dock/settings              the settings page (TV and phone)
 *   GET/POST /api/dock/cleanup       the optional cleanup of LG's apps (server/cleanup.js)
 * and, while "Start on Home" is on, keeps the TV from starting on an HDMI input
 * (which can wake a console through HDMI-CEC) by moving the last input to Home;
 * while "Bring the dock back" is on, reopens it when the screen is left empty.
 *
 * The TV runs node v0.12: ES5 only, as everywhere else in Glasshouse.
 * MIT licence, see LICENSE. Not part of Glasshouse; made to run beside it.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var url = require('url');

var ROOT = '/var/lib/tvweb/dock';
var CONFIG = path.join(ROOT, 'config.json');
var WALLS = path.join(ROOT, 'wallpapers');
var GALLERY = path.join(ROOT, 'gallery');   // public-domain paintings shipped with the dock
var ASSETS = path.join(ROOT, 'assets');
var MAX_UPLOAD = 15 * 1024 * 1024;

var DEFAULTS = {
  apps: [],                 // dock entries: "app:<id>" or "dev:<id>", up to 8; empty = the first six apps
  row2: ['dock:settings', 'dock:allapps', 'dock:lghome'],
  style: 'tiles',           // tiles | glass | liquid | clear
  tileColors: {},           // entry -> "#rrggbb" (tiles style); none = the icon's own colour
  icons: {},                // entry -> a picture of your own: "/path" on the TV or an https:// address
  size: 'medium',           // small | medium | large
  bar: true,                // the frosted bar behind the dock
  labels: false,            // names under the tiles: true, 'focus' (only the focused one) or false
  accent: '#ffffff',        // the focus ring
  position: 'bottom',       // bottom | middle
  wallpaper: { type: 'glasshouse', value: '', every: 30, caption: true },  // glasshouse | upload | gallery | color | gradient; gallery: a painting's id or "rotate"
  dim: 0.15,
  clock: { show: true, position: 'top-right', format: '24', seconds: false, date: true, size: 'medium' },
  weather: { show: false, place: '', lat: null, lon: null, units: 'c' },
  greeting: false,
  hint: true,
  startOnHome: true,
  reopenHome: true          // bring the dock back when the TV is on and nothing is on screen (see keepHomeOnScreen)
};

function mkdir(p) { try { fs.mkdirSync(p); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function merge(base, extra) {
  var out = clone(base);
  Object.keys(extra || {}).forEach(function (k) {
    var v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  });
  return out;
}

function read() {
  try { return merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG, 'utf8'))); } catch (e) { return clone(DEFAULTS); }
}
function write(c) {
  mkdir(ROOT);
  var tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONFIG);
}

var HEX = /^#[0-9a-fA-F]{6}$/;
var ENTRY = /^(app|dev|dock):[A-Za-z0-9._:\-]{1,120}$/;
function oneOf(v, list, d) { return list.indexOf(v) >= 0 ? v : d; }
function num(v, lo, hi, d) { v = Number(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
function entries(a, max) {
  if (!Array.isArray(a)) return [];
  var seen = {}, out = [];
  a.forEach(function (x) { if (typeof x === 'string' && ENTRY.test(x) && !seen[x] && out.length < max) { seen[x] = 1; out.push(x); } });
  return out;
}

/* Everything a client sends is checked against what the page can draw. */
function clean(c) {
  var o = merge(DEFAULTS, c);
  o.apps = entries(o.apps, 8);
  o.row2 = entries(o.row2, 6);
  o.style = oneOf(o.style, ['tiles', 'glass', 'liquid', 'clear'], 'tiles');
  var tc = {};
  Object.keys(o.tileColors || {}).forEach(function (k) { if (ENTRY.test(k) && HEX.test(o.tileColors[k])) tc[k] = o.tileColors[k]; });
  o.tileColors = tc;
  var ic = {};
  Object.keys(o.icons || {}).forEach(function (k) { var v = o.icons[k]; if (ENTRY.test(k) && typeof v === 'string' && /^(\/|https:\/\/)[^"'<>\s\\]{1,300}$/.test(v)) ic[k] = v; });
  o.icons = ic;
  o.size = oneOf(o.size, ['small', 'medium', 'large'], 'medium');
  o.bar = !!o.bar; o.labels = o.labels === 'focus' ? 'focus' : !!o.labels; o.greeting = !!o.greeting; o.hint = !!o.hint; o.startOnHome = !!o.startOnHome; o.reopenHome = o.reopenHome !== false;
  o.accent = HEX.test(o.accent) ? o.accent : '#ffffff';
  o.position = oneOf(o.position, ['bottom', 'middle'], 'bottom');
  var w = o.wallpaper || {};
  o.wallpaper = {
    type: oneOf(w.type, ['glasshouse', 'upload', 'gallery', 'color', 'gradient'], 'glasshouse'), value: String(w.value || '').slice(0, 200),
    every: [10, 30, 60].indexOf(Number(w.every)) >= 0 ? Number(w.every) : 30, caption: w.caption !== false
  };
  o.dim = num(o.dim, 0, 0.7, 0.15);
  var k = o.clock || {};
  o.clock = {
    show: !!k.show,
    position: oneOf(k.position, ['top-left', 'top-right', 'top-center', 'center', 'bottom-right'], 'top-right'),
    format: oneOf(String(k.format), ['12', '24'], '24'),
    seconds: !!k.seconds, date: !!k.date,
    size: oneOf(k.size, ['small', 'medium', 'large', 'huge'], 'medium')
  };
  var w2 = o.weather || {};
  o.weather = {
    show: !!w2.show, place: String(w2.place || '').slice(0, 80),
    lat: w2.lat === null || w2.lat === '' ? null : num(w2.lat, -90, 90, null),
    lon: w2.lon === null || w2.lon === '' ? null : num(w2.lon, -180, 180, null),
    units: oneOf(w2.units, ['c', 'f'], 'c')
  };
  return o;
}

function send(res, code, data, type) {
  var b = Buffer.isBuffer(data) ? data : new Buffer(typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function body(req, max, cb) {
  var chunks = [], size = 0, done = false;
  req.on('data', function (b) {
    size += b.length;
    if (size > max) { if (!done) { done = true; cb(new Error('too large')); } req.destroy(); return; }
    chunks.push(b);
  });
  req.on('end', function () { if (!done) { done = true; cb(null, Buffer.concat(chunks)); } });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}

/* the TV's address on the home network, for the "open this on a phone" line */
function lan() {
  var n = require('os').networkInterfaces(), out = null;
  Object.keys(n).forEach(function (k) {
    (n[k] || []).forEach(function (a) { if (!out && a.family === 'IPv4' && !a.internal && /^(10|172|192)\./.test(a.address)) out = a.address; });
  });
  return out;
}

function imageType(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
var MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', html: 'text/html; charset=utf-8', svg: 'image/svg+xml' };

function handle(req, res) {
  var u = url.parse(req.url, true), p = u.pathname;
  if (p !== '/dock/settings' && p.indexOf('/api/dock/') !== 0) return false;

  if (p === '/dock/settings') {
    fs.readFile(path.join(ASSETS, 'settings.html'), function (e, b) { send(res, e ? 404 : 200, e ? 'not installed' : b, MIME.html); });
    return true;
  }
  if (p === '/api/dock/config' && req.method === 'GET') { send(res, 200, { ok: true, config: read(), lan: lan() }); return true; }
  if (p === '/api/dock/config' && req.method === 'POST') {
    body(req, 64 * 1024, function (e, b) {
      if (e) return send(res, 413, { ok: false, error: e.message });
      var change;
      try { change = JSON.parse(b.toString('utf8') || '{}'); } catch (x) { return send(res, 400, { ok: false, error: 'bad json' }); }
      var c = clean(merge(read(), change));
      write(c);
      if (c.startOnHome) keepStartOffInputs();
      send(res, 200, { ok: true, config: c });
    });
    return true;
  }
  if (p === '/api/dock/wallpaper' && req.method === 'POST') {
    body(req, MAX_UPLOAD, function (e, b) {
      if (e) return send(res, 413, { ok: false, error: 'pictures up to 15 MB' });
      var t = imageType(b);
      if (!t) return send(res, 415, { ok: false, error: 'JPEG, PNG or WebP only' });
      mkdir(ROOT); mkdir(WALLS);
      var id = crypto.createHash('sha1').update(b).digest('hex').slice(0, 20) + '.' + t;
      fs.writeFile(path.join(WALLS, id), b, function (e2) {
        if (e2) return send(res, 500, { ok: false, error: e2.message });
        var c = read(); c.wallpaper = { type: 'upload', value: id }; write(clean(c));
        send(res, 200, { ok: true, id: id });
      });
    });
    return true;
  }
  if (p === '/api/dock/gallery') {
    fs.readFile(path.join(GALLERY, 'gallery.json'), 'utf8', function (e, s) {
      var list = [];
      try { list = JSON.parse(s); } catch (x) {}
      send(res, 200, { ok: true, paintings: list });
    });
    return true;
  }
  if (p === '/api/dock/gallery/img') {
    var gid = String(u.query.id || ''), thumb = u.query.thumb === '1';
    if (!/^[a-z0-9-]{1,80}\.jpg$/.test(gid)) { send(res, 400, { ok: false }); return true; }
    fs.readFile(path.join(GALLERY, thumb ? 'thumbs' : '', gid), function (e, b) {
      if (e) return send(res, 404, { ok: false });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': b.length, 'Cache-Control': 'max-age=31536000' });
      res.end(b);
    });
    return true;
  }
  if (p === '/api/dock/wallpaper' && req.method === 'GET') {
    var id = String(u.query.id || '');
    if (!/^[0-9a-f]{20}\.(jpg|png|webp)$/.test(id)) { send(res, 400, { ok: false }); return true; }
    fs.readFile(path.join(WALLS, id), function (e, b) {
      if (e) return send(res, 404, { ok: false });
      res.writeHead(200, { 'Content-Type': MIME[id.split('.').pop()], 'Content-Length': b.length, 'Cache-Control': 'max-age=31536000' });
      res.end(b);
    });
    return true;
  }
  if (p === '/api/dock/cleanup') {
    var cl = null;
    try { cl = require(path.join(ROOT, 'server', 'cleanup.js')); } catch (x) {}
    if (cl) return cl.handle(req, res, p, send, body);
  }
  send(res, 404, { ok: false, error: 'not found' });
  return true;
}

/*
 * The TV powers on into its last input. Left on an HDMI port, that input's
 * device is switched on through HDMI-CEC (a PS5 wakes up) and Home never shows.
 * With "Start on Home" on, the last input is moved to Home whenever it is an
 * input, every 15 seconds; LG keeps it in two places, so both are written.
 */
var INPUT = /^com\.webos\.app\.(hdmi|externalinput|livetv|av\d|comp\d)/;
function keepStartOffInputs() {
  if (!read().startOnHome) return;
  var L = require('./luna');
  L.call('com.webos.service.eim/getLastInput', {}, function (r) {
    if (!r || !INPUT.test(r.lastSourceAppId || '')) return;
    L.call('com.webos.service.eim/setLastInput', { type: 'HOME', appId: 'com.webos.app.home' }, function () {
      L.call('com.webos.settingsservice/setSystemSettings', {
        category: 'general',
        settings: { lastInputApp: 'com.webos.app.home', lastInputAppType: 'HOME', physicalLastInputApp: 'com.webos.app.home', physicalLastInputType: 'HOME' }
      }, function () { console.log('dock: the TV will start on Home'); });
    });
  });
}
setTimeout(function () { keepStartOffInputs(); setInterval(keepStartOffInputs, 15000); }, 20000);
/*
 * On a cold start LG restarts its web app manager about 50 s in (its lsm-ready step, once
 * /tmp/boot-done exists). That closes every web app, Glasshouse's Home included, and nothing
 * opens it again: the TV stays on a black screen until Home is pressed. With "reopenHome" on,
 * when the TV is on and no app at all is in front for two checks in a row (20 s), the dock is
 * opened. Any app, input or the screen saver in front, or the screen off, and nothing happens.
 */
var emptyFor = 0;
function keepHomeOnScreen() {
  if (!read().reopenHome) { emptyFor = 0; return; }
  var L = require('./luna');
  L.call('com.webos.service.tvpower/power/getPowerState', {}, function (p) {
    if (!p || p.state !== 'Active') { emptyFor = 0; return; }
    L.call('com.webos.applicationManager/getForegroundAppInfo', {}, function (f) {
      if (!f || !f.returnValue || f.appId) { emptyFor = 0; return; }
      if (++emptyFor < 2) return;
      emptyFor = 0;
      console.log('dock: nothing on screen for 20 s, opening the dock');
      L.call('com.webos.applicationManager/launch', { id: 'com.webos.app.home' }, function () {});
    });
  });
}
setTimeout(function () { setInterval(keepHomeOnScreen, 10000); }, 30000);

// the optional cleanup keeps LG's preload manager off the apps you chose (server/cleanup.js)
try { require(path.join(ROOT, 'server', 'cleanup.js')).watchPreload(); } catch (e) {}

module.exports = { handle: handle, read: read, clean: clean };
