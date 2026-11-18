#!/bin/bash
# Name: Inkhouse
# Author: Inkhouse
# DontUseFBInk

# Opens the Inkhouse panel full screen in the Kindle's built-in browser.
#  - Close the cover: the Kindle sleeps (front light off). Open it: the panel wakes.
#  - No touch for IDLE_MIN minutes: the Kindle sleeps too. Tap power or open the cover to wake.
#  - Press power while the panel is awake: leave Inkhouse; the Kindle home screen comes back.
#  - While awake it reports its status to Home Assistant (HA_WEBHOOK) and obeys the HA helpers
#    listed under "kindle" in the Inkhouse config.json (front light, sleep minutes, keep awake, buttons).
# Approach (stop the Kindle UI, run kindle_browser with its toolbar hidden) learned from
# mitchellurgero/kindle-shortcut-browser 1.0.6; this is a smaller rewrite without its binaries.

PANEL_URL="http://192.168.1.10:8190/"   # change to your Inkhouse server address
HA_WEBHOOK=""   # empty = don't report to HA
IDLE_MIN=10      # minutes without a touch before the Kindle sleeps; 0 = never (HA can change it)
REPORT_SEC=300   # status report to HA every 5 minutes while awake
POLL_SEC=30      # check for commands from HA every 30 seconds while awake

Q=/tmp/inkhouse.events
LOG=/mnt/us/documents/inkhouse.log   # what happened, for troubleshooting; rewritten on each start
log() { echo "$(date +%H:%M:%S) $*" >> "$LOG"; }
: > "$LOG"
refresh_screen() { eips -c >/dev/null 2>&1; eips -c >/dev/null 2>&1; }
pd() { lipc-set-prop com.lab126.powerd "$1" "$2" >/dev/null 2>&1; }
pg() { lipc-get-prop "$1" "$2" 2>/dev/null; }

# One line of 23 comma-separated values; the HA template sensors read them by position, so keep the order.
# $1: 1 = panel running, 0 = leaving. Uses cover, IDLE_MIN and KEEP from the main loop.
collect() {
  local bat=/sys/class/power_supply/bd71827_bat/uevent f ch
  ps_get() { sed -n "s/^POWER_SUPPLY_$1=//p" "$bat"; }
  f=$(wpa_cli -i wlan0 signal_poll 2>/dev/null)
  ch=$(echo "$f" | sed -n 's/^FREQUENCY=//p'); ch=${ch:-0}
  if [ "$ch" -gt 4000 ]; then ch=$(( (ch - 5000) / 5 )); elif [ "$ch" -gt 0 ]; then ch=$(( (ch - 2407) / 5 )); fi
  echo "$(pg com.lab126.powerd battLevel),$(pg com.lab126.powerd isCharging),$(cat /sys/class/power_supply/bd71827_ac/online 2>/dev/null)\
,$(( $(ps_get VOLTAGE_NOW) / 1000 )),$(( $(ps_get CURRENT_NOW) / 1000 )),$(ps_get TEMP)\
,$(( $(ps_get CHARGE_FULL) * 100 / $(ps_get CHARGE_FULL_DESIGN) )),$(( $(cat /sys/class/thermal/thermal_zone1/temp) / 1000 ))\
,$(awk '/wlan0/{print int($4)}' /proc/net/wireless),$(echo "$f" | sed -n 's/^LINKSPEED=//p'),$ch\
,$(pg com.lab126.powerd state),${cover:-1},$(pg com.lab126.winmgr orientation),$(pg com.lab126.powerd flIntensity)\
,${IDLE_MIN},${KEEP:-0},${1:-1},$(cut -d. -f1 /proc/uptime),$(( $(sed -n 's/^MemAvailable: *\([0-9]*\).*/\1/p' /proc/meminfo) / 1024 ))\
,$(df -k /mnt/us | awk 'NR==2{print int($4/1024)}'),$(df -k / | awk 'NR==2{print int($4/1024)}'),$(cut -d' ' -f1 /proc/loadavg)" | tr -d ' \n'
}
# Send the status to HA and the battery to the panel server (which shows it in the top bar).
# $1: 0 = leaving; sent in the foreground so it goes out before the panel closes.
report() {
  local d; d=$(collect "${1:-1}")
  last_report=$(date +%s)
  ( [ -n "$HA_WEBHOOK" ] && wget -q -T 5 -O /dev/null "${HA_WEBHOOK}?d=$d"
    wget -q -T 5 -O /dev/null "${PANEL_URL}api/kindle?b=${d%%,*}&c=$(echo "$d" | cut -d, -f2)" ) >/dev/null 2>&1 &
  [ "${1:-1}" = 0 ] && wait $!
}

if [ ! -x /usr/bin/chromium/bin/kindle_browser ]; then
  eips 1 1 "Inkhouse: this Kindle has no built-in browser"
  sleep 5
  exit 1
fi

LIGHT=$(lipc-get-prop com.lab126.powerd flIntensity 2>/dev/null)
[ -z "$LIGHT" ] && LIGHT=6

start_browser() {
  XDG_CONFIG_HOME="/mnt/us/system/browser/" LD_LIBRARY_PATH="/usr/bin/chromium/lib:/usr/bin/chromium/usr/lib:/usr/lib/" \
  /usr/bin/chromium/bin/kindle_browser "$PANEL_URL" --no-zygote --no-sandbox --single-process \
    --skia-resource-cache-limit-mb=64 --disable-gpu --in-process-gpu --disable-gpu-sandbox \
    --disable-gpu-compositing --force-device-scale-factor=1 --js-flags=jitless \
    --content-shell-hide-toolbar --content-shell-host-window-cord=0,215 --force-gpu-mem-available-mb=32 \
    --enable-grayscale-mode --enable-low-end-device-mode --enable-low-res-tiling \
    --disable-site-isolation-trials >/dev/null 2>&1 &
  browser_pid=$!
}
restart_browser() {
  log "restarting the browser"
  kill "$browser_pid" 2>/dev/null; sleep 1; killall kindle_browser 2>/dev/null
  start_browser
}

log "starting, light $LIGHT"
# WHY: the browser takes about 10 s to load; starting it before stopping the Kindle UI lets both happen at once
start_browser
log "browser launched"

# Stop the Kindle UI so the browser gets the whole screen
trap "" TERM
stop lab126_gui
usleep 1250000
trap - TERM
log "Kindle UI stopped"
# WHY: stopping the UI also stops the touch keyboard service; restart it so text fields still work
start kb >/dev/null 2>&1
pd preventScreenSaver 1
# Safety: if stopping the UI took the browser down with it, start it again
if ! kill -0 "$browser_pid" 2>/dev/null; then log "browser was closed by the UI stop, starting it again"; start_browser; fi
log "browser running"
( sleep 15; echo report >> "$Q" ) &

# ---- Event sources, each appends one line per event to one queue file ----
# WHY: one queue read by one loop means the sleep/wake state lives in a single place,
# so a power press can mean "wake up" while asleep and "leave" while awake.
# A plain file + tail -f is used because a named pipe (mkfifo) may not exist on the Kindle.
: > "$Q"
pids=""
# WHY: '*' (all events) is the form the lid test proved works; the loop below picks the ones it needs
( lipc-wait-event -m com.lab126.hal '*' >> "$Q" 2>> "$LOG" ) & pids="$pids $!"
( lipc-wait-event -m com.lab126.powerd '*' >> "$Q" 2>> "$LOG" ) & pids="$pids $!"
( while true; do   # power button (key code 116, pressed)
    e=$(dd if=/dev/input/event1 bs=16 count=1 2>/dev/null | hexdump -v -e '16/1 "%02X"')
    [ "${e:16:4}" = "0100" ] && [ "${e:20:4}" = "7400" ] && [ "${e:24:8}" = "01000000" ] && echo power >> "$Q"
  done ) & pids="$pids $!"
( while true; do   # any touch on the screen
    dd if=/dev/input/event2 bs=16 count=1 >/dev/null 2>&1 && echo touch >> "$Q"
    sleep 1        # WHY: one touch sends dozens of events; one line a second is plenty to track idle time
  done ) & pids="$pids $!"
# Commands from HA, via the panel server: one "cmd name value" line per changed helper, plus a tick
# that drives the report and idle timers (a steady stream of touches would starve read -t).
rm -f /tmp/inkhouse.cmd
( first=1
  while true; do
    if wget -q -T 5 -O /tmp/inkhouse.cmd.new "${PANEL_URL}api/kindle/cmd" 2>/dev/null; then
      while IFS='=' read -r k v; do
        [ -z "$k" ] && continue
        [ "$v" = "$(sed -n "s/^$k=//p" /tmp/inkhouse.cmd 2>/dev/null)" ] && [ "$first" = 0 ] && continue
        # WHY: on the first poll apply HA's settings, but don't replay buttons pressed before the panel started
        case "$k" in light|sleep|awake) echo "cmd $k $v" >> "$Q" ;; *) [ "$first" = 0 ] && echo "cmd $k $v" >> "$Q" ;; esac
      done < /tmp/inkhouse.cmd.new
      mv /tmp/inkhouse.cmd.new /tmp/inkhouse.cmd; first=0
    fi
    echo tick >> "$Q"
    sleep "$POLL_SEC"
  done ) & pids="$pids $!"

go_to_sleep() {
  [ "$state" = awake ] || return
  state=sleeping
  log "going to sleep"
  lipc-get-prop com.lab126.powerd flIntensity > /tmp/inkhouse.light 2>/dev/null
  pd flIntensity 0
  pd preventScreenSaver 0
  pd powerButton 1          # same as a short power press: the Kindle goes to sleep
}

on_tick() {
  now=$(date +%s)
  if [ "$state" = awake ] && [ $((now - ${last_report:-0})) -ge "$REPORT_SEC" ]; then report; fi
  if [ "$KEEP" != 1 ] && [ "$IDLE_MIN" -gt 0 ] && [ "$state" = awake ] && [ $((now - last_touch)) -ge $((IDLE_MIN * 60)) ]; then
    go_to_sleep
  fi
}

main_loop() {
  state=awake; cover=1; KEEP=0
  last_touch=$(date +%s)
  while true; do
    if read -t 30 -r ev; then
      now=$(date +%s)
      case "$ev" in touch|tick) ;; *) log "event: $ev (state $state)" ;; esac
      case "$ev" in
        selftest) : > /tmp/inkhouse.ok ;;
        tick) on_tick ;;
        report) report ;;
        "cmd light "*)
          n=${ev#cmd light }
          case "$n" in ''|*[!0-9]*) ;; *) echo "$n" > /tmp/inkhouse.light; [ "$state" = awake ] && pd flIntensity "$n" ;; esac
          ;;
        "cmd sleep "*) n=${ev#cmd sleep }; case "$n" in ''|*[!0-9]*) ;; *) IDLE_MIN=$n; last_touch=$now ;; esac ;;
        "cmd awake "*) if [ "${ev#cmd awake }" = on ]; then KEEP=1; else KEEP=0; last_touch=$now; fi ;;
        "cmd refresh "*) [ "$state" = awake ] && { refresh_screen; restart_browser; } ;;
        "cmd reload "*) restart_browser ;;
        "cmd report "*) report ;;
        "cmd exit "*) log "leaving (from HA)"; break ;;
        "cmd restart "*) log "restarting the Kindle (from HA)"; report 0; pd deviceRestart 1 ;;
        *magSensorClosed*) cover=0; go_to_sleep ;;
        *magSensorOpened*)
          cover=1
          if [ "$state" = sleeping ]; then
            # WHY: the cover opened before the Kindle finished going to sleep; cancel instead of waiting
            state=awake; last_touch=$now; wake_time=$now
            pd preventScreenSaver 1
            pd flIntensity "$(cat /tmp/inkhouse.light 2>/dev/null || echo "$LIGHT")"
          fi
          pd wakeUp 1
          ;;
        *goingToScreenSaver*) state=asleep ;;
        *outOfScreenSaver*)
          state=awake; last_touch=$now; wake_time=$now
          pd preventScreenSaver 1
          pd flIntensity "$(cat /tmp/inkhouse.light 2>/dev/null || echo "$LIGHT")"
          report
          ;;
        # WHY: plugging in or unplugging the charger is worth reporting at once (matches charging/notCharging)
        *harging*) report ;;
        touch) [ "$state" = awake ] && last_touch=$now ;;
        power)
          # WHY: the press that wakes the Kindle also arrives here a moment later; ignore it
          if [ "$state" = awake ] && [ $((now - ${wake_time:-0})) -gt 3 ]; then log "leaving"; break; fi
          ;;
      esac
    else
      on_tick
    fi
  done
  report 0   # tell HA the panel closed
  # WHY: tail only notices the reader is gone when it writes again, so give it one more line to end on
  echo bye >> "$Q"
}

rm -f /tmp/inkhouse.ok
( tail -n +1 -f "$Q" | main_loop ) &
loop_pid=$!
echo selftest >> "$Q"
sleep 3
if [ -e /tmp/inkhouse.ok ]; then
  log "event queue works"
  wait "$loop_pid"
else
  # Safety net: if the queue doesn't work, the power button still always gets you out
  log "event queue NOT working; power button only"
  kill "$loop_pid" 2>/dev/null; killall tail 2>/dev/null
  while true; do
    e=$(dd if=/dev/input/event1 bs=16 count=1 2>/dev/null | hexdump -v -e '16/1 "%02X"')
    [ "${e:16:4}" = "0100" ] && [ "${e:20:4}" = "7400" ] && [ "${e:24:8}" = "01000000" ] && break
  done
fi

# ---- Leave: close the browser and bring the Kindle home screen back ----
kill $pids 2>/dev/null; killall lipc-wait-event tail 2>/dev/null
rm -f "$Q" /tmp/inkhouse.ok
kill "$browser_pid" 2>/dev/null; sleep 1; killall kindle_browser 2>/dev/null
pd preventScreenSaver 0
pd flIntensity "$(cat /tmp/inkhouse.light 2>/dev/null || echo "$LIGHT")"
refresh_screen
# WHY: the Kindle UI takes 30-60 s to start again; without a message the screen just looks white and stuck
eips 2 10 "Inkhouse closed."
eips 2 12 "Kindle home screen is starting."
eips 2 14 "This takes up to a minute."
cd / && start lab126_gui
exit 0
