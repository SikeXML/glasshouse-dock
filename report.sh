#!/bin/sh
# Glasshouse Dock: a problem report. Writes what we need to help you into one file:
# the TV model and webOS version, the Glasshouse and dock versions, and what the dock
# could and could not change. Nothing private: no settings, location, addresses or serial numbers.
#
#   sh /var/lib/tvweb/dock/report.sh            then send us /var/lib/tvweb/dock/report.txt
#
# install.sh runs it after every install (pass it the installer's output with --apply-output FILE).
TV=/var/lib/tvweb
DOCK=$TV/dock
OUTFILE=$DOCK/report.txt
APPLY_OUT=""
[ "$1" = "--apply-output" ] && APPLY_OUT=$2
NODE=$(command -v node || echo /usr/bin/node)
mkdir -p "$DOCK"

section() { echo; echo "== $1"; }
try() { "$@" 2>&1 | head -n 40; }  # never fails, never floods
code() { command -v curl >/dev/null 2>&1 || { echo "no curl"; return; }; curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:8080$1"; }

{
  echo "Glasshouse Dock report"
  echo "Made: $(date 2>/dev/null)"

  section "Dock"
  echo "version: $(cat "$DOCK/VERSION" 2>/dev/null || echo unknown)"
  [ -f "$DOCK/VERSION.ref" ] && echo "installed from: $(cat "$DOCK/VERSION.ref")"

  section "TV"
  if command -v luna-send >/dev/null 2>&1; then
    try luna-send -n 1 -w 3000 -f luna://com.webos.service.tv.systemproperty/getSystemInfo '{"keys":["modelName","firmwareVersion","sdkVersion","boardType"]}'
  fi
  if command -v nyx-cmd >/dev/null 2>&1; then
    echo "webos_release: $(nyx-cmd OSInfo query webos_release 2>/dev/null)"
    echo "webos_build_id: $(nyx-cmd OSInfo query webos_build_id 2>/dev/null)"
    echo "webos_manufacturing_version: $(nyx-cmd OSInfo query webos_manufacturing_version 2>/dev/null)"
    echo "product_id: $(nyx-cmd DeviceInfo query product_id 2>/dev/null)"
  fi
  for f in /etc/starfish-release /etc/os-release; do [ -f "$f" ] && { echo "-- $f"; try cat "$f"; }; done
  echo "kernel: $(uname -srm 2>/dev/null)"
  echo "node: $("$NODE" -v 2>/dev/null || echo 'not found')"

  section "Glasshouse"
  for f in "$TV/VERSION" "$TV/version" "$TV/version.json" "$TV/package.json"; do
    [ -f "$f" ] && { echo "-- $f"; grep -i -m 3 'version' "$f" 2>/dev/null || head -c 200 "$f"; }
  done
  grep -h -o -i -m 1 "version[\"']\{0,1\} *[:=] *[\"'][0-9][^\"']*[\"']" "$TV"/lib/*.js 2>/dev/null | head -n 5
  echo "-- files in $TV/lib"
  ls "$TV/lib" 2>&1 | tr '\n' ' '; echo

  section "routes.js (where the dock hooks in)"
  R=$TV/lib/routes.js
  if [ -f "$R" ]; then
    echo "size: $(wc -c < "$R") bytes, lines: $(wc -l < "$R")"
    command -v md5sum >/dev/null 2>&1 && echo "md5: $(md5sum "$R" | cut -d' ' -f1)"
    grep -q "$(printf '\r')" "$R" && echo "line endings: CRLF" || echo "line endings: LF"
    if grep -q "require('./dock')" "$R"; then echo "dock hook: PRESENT"; else echo "dock hook: MISSING"; fi
    echo "-- handleRequest:"
    grep -n "handleRequest" "$R" | head -n 10
    echo "-- functions and exports:"
    grep -n -E "function |=> *\{|module\.exports|exports\." "$R" | head -n 40
  else
    echo "routes.js NOT FOUND"
  fi

  section "Dock files"
  [ -f "$TV/lib/dock.js" ] && echo "lib/dock.js: present" || echo "lib/dock.js: missing"
  if grep -q "Glasshouse Dock: the Home screen" "$TV/assets/home.html" 2>/dev/null; then echo "assets/home.html: the dock's"
  elif [ -f "$TV/assets/home.html" ]; then echo "assets/home.html: Glasshouse's own"
  else echo "assets/home.html: missing"; fi
  [ -f "$TV/assets/home.glasshouse.html" ] && echo "assets/home.glasshouse.html: present (Glasshouse's page, kept)"
  grep -q "glasshouse-dock" "$TV/lib/home.js" 2>/dev/null && echo "home.js: takeover notice patched"
  echo "-- boot hooks:"
  ls -l /var/lib/webosbrew/init.d 2>&1 | head -n 20

  section "Glasshouse answers (local, port 8080)"
  echo "/                  $(code /)"
  echo "/assets/home.html  $(code /assets/home.html)"
  echo "/api/dock/config   $(code /api/dock/config)"
  echo "/dock/settings     $(code /dock/settings)"
  echo "(200 = works, 404 = Glasshouse does not pass it to the dock, 000 = Glasshouse not running)"

  if [ -n "$APPLY_OUT" ] && [ -f "$APPLY_OUT" ]; then
    section "Installer output"
    cat "$APPLY_OUT"
  fi

  section "Dock log at boot (/tmp/glasshouse-dock.log, last lines)"
  tail -n 15 /tmp/glasshouse-dock.log 2>/dev/null || echo "none since the last restart"
} > "$OUTFILE" 2>&1

echo "Report saved: $OUTFILE"
