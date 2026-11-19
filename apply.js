/*
 * Glasshouse Dock: puts the dock in place, and puts it back after a Glasshouse
 * update has replaced Glasshouse's files. Safe to run any number of times; it
 * only touches what is missing. Run by install.sh and at every boot by the
 * hook it installs. Exit code 0; prints what it changed, and "changed" last
 * when tvweb has to restart.
 *
 *   node /var/lib/tvweb/dock/apply.js            put everything in place
 *   node /var/lib/tvweb/dock/apply.js --remove   undo all of it
 *
 * ES5: webOS 4 TVs run node 0.12.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var TV = '/var/lib/tvweb';
var DOCK = path.join(TV, 'dock');
var HOOKS = '/var/lib/webosbrew/init.d';
var MARK = 'Glasshouse Dock: the Home screen';
var remove = process.argv.indexOf('--remove') >= 0;
var restart = false;

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function write(p, s) {
  // keep the old file's mode: the init.d hooks must stay executable or run-parts skips them at boot
  var mode = 420; try { mode = fs.statSync(p).mode & 4095; } catch (e) {}
  fs.writeFileSync(p + '.dock-tmp', s, { mode: mode }); fs.chmodSync(p + '.dock-tmp', mode); fs.renameSync(p + '.dock-tmp', p);
}
function say(s) { console.log('dock: ' + s); }

/* 1. the server module, loaded from routes.js */
function serverModule() {
  var dst = path.join(TV, 'lib', 'dock.js'), src = read(path.join(DOCK, 'server', 'dock.js'));
  if (remove) { if (read(dst) !== null) { fs.unlinkSync(dst); say('removed lib/dock.js'); restart = true; } return; }
  if (src && read(dst) !== src) { write(dst, src); say('installed lib/dock.js'); restart = true; }
}
/*
 * The hook goes at the top of Glasshouse's request handler. Match it loosely
 * (spacing, parameter names, CRLF line endings) so a reformatted routes.js
 * still takes it. Returns true when the dock's server part is hooked in.
 */
var HOOKED = /^[ \t]*if \(require\('\.\/dock'\)\.handle\(\w+, \w+\)\) return;[ \t]*\r?\n/m;
var HANDLER = /function\s+handleRequest\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{[ \t]*(\r?\n)/;
function routes() {
  var p = path.join(TV, 'lib', 'routes.js'), s = read(p);
  if (s === null) { say('routes.js not found: is Glasshouse installed?'); return false; }
  var has = s.indexOf("require('./dock')") >= 0;
  if (remove) { if (has) { write(p, s.replace(HOOKED, '')); say('unhooked routes.js'); restart = true; } return false; }
  if (has) return true;
  var m = HANDLER.exec(s);
  if (!m) { say("routes.js has changed shape, so the dock can't hook in; Glasshouse's own Home stays. Please report it."); return false; }
  var at = m.index + m[0].length;
  write(p, s.slice(0, at) + "  if (require('./dock').handle(" + m[1] + ', ' + m[2] + ')) return;' + m[3] + s.slice(at));
  say('hooked routes.js'); restart = true;
  return true;
}

/* 2. the Home page itself (Glasshouse's own is kept beside it) */
function homePage(hooked) {
  var p = path.join(TV, 'assets', 'home.html'), keep = path.join(TV, 'assets', 'home.glasshouse.html'), s = read(p);
  var mine = s !== null && s.indexOf(MARK) >= 0;
  /* without the server part the dock's page has nothing to show: a black screen. Keep Glasshouse's. */
  if (remove || !hooked) {
    if (mine && read(keep) !== null) { write(p, read(keep)); fs.unlinkSync(keep); say("restored Glasshouse's Home page"); }
    if (!remove) say('FAILED: the dock is not active');
    return;
  }
  var src = read(path.join(DOCK, 'assets', 'home.html'));
  if (!src) return;
  if (!mine && s !== null) write(keep, s); /* Glasshouse's page, perhaps a newer one after an update */
  if (s !== src) { write(p, src); say('installed the Home page'); }
}

/*
 * 3. Glasshouse gives up the Home takeover when the TV refuses an optional
 * notice for the Home key (seen on webOS 11), although the takeover itself
 * worked. Treat it as the warning it is.
 */
var NOTICE_OLD = "if (!k || !k.ok) r = { ok: false, error: 'the TV did not take the Home key\\'s starting notice' };";
var NOTICE_NEW = "if (!k || !k.ok) console.warn('home: optional starting notice unavailable; keeping the Home takeover'); /* glasshouse-dock */";
function takeoverNotice() {
  var p = path.join(TV, 'lib', 'home.js'), s = read(p);
  if (s === null) return;
  if (remove) { if (s.indexOf(NOTICE_NEW) >= 0) { write(p, s.replace(NOTICE_NEW, NOTICE_OLD)); restart = true; say('restored home.js'); } return; }
  if (s.indexOf(NOTICE_OLD) >= 0) { write(p, s.replace(NOTICE_OLD, NOTICE_NEW)); restart = true; say('patched the Home takeover notice'); }
}

/*
 * 4. At power-on Glasshouse opens its Home only when the TV started on an
 * input. With "Start on Home" the TV starts on LG's Home instead, which then
 * showed nothing until the Home key. Accept that start too.
 */
var BOOT_OLD = 'com.webos.app.livetv|com.webos.app.hdmi[0-9]|com.webos.app.av[0-9]|com.webos.app.comp[0-9]) ;;';
var BOOT_NEW = 'com.webos.app.livetv|com.webos.app.hdmi[0-9]|com.webos.app.av[0-9]|com.webos.app.comp[0-9]|com.webos.app.home) ;; # glasshouse-dock';
function bootHook() {
  var names = [];
  try { names = fs.readdirSync(HOOKS); } catch (e) { return; }
  names.filter(function (n) { return /tvweb$/.test(n); }).forEach(function (n) {
    var p = path.join(HOOKS, n), s = read(p);
    if (s === null) return;
    if (remove) { if (s.indexOf(BOOT_NEW) >= 0) { write(p, s.split(BOOT_NEW).join(BOOT_OLD)); say('restored ' + n); } }
    else if (s.indexOf(BOOT_OLD) >= 0) { write(p, s.split(BOOT_OLD).join(BOOT_NEW)); say('patched ' + n + ' to open Home at power-on'); }
    // dock 0.2.0 and older left this hook without its exec bit, so Glasshouse did not start after a reboot
    try { var m = fs.statSync(p).mode; if ((m & 73) !== 73) { fs.chmodSync(p, (m & 4095) | 73); say('made ' + n + ' executable again'); } } catch (e) {}
  });
}

/* 5. Glasshouse's Home app fades in over 300 ms; the dock draws its own start */
function noFade() {
  var p = path.join(TV, 'assets', 'home-app', 'index.html'), s = read(p);
  if (s === null) return;
  if (remove) { if (s.indexOf('var FADE_MS = 0; /* glasshouse-dock */') >= 0) write(p, s.replace('var FADE_MS = 0; /* glasshouse-dock */', 'var FADE_MS = 300;')); return; }
  if (s.indexOf('var FADE_MS = 300;') >= 0) { write(p, s.replace('var FADE_MS = 300;', 'var FADE_MS = 0; /* glasshouse-dock */')); say('removed the Home fade'); }
}

serverModule(); var hooked = routes(); homePage(hooked); takeoverNotice(); bootHook(); noFade();
if (restart) console.log('changed');
