#!/bin/sh
# Glasshouse Dock installer. Run on the TV as root (SSH, or the Homebrew
# Channel's terminal), with Glasshouse already installed and its Home on:
#
#   curl -fsSL https://raw.githubusercontent.com/SikeXML/glasshouse-dock/main/install.sh | sh
#
# With the optional cleanup of LG's apps switched on at the recommended set (Alexa, LG Channels,
# ads...); without it, everything stays off until you choose in Settings > Clean up webOS:
#
#   curl -fsSL https://raw.githubusercontent.com/SikeXML/glasshouse-dock/main/install.sh | sh -s -- --cleanup
#
# From a copy of this repository on the TV instead:  sh install.sh --local [--cleanup]
set -e

REPO="${DOCK_REPO:-SikeXML/glasshouse-dock}"
REF="${DOCK_REF:-main}"
TV=/var/lib/tvweb
DOCK=$TV/dock
HOOK=/var/lib/webosbrew/init.d/49-glasshouse-dock
LOCAL=0; CLEANUP=0; TMP=""  # never inherit $TMP from the environment: it is rm -rf'd at the end
for a in "$@"; do case "$a" in --local) LOCAL=1 ;; --cleanup) CLEANUP=1 ;; esac; done

[ "$(id -u)" = 0 ] || { echo "Run this as root on the TV."; exit 1; }
[ -f "$TV/lib/routes.js" ] && [ -x "$TV/tvwebctl" ] || {
  echo "Glasshouse is not installed in $TV. Install it first: https://github.com/rorygallagher2024/glasshouse"; exit 1; }
NODE=$(command -v node || echo /usr/bin/node)

if [ $LOCAL = 1 ]; then
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
cp "$SRC/report.sh" "$DOCK/" 2>/dev/null || true
[ -f "$SRC/VERSION" ] && cp "$SRC/VERSION" "$DOCK/"
if [ $LOCAL = 1 ]; then echo "local copy ($SRC)"; else echo "$REPO ($REF)"; fi > "$DOCK/VERSION.ref"
[ -d "$SRC/gallery" ] && { rm -rf "$DOCK/gallery"; cp -r "$SRC/gallery" "$DOCK/gallery"; }

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

RC=0; OUT=$("$NODE" "$DOCK/apply.js" 2>&1) || RC=$?
[ $RC = 0 ] || OUT="$OUT
dock: FAILED: apply.js stopped with exit code $RC"
echo "$OUT"
echo "$OUT" > "$DOCK/install-output.txt"
# A problem report anyone can send us: TV model, webOS and Glasshouse versions, what the dock changed
report() { [ -f "$DOCK/report.sh" ] && sh "$DOCK/report.sh" --apply-output "$DOCK/install-output.txt" >/dev/null 2>&1 || true; }
case "$OUT" in *changed*) echo "Restarting Glasshouse..."; "$TV/tvwebctl" restart >/dev/null 2>&1 || true; sleep 4 ;; esac
case "$OUT" in *FAILED*)
  [ -n "$TMP" ] && rm -rf "$TMP"
  echo
  echo "Glasshouse Dock could not be put in place on this TV, so it is not active."
  echo "Your TV keeps Glasshouse's own Home."
  report
  echo
  echo "A report with your TV model, webOS and Glasshouse versions is in $DOCK/report.txt"
  echo "Please open an issue and paste it in (show it with: cat $DOCK/report.txt)"
  echo "  https://github.com/$REPO/issues"
  echo "To remove the leftover files: sh $DOCK/uninstall.sh"
  exit 1 ;;
esac

# The optional cleanup of LG's apps: its files are always installed, but it does nothing until
# an option is switched on (Settings > Clean up webOS, or --cleanup for the recommended set).
mkdir -p "$DOCK/cleanup"
cp "$SRC/server/cleanup.js" "$DOCK/server/"
cp "$SRC/cleanup/hook.sh" "$SRC/cleanup/restore" "$DOCK/cleanup/"
chmod 755 "$DOCK/cleanup/restore"
CL=$(CLEANUP=$CLEANUP "$NODE" -e 'var o=require(process.argv[1]).install(process.env.CLEANUP==="1");console.log(o.guard||o.stopLgHomePreload||o.disable.length?"on":"off")' "$DOCK/server/cleanup.js")

# Reload Home so the dock shows now
luna-send -n 1 -w 3000 luna://com.palm.webappmanager/killApp '{"appId":"com.webos.app.home"}' >/dev/null 2>&1 || true
sleep 1
luna-send -n 1 -w 3000 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' >/dev/null 2>&1 || true
[ -n "$TMP" ] && rm -rf "$TMP"
report

IP=$(ip -4 -o addr show 2>/dev/null | awk '$2!="lo"{sub(/\/.*/,"",$4);print $4;exit}')
echo
echo "Glasshouse Dock is installed."
echo "Settings: Home > Down > Settings on the TV, or http://${IP:-<tv-ip>}:8080/dock/settings on a phone."
echo "Uninstall: sh $DOCK/uninstall.sh"
echo "Something not right? Run: sh $DOCK/report.sh  and paste $DOCK/report.txt into an issue."
if [ "$CL" = on ]; then
  echo
  echo "Clean up webOS is on (Settings > Clean up webOS shows and changes every option)."
  echo "Apps with a Home tile that you disable go at the next restart (Settings shows which are waiting)."
  echo "Undo everything: sh $DOCK/cleanup/restore --uninstall"
fi
