#!/bin/sh
# Glasshouse Dock cleanup. Installed by the dock's Settings (or install.sh --cleanup) only while one
# of its options is on, and deleted when all are off. Your choices: /var/lib/tvweb/dock/cleanup/options.json
# It restarts nothing. Each part below runs only if its option is on:
#
#  guard              Every boot script must be executable, or the TV silently skips it (a lost exec
#                     bit once kept Glasshouse from starting). Fixes that, and runs the ones skipped.
#  stopLgHomePreload  LG's preload manager re-launches LG's Home in the background about a minute
#                     after start-up, which can leave Glasshouse's Home hidden on a black screen.
#                     Asks it not to (it forgets at every restart, and refuses until it is ready).
#  disable            The apps you picked:
#    - with a Home tile, or updated by LG's store: a hidden copy whose only page closes itself goes in
#      LG's writable system-app folder ($SYSAPPS), which webOS reads at start-up before it builds any
#      tile: no tile, never started, opening it does nothing. From the next restart. LG's own updated
#      copy, if any, is kept in $SAVED. They are also taken off the preload manager's list.
#    - other apps: their files are covered with that page and webOS blocks them (blockSystemApp).
#    - "bin:" entries: the program in /usr/sbin is replaced by one that does nothing.
# Nothing on the read-only system partition is written. Undo: sh /var/lib/tvweb/dock/cleanup/restore
C=/var/lib/tvweb/dock/cleanup
H=/var/lib/webosbrew/init.d
SYSAPPS=/media/system/apps/usr/palm/applications
SAVED=/media/system/dock-cleanup-saved
LOG=/tmp/glasshouse-dock-cleanup.log
ME=16
OPT=$C/options.json
[ -f $OPT ] || exit 0
on() { grep -q "\"$1\": *true" $OPT; }

# guard
if on guard; then
  skipped=""
  for f in $H/*; do
    [ -f "$f" ] && [ ! -x "$f" ] || continue
    chmod 755 "$f"; echo "$(date): made $f executable" >> $LOG
    n=$(basename "$f" | sed -n 's/^\([0-9][0-9]*\).*/\1/p')
    [ -n "$n" ] && [ "$n" -lt $ME ] && skipped="$skipped $f"
  done
  for f in $skipped; do echo "$(date): running skipped $f" >> $LOG; sh "$f" </dev/null; done
fi

command -v python3 >/dev/null 2>&1 || { echo "$(date): python3 not found, only the guard ran" >> $LOG; exit 0; }
mkdir -p $C/dead; printf '<!doctype html><script>window.close()</script>\n' > $C/dead/index.html
printf '#!/bin/sh\nexit 0\n' > $C/stub; chmod 755 $C/stub

# luna-send drops its reply when its output is not a terminal (as at boot): run it in a pty
luna() { python3 -c 'import pty,sys;pty.spawn(["luna-send","-n","1","-w","5000",sys.argv[1],sys.argv[2]])' "luna://$1" "$2" 2>/dev/null </dev/null; }
mounted() { awk -v p="$1" '$2==p {f=1} END {exit !f}' /proc/mounts; }
LIST=$(python3 -c "import json,sys;print(' '.join(json.load(open(sys.argv[1])).get('disable',[])))" $OPT 2>/dev/null)
PRELOAD="$LIST"; on stopLgHomePreload && PRELOAD="com.webos.app.home $LIST"

# stopLgHomePreload, and the picked apps the preload manager would start by itself
[ -n "$PRELOAD" ] && (
  n=0
  while [ $n -lt 45 ]; do
    luna com.webos.service.preloadmanager/getPreloadPolicy '{}' > /tmp/dc-preload.json
    todo=$(python3 - "$PRELOAD" <<'PY'
import json,sys
try: apps=json.loads(open('/tmp/dc-preload.json').read().strip())['applications']
except Exception: print('WAIT'); sys.exit()
want=sys.argv[1].split()
print(' '.join(a['id'] for a in apps if a['id'] in want and a.get('isEnabled')) or 'DONE')
PY
)
    [ "$todo" = DONE ] && { echo "$(date): preload manager: off for $(echo $PRELOAD | wc -w) apps (try $((n+1)))" >> $LOG; break; }
    [ "$todo" = WAIT ] || for id in $todo; do
      luna com.webos.service.preloadmanager/setPreloadPolicy "{\"application\":{\"id\":\"$id\",\"isEnabled\":false}}" >/dev/null
    done
    n=$((n+1)); sleep 2
  done
  [ $n -lt 45 ] || echo "$(date): preload manager did not take the policy" >> $LOG
) </dev/null >/dev/null 2>&1 &

[ -n "$LIST" ] || exit 0
# disable
(
  luna com.webos.applicationManager/listApps '{}' > /tmp/dc-apps.json
  luna com.webos.applicationManager/listLaunchPoints '{}' > /tmp/dc-lps.json
  FORCE=""
  grep -q forceBlockSystemApp /etc/palm/schemas/sam/applicationManager.blockSystemApp.schema 2>/dev/null && FORCE=',"forceBlockSystemApp":false'
  [ -d $SYSAPPS ] && HAVE_SYS=1 || HAVE_SYS=0
  python3 - "$LIST" "$C" "$HAVE_SYS" <<'PY' > /tmp/dc-plan.txt
import json,os,sys
ids, C, have_sys = sys.argv[1].split(), sys.argv[2], sys.argv[3] == '1'
# never touched, whatever the list says
PROTECTED = {'com.webos.app.home','com.palm.app.settings','com.webos.app.livetv','com.webos.app.inputcommon',
  'com.webos.app.screensaver','com.webos.app.tnativehome','com.webos.app.discovery','com.webos.app.softwareupdate',
  'com.webos.app.membership','com.webos.app.quicksettings','com.webos.app.starfish_flutter_systemui',
  'com.webos.app.keyboard','com.webos.app.notificationcenter','com.tvweb.dashboard','org.webosbrew.hbchannel'}
def load(p, k):
    try: return json.loads(open(p).read().strip())[k]
    except Exception: return None
apps = load('/tmp/dc-apps.json', 'apps'); lps = load('/tmp/dc-lps.json', 'launchPoints')
if apps is None or lps is None: print('ERROR - -'); sys.exit()
apps = {a['id']: a for a in apps}; tiles = {l['id'] for l in lps}
ROOTS = ['/usr/palm/applications', '/mnt/otncabi/usr/palm/applications']
for i in ids:
    if i.startswith('bin:'): print('bin', i, '-'); continue
    if i in PROTECTED or i.startswith('com.webos.app.hdmi'): print('protected', i, '-'); continue
    if os.path.isdir(os.path.join(C, 'overrides', i)): print('override', i, '-'); continue
    a = apps.get(i)
    if a:
        folder = a.get('folderPath', '-')
        if i in tiles or folder.startswith('/media/system/'):
            print(('override' if have_sys else 'stub'), i, folder)
        else: print('block', i, folder)
    elif any(os.path.isdir(os.path.join(r, i)) for r in ROOTS): print('block', i, '-')
    else: print('absent', i, '-')
PY
  while read -r kind id folder; do
    case "$kind" in
      ERROR) echo "$(date): app manager did not answer, cleanup skipped this boot" >> $LOG ;;
      bin)
        # only the programs Settings offers; stopped by their exact name
        name=${id#bin:}
        case "$name" in adoverlay-service) ;; *) echo "$(date): $id is not one the cleanup offers, left alone" >> $LOG; continue ;; esac
        b=/usr/sbin/$name
        [ -f "$b" ] || continue
        mounted "$b" || mount --bind $C/stub "$b"
        for pid in $(pidof "$name"); do kill -9 "$pid"; done ;;
      protected) echo "$(date): $id is needed by the TV, left alone" >> $LOG ;;
      override)
        M=$C/overrides/$id
        if [ ! -d "$M" ] && [ -f "$folder/appinfo.json" ]; then
          ver=""
          case "$folder" in /media/system/*)
            ver=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$folder/appinfo.json" 2>/dev/null) ;;
          esac
          mkdir -p "$M"
          python3 - "$folder/appinfo.json" "$M/appinfo.json" "$ver" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['visible']=False; d['type']='web'; d['main']='index.html'
if sys.argv[3]: d['version']=sys.argv[3]
json.dump(d,open(sys.argv[2],'w'),indent=1)
PY
          cp $C/dead/index.html "$M/"; : > "$M/.glasshouse-dock-cleanup"
          grep -q '^jailer:' /etc/group && chown -R root:jailer "$M"; chmod 755 "$M"; chmod 644 "$M"/*
          # keep LG's own updated copy, never one of ours
          if [ -d "$SYSAPPS/$id" ] && ! mounted "$SYSAPPS/$id" && [ ! -f "$SYSAPPS/$id/.glasshouse-dock-cleanup" ]; then
            mkdir -p $SAVED; rm -rf "$SAVED/$id"; mv "$SYSAPPS/$id" "$SAVED/$id"
          fi
          echo "$(date): $id gets its hidden copy; gone from the next restart" >> $LOG
        fi
        if [ -d "$M" ]; then
          mounted "$SYSAPPS/$id" && umount "$SYSAPPS/$id"
          if ! diff -r "$M" "$SYSAPPS/$id" >/dev/null 2>&1; then
            rm -rf "$SYSAPPS/$id"; cp -a "$M" "$SYSAPPS/$id"; echo "$(date): put back the hidden copy of $id" >> $LOG
          fi
        fi
        luna com.webos.applicationManager/closeByAppId "{\"id\":\"$id\"}" >/dev/null ;;
      block|stub)
        for r in /usr/palm/applications /mnt/otncabi/usr/palm/applications; do
          [ -d "$r/$id" ] && ! mounted "$r/$id" && mount --bind -o ro $C/dead "$r/$id"
        done
        [ "$kind" = block ] && luna com.webos.applicationManager/blockSystemApp "{\"id\":\"$id\"$FORCE}" >/dev/null
        luna com.webos.applicationManager/closeByAppId "{\"id\":\"$id\"}" >/dev/null ;;
    esac
  done < /tmp/dc-plan.txt
  echo "$(date): cleanup applied: $(cut -d' ' -f1 /tmp/dc-plan.txt | sort | uniq -c | tr -s ' ' | tr '\n' ',')" >> $LOG
) </dev/null >/dev/null 2>&1 &
exit 0
