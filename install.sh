#!/bin/sh
# Glasshouse Dock installer. Run on the TV as root (SSH, or the Homebrew
# Channel's terminal), with Glasshouse already installed and its Home on:
#
#   curl -fsSL https://raw.githubusercontent.com/SikeXML/glasshouse-dock/main/install.sh | sh
#
# From a copy of this repository on the TV instead:  sh install.sh --local
set -e

REPO="${DOCK_REPO:-SikeXML/glasshouse-dock}"
REF="${DOCK_REF:-main}"
TV=/var/lib/tvweb
DOCK=$TV/dock
HOOK=/var/lib/webosbrew/init.d/49-glasshouse-dock

[ "$(id -u)" = 0 ] || { echo "Run this as root on the TV."; exit 1; }
[ -f "$TV/lib/routes.js" ] && [ -x "$TV/tvwebctl" ] || {
  echo "Glasshouse is not installed in $TV. Install it first: https://github.com/rorygallagher2024/glasshouse"; exit 1; }
NODE=$(command -v node || echo /usr/bin/node)

if [ "$1" = "--local" ]; then
  SRC=$(cd "$(dirname "$0")" && pwd)
else
  TMP=$(mktemp -d /tmp/dock.XXXXXX)
  echo "Downloading $REPO ($REF)..."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar xz -C "$TMP"
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
fi
[ -f "$SRC/apply.js" ] || { echo "No dock files in $SRC"; exit 1; }

mkdir -p "$DOCK/server" "$DOCK/assets"
cp "$SRC/apply.js" "$DOCK/"
cp "$SRC/server/dock.js" "$DOCK/server/"
cp "$SRC/assets/home.html" "$SRC/assets/settings.html" "$DOCK/assets/"
cp "$SRC/uninstall.sh" "$DOCK/" 2>/dev/null || true
[ -f "$SRC/VERSION" ] && cp "$SRC/VERSION" "$DOCK/"

# At every boot, before Glasshouse starts: put the dock back if an update replaced it.
mkdir -p /var/lib/webosbrew/init.d
cat > "$HOOK" <<EOF
#!/bin/sh
# Glasshouse Dock: re-applies the dock after Glasshouse updates. Delete to stop.
[ -f $DOCK/apply.js ] || exit 0
OUT=\$($NODE $DOCK/apply.js 2>&1)
echo "\$(date): \$OUT" >> /tmp/glasshouse-dock.log
# Glasshouse already running (its hook ran first): restart it so the changes load
case "\$OUT" in *changed*) pidof node >/dev/null && ( sleep 20; $TV/tvwebctl restart >/dev/null 2>&1 ) & ;; esac
exit 0
EOF
chmod 755 "$HOOK"

OUT=$("$NODE" "$DOCK/apply.js")
echo "$OUT"
case "$OUT" in *changed*) echo "Restarting Glasshouse..."; "$TV/tvwebctl" restart >/dev/null 2>&1 || true; sleep 4 ;; esac

# Reload Home so the dock shows now
luna-send -n 1 -w 3000 luna://com.palm.webappmanager/killApp '{"appId":"com.webos.app.home"}' >/dev/null 2>&1 || true
sleep 1
luna-send -n 1 -w 3000 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' >/dev/null 2>&1 || true
[ -n "$TMP" ] && rm -rf "$TMP"

IP=$(ip -4 -o addr show 2>/dev/null | awk '$2!="lo"{sub(/\/.*/,"",$4);print $4;exit}')
echo
echo "Glasshouse Dock is installed."
echo "Settings: Home > Down > Settings on the TV, or http://${IP:-<tv-ip>}:8080/dock/settings on a phone."
echo "Uninstall: sh $DOCK/uninstall.sh"
