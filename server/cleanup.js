/*
 * Glasshouse Dock cleanup: optional, and everything is off until you switch it on in Settings.
 *   GET  /api/dock/cleanup   the options, and every app it can disable with its state on this TV
 *   POST /api/dock/cleanup   { guard, stopLgHomePreload, disable: [ids] }, any of them
 *
 * While Glasshouse runs, it also keeps LG's preload manager from loading LG's Home (if that option is
 * on) and the disabled apps in the background: see watchPreload() below.
 *
 * Your choices live in /var/lib/tvweb/dock/cleanup/options.json. While at least one is on, the boot
 * script /var/lib/webosbrew/init.d/16-glasshouse-dock-cleanup (a copy of cleanup/hook.sh, readable
 * there) applies them at every start-up. With everything off it is deleted. What each option does
 * is written in hook.sh and in the README.
 *
 * ES5: the TV runs node v0.12. MIT licence, see LICENSE.
 */
'use strict';
var fs = require('fs');
var cp = require('child_process');

var DIR = '/var/lib/tvweb/dock/cleanup';
var OPTIONS = DIR + '/options.json';
var TEMPLATE = DIR + '/hook.sh';
var RESTORE = DIR + '/restore';
var HOOK = '/var/lib/webosbrew/init.d/16-glasshouse-dock-cleanup';
var SYSAPPS = '/media/system/apps/usr/palm/applications';
var MARK = '.glasshouse-dock-cleanup';
var ROOTS = ['/usr/palm/applications', '/mnt/otncabi/usr/palm/applications'];
var ALLOW = '/var/preferences/webos-preload-manager-conf.json';   // LG's own allow list, read at its start
var ALLOW_CHANGED = DIR + '/preload-allow-changed.json';          // the entries we set to false, to give back

// [id, name, recommended]. Apps not on a TV are shown as such and skipped.
var GROUPS = [
  { key: 'alexa', title: 'Alexa and Home Hub', apps: [
    ['amazon.alexa.view', 'Amazon Alexa', 1], ['amazon.alexapr', 'Amazon Alexa (background part)', 1],
    ['com.webos.app.homeconnect', 'Home Hub', 1], ['com.webos.app.homeconnect-overlay', 'Home Hub overlay', 1]] },
  { key: 'channels', title: 'LG Channels and Sports', apps: [
    ['com.webos.app.lgchannels', 'LG Channels', 1], ['com.webos.app.sportsteamsettings', 'Sports', 1],
    ['com.webos.app.sportsalarm', 'Sports score pop-ups', 1]] },
  { key: 'ads', title: 'Ads and shopping over live TV and HDMI', desc: 'Hidden LG apps that show ads, video ads and food-delivery offers over what you watch, and the program behind them.', apps: [
    ['bin:adoverlay-service', 'Ad overlay program (runs in the background)', 1],
    ['com.webos.app.adapp', 'Advertisement', 1], ['com.webos.app.adoverlay', 'Ad overlay', 1], ['com.webos.app.adoverlayex', 'Ad overlay extension', 1],
    ['com.webos.app.adhdmi1', 'Ad overlay, HDMI 1', 1], ['com.webos.app.adhdmi2', 'Ad overlay, HDMI 2', 1],
    ['com.webos.app.adhdmi3', 'Ad overlay, HDMI 3', 1], ['com.webos.app.adhdmi4', 'Ad overlay, HDMI 4', 1],
    ['com.webos.app.videoads', 'Video ads', 1],
    ['com.webos.app.overlaycontainer', 'Commercial overlay', 1], ['com.webos.app.overlaycontainerex', 'Commercial overlay extension', 1],
    ['com.webos.app.overlaycontainerhdmi1', 'Commercial overlay, HDMI 1', 1], ['com.webos.app.overlaycontainerhdmi2', 'Commercial overlay, HDMI 2', 1],
    ['com.webos.app.overlaycontainerhdmi3', 'Commercial overlay, HDMI 3', 1], ['com.webos.app.overlaycontainerhdmi4', 'Commercial overlay, HDMI 4', 1],
    ['com.webos.app.fooddelivery', 'Food delivery overlay', 1], ['com.webos.app.fooddeliveryex', 'Food delivery overlay extension', 1],
    ['com.webos.app.fooddeliveryhdmi1', 'Food delivery overlay, HDMI 1', 1], ['com.webos.app.fooddeliveryhdmi2', 'Food delivery overlay, HDMI 2', 1],
    ['com.webos.app.fooddeliveryhdmi3', 'Food delivery overlay, HDMI 3', 1], ['com.webos.app.fooddeliveryhdmi4', 'Food delivery overlay, HDMI 4', 1]] },
  { key: 'extras', title: 'Other LG apps', apps: [
    ['com.webos.app.camera', 'Camera', 1], ['com.webos.app.multiviewsettings', 'Multi View', 1],
    ['com.webos.app.lglink-full', 'LG Link', 1], ['com.webos.app.lglink', 'LG Link (background part)', 1],
    ['com.webos.app.lifeonscreen', 'LG Gallery+', 1], ['com.webos.app.helpandtips', 'Tips', 1],
    ['com.webos.app.simplecalendar', 'Calendar', 1], ['com.webos.app.homeoffice', 'Home Office', 1],
    ['com.webos.app.learning', 'Learning', 1], ['com.webos.app.totalmusic', 'Music', 1], ['com.webos.app.rdp', 'Remote PC', 1],
    ['com.webos.app.storagemanager', 'Memory Care', 0], ['com.webos.app.mediadiscovery', 'Media Player', 0]] },
  { key: 'homes', title: "LG's Kids and Senior Home screens", apps: [
    ['com.webos.app.kidshome', 'Kids Home', 1], ['com.webos.app.seniorhome', 'Senior Home', 1]] }
];
// Never touched, whatever is asked (hook.sh refuses them too)
var PROTECTED = ['com.webos.app.home', 'com.palm.app.settings', 'com.webos.app.livetv', 'com.webos.app.inputcommon',
  'com.webos.app.screensaver', 'com.webos.app.tnativehome', 'com.webos.app.discovery', 'com.webos.app.softwareupdate',
  'com.webos.app.membership', 'com.webos.app.quicksettings', 'com.webos.app.starfish_flutter_systemui',
  'com.webos.app.keyboard', 'com.webos.app.notificationcenter', 'com.tvweb.dashboard', 'org.webosbrew.hbchannel'];
// app ids as webOS writes them; programs only from the list above (they are replaced and stopped)
var ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
function isProgram(id) { return GROUPS.some(function (g) { return g.apps.some(function (a) { return a[0] === id && id.indexOf('bin:') === 0; }); }); }
function allowed(id) {
  id = String(id);
  if (id.indexOf('bin:') === 0) return isProgram(id);
  return ID.test(id) && PROTECTED.indexOf(id) < 0 && !/^com\.webos\.app\.hdmi/.test(id);
}

function recommended() {
  var out = [];
  GROUPS.forEach(function (g) { g.apps.forEach(function (a) { if (a[2]) out.push(a[0]); }); });
  return out;
}
function readOptions() {
  var o = {};
  try { o = JSON.parse(fs.readFileSync(OPTIONS, 'utf8')); } catch (e) {}
  return { guard: o.guard === true, stopLgHomePreload: o.stopLgHomePreload === true,
    disable: (Array.isArray(o.disable) ? o.disable : []).filter(allowed) };
}
function writeOptions(o) {
  try { fs.mkdirSync(DIR); } catch (e) {}
  fs.writeFileSync(OPTIONS + '.tmp', JSON.stringify(o, null, 1) + '\n');
  fs.renameSync(OPTIONS + '.tmp', OPTIONS);
}
function anyOn(o) { return o.guard || o.stopLgHomePreload || o.disable.length > 0; }

// The boot script exists only while something is switched on; it runs once now too.
function syncHook(o) {
  if (!anyOn(o)) { try { fs.unlinkSync(HOOK); } catch (e) {} return; }
  fs.writeFileSync(HOOK, fs.readFileSync(TEMPLATE));
  fs.chmodSync(HOOK, 493);
  var c = cp.spawn('/bin/sh', [HOOK], { detached: true, stdio: 'ignore' });
  c.unref();
}

function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function mountedPaths() {
  var m = {};
  try { fs.readFileSync('/proc/mounts', 'utf8').split('\n').forEach(function (l) { var f = l.split(' '); if (f[1]) m[f[1]] = 1; }); } catch (e) {}
  return m;
}

/* What each app is doing on this TV right now:
 *   on       running normally            off       disabled
 *   restart  changes at the next restart missing   not on this TV */
function status(cb) {
  var L = require('/var/lib/tvweb/lib/luna');
  L.call('com.webos.applicationManager/listApps', {}, function (ra) {
    L.call('com.webos.applicationManager/listLaunchPoints', {}, function (rl) {
      var apps = {}, tiles = {}, o = readOptions(), mounts = mountedPaths(), dis = {};
      ((ra && ra.apps) || []).forEach(function (a) { apps[a.id] = a; });
      ((rl && rl.launchPoints) || []).forEach(function (l) { tiles[l.id] = 1; });
      o.disable.forEach(function (id) { dis[id] = 1; });
      function state(id) {
        if (id.indexOf('bin:') === 0) {
          var b = '/usr/sbin/' + id.slice(4);
          if (!exists(b)) return 'missing';
          return mounts[b] ? 'off' : dis[id] ? 'restart' : 'on';
        }
        var a = apps[id], master = exists(DIR + '/overrides/' + id), inSys = a && String(a.folderPath).indexOf(SYSAPPS + '/') === 0;
        var onDisk = master || ROOTS.some(function (r) { return exists(r + '/' + id); }) || exists(SYSAPPS + '/' + id);
        if (!a && !onDisk) return 'missing';
        if (dis[id]) {
          if (!a) return 'off';
          if (master) return inSys && a.visible === false ? 'off' : 'restart';
          return tiles[id] ? 'restart' : 'off';
        }
        if (a && inSys && a.visible === false && !exists(a.folderPath + '/' + MARK) && !exists(SYSAPPS + '/' + id + '/' + MARK)) return 'restart';
        if (!a) return 'restart';
        return 'on';
      }
      var known = {}, groups = GROUPS.map(function (g) {
        return { key: g.key, title: g.title, desc: g.desc || '', apps: g.apps.map(function (x) {
          known[x[0]] = 1;
          return { id: x[0], name: (apps[x[0]] && apps[x[0]].title) || x[1], recommended: !!x[2], disabled: !!dis[x[0]], state: state(x[0]) };
        }) };
      });
      // any other LG app that has a Home tile on this TV
      var other = Object.keys(apps).filter(function (id) {
        var a = apps[id];
        return !known[id] && allowed(id) && a.systemApp && tiles[id] && !/^(com\.limelight|youtube|spotify|netflix|amazon$)/.test(id);
      }).sort().map(function (id) { return { id: id, name: apps[id].title || id, recommended: false, disabled: !!dis[id], state: state(id) }; });
      // and anything disabled by hand that is not in a group
      o.disable.forEach(function (id) {
        if (!known[id] && !other.some(function (x) { return x.id === id; })) other.push({ id: id, name: (apps[id] && apps[id].title) || id, recommended: false, disabled: true, state: state(id) });
      });
      if (other.length) groups.push({ key: 'other', title: 'More LG apps on this TV', desc: '', apps: other });
      var restart = groups.some(function (g) { return g.apps.some(function (a) { return a.state === 'restart'; }); });
      var log = '';
      try { log = fs.readFileSync('/tmp/glasshouse-dock-cleanup.log', 'utf8').split('\n').slice(-12).join('\n'); } catch (e) {}
      cb({ ok: true, options: o, groups: groups, restart: restart, hook: exists(HOOK) ? HOOK : null,
        canHide: exists(SYSAPPS), python: exists('/usr/bin/python3'), log: log });
    });
  });
}

/*
 * LG's preload manager loads some apps in the background so they open quickly. Two things keep it off
 * the ones you chose (Glasshouse's lib/preload.js has the background):
 *  - its allow list on writable storage, read when it starts: a disabled app is set to false there, so
 *    it is never even tried. LG rewrites an entry when that app comes to the front, which a disabled
 *    app never does. Only entries set here are given back when you switch an app on again.
 *  - its policy, which it forgets at every start and, on some TVs, at every switch-on: checked every
 *    10 s, and LG's Home (option "stopLgHomePreload") and the disabled apps are switched off again.
 */
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function syncAllowList() {
  var conf = readJson(ALLOW, null);
  if (!conf || !conf.allowedApps) return;
  var o = readOptions(), changed = readJson(ALLOW_CHANGED, []), dirty = false;
  o.disable.forEach(function (id) {
    if (conf.allowedApps[id] === true) { conf.allowedApps[id] = false; dirty = true; if (changed.indexOf(id) < 0) changed.push(id); }
  });
  changed = changed.filter(function (id) {
    if (o.disable.indexOf(id) >= 0) return true;
    if (conf.allowedApps[id] === false) { conf.allowedApps[id] = true; dirty = true; }
    return false;
  });
  if (dirty) {
    var mode = 420; try { mode = fs.statSync(ALLOW).mode & 4095; } catch (e) {}
    fs.writeFileSync(ALLOW + '.tmp', JSON.stringify(conf), { mode: mode });
    fs.renameSync(ALLOW + '.tmp', ALLOW);
  }
  try { fs.writeFileSync(ALLOW_CHANGED, JSON.stringify(changed)); } catch (e) {}
}
var watching = false;
function watchPreload() {
  if (watching) return;
  watching = true;
  var L = require('/var/lib/tvweb/lib/luna');
  function tick() {
    var o = readOptions(), want = o.disable.slice();
    if (o.stopLgHomePreload) want.push('com.webos.app.home');
    if (!want.length) return;
    L.call('com.webos.service.preloadmanager/getPreloadPolicy', {}, function (r) {
      ((r && r.applications) || []).forEach(function (a) {
        if (want.indexOf(a.id) < 0 || !a.isEnabled) return;
        L.call('com.webos.service.preloadmanager/setPreloadPolicy', { application: { id: a.id, isEnabled: false } }, function (x) {
          if (x && x.returnValue) console.log('dock cleanup: LG preload switched off for ' + a.id);
        });
      });
    });
  }
  try { syncAllowList(); } catch (e) {}
  tick();
  setInterval(tick, 10000);
}

function change(body, cb) {
  if (!Array.isArray(body.disable)) return apply(body, null, cb);
  // only what Settings offers on this TV: the groups above and this TV's other LG apps with a tile
  status(function (st) {
    var offered = {};
    st.groups.forEach(function (g) { g.apps.forEach(function (a) { offered[a.id] = 1; }); });
    apply(body, offered, cb);
  });
}
function apply(body, offered, cb) {
  var o = readOptions(), before = o.disable.slice();
  if (typeof body.guard === 'boolean') o.guard = body.guard;
  if (typeof body.stopLgHomePreload === 'boolean') o.stopLgHomePreload = body.stopLgHomePreload;
  if (Array.isArray(body.disable)) {
    var seen = {};
    o.disable = body.disable.filter(function (id) {
      if (!allowed(id) || seen[id] || (offered && !offered[id] && before.indexOf(id) < 0)) return false;
      seen[id] = 1; return true;
    });
  }
  writeOptions(o);
  var back = before.filter(function (id) { return o.disable.indexOf(id) < 0; });
  function done() {
    try { syncHook(o); syncAllowList(); } catch (e) { return cb({ ok: false, error: e.message }); }
    cb({ ok: true, options: o });
  }
  if (!back.length) return done();
  cp.execFile('/bin/sh', [RESTORE].concat(back), { timeout: 60000 }, function () { done(); });
}

function handle(req, res, p, send, body) {
  if (p !== '/api/dock/cleanup') return false;
  if (req.method === 'GET') { status(function (r) { send(res, 200, r); }); return true; }
  body(req, 64 * 1024, function (e, b) {
    if (e) return send(res, 413, { ok: false, error: e.message });
    var c;
    try { c = JSON.parse(b.toString('utf8') || '{}'); } catch (x) { return send(res, 400, { ok: false, error: 'bad json' }); }
    change(c, function (r) { send(res, r.ok ? 200 : 500, r); });
  });
  return true;
}

// Installer: --cleanup switches on the recommended set; an old blocked-apps.txt becomes options.json.
function install(withRecommended) {
  var o = readOptions(), txt = DIR + '/blocked-apps.txt';
  if (!exists(OPTIONS) && exists(txt)) {
    o = { guard: true, stopLgHomePreload: true, disable: fs.readFileSync(txt, 'utf8').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== '#' && allowed(l); }) };
    try { fs.unlinkSync(txt); } catch (e) {}
  }
  if (withRecommended) { o.guard = true; o.stopLgHomePreload = true; o.disable = recommended(); }
  writeOptions(o);
  if (anyOn(o)) syncHook(o);
  try { syncAllowList(); } catch (e) {}
  return o;
}

module.exports = { handle: handle, install: install, readOptions: readOptions, recommended: recommended,
  syncAllowList: syncAllowList, watchPreload: watchPreload };
