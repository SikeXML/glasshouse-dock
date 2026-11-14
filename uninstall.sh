#!/bin/sh
# Glasshouse Dock uninstaller: puts Glasshouse's own Home page and files back.
# Your dock settings and pictures stay in /var/lib/tvweb/dock unless you add --purge.
TV=/var/lib/tvweb
DOCK=$TV/dock
NODE=$(command -v node || echo /usr/bin/node)

[ "$(id -u)" = 0 ] || { echo "Run this as root on the TV."; exit 1; }
[ -f "$DOCK/apply.js" ] && "$NODE" "$DOCK/apply.js" --remove
rm -f /var/lib/webosbrew/init.d/49-glasshouse-dock
"$TV/tvwebctl" restart >/dev/null 2>&1 || true
sleep 4
luna-send -n 1 -w 3000 luna://com.palm.webappmanager/killApp '{"appId":"com.webos.app.home"}' >/dev/null 2>&1 || true
sleep 1
luna-send -n 1 -w 3000 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' >/dev/null 2>&1 || true
if [ "$1" = "--purge" ]; then rm -rf "$DOCK"; echo "Removed, settings and pictures too."
else rm -f "$DOCK/apply.js" "$DOCK/server/dock.js"; echo "Removed. Settings kept in $DOCK (sh uninstall.sh --purge removes them)."; fi
