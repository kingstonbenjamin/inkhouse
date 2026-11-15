#!/bin/bash
# Name: Inkhouse
# Author: Inkhouse
# DontUseFBInk

# Opens the Inkhouse panel full screen in the Kindle's built-in browser.
#  - Close the cover: the Kindle sleeps (front light off). Open it: the panel wakes.
#  - No touch for IDLE_MIN minutes: the Kindle sleeps too. Tap power or open the cover to wake.
#  - Press power while the panel is awake: leave Inkhouse; the Kindle home screen comes back.
# Approach (stop the Kindle UI, run kindle_browser with its toolbar hidden) learned from
# mitchellurgero/kindle-shortcut-browser 1.0.6; this is a smaller rewrite without its binaries.

PANEL_URL="http://192.168.1.10:8190/"   # change to your Inkhouse server address
IDLE_MIN=10   # minutes without a touch before the Kindle sleeps; 0 = never

Q=/tmp/inkhouse.events
LOG=/mnt/us/documents/inkhouse.log   # what happened, for troubleshooting; rewritten on each start
log() { echo "$(date +%H:%M:%S) $*" >> "$LOG"; }
: > "$LOG"
refresh_screen() { eips -c >/dev/null 2>&1; eips -c >/dev/null 2>&1; }
pd() { lipc-set-prop com.lab126.powerd "$1" "$2" >/dev/null 2>&1; }

if [ ! -x /usr/bin/chromium/bin/kindle_browser ]; then
  eips 1 1 "Inkhouse: this Kindle has no built-in browser"
  sleep 5
  exit 1
fi

LIGHT=$(lipc-get-prop com.lab126.powerd flIntensity 2>/dev/null)
[ -z "$LIGHT" ] && LIGHT=6

# Stop the Kindle UI so the browser gets the whole screen
refresh_screen
trap "" TERM
stop lab126_gui
usleep 1250000
trap - TERM
log "Kindle UI stopped"
refresh_screen
# WHY: stopping the UI also stops the touch keyboard service; restart it so text fields still work
start kb >/dev/null 2>&1
pd preventScreenSaver 1

log "started, light $LIGHT"

export XDG_CONFIG_HOME="/mnt/us/system/browser/"
export LD_LIBRARY_PATH="/usr/bin/chromium/lib:/usr/bin/chromium/usr/lib:/usr/lib/"
/usr/bin/chromium/bin/kindle_browser "$PANEL_URL" --no-zygote --no-sandbox --single-process \
  --skia-resource-cache-limit-mb=64 --disable-gpu --in-process-gpu --disable-gpu-sandbox \
  --disable-gpu-compositing --force-device-scale-factor=1 --js-flags=jitless \
  --content-shell-hide-toolbar --content-shell-host-window-cord=0,215 --force-gpu-mem-available-mb=32 \
  --enable-grayscale-mode --enable-low-end-device-mode --enable-low-res-tiling \
  --disable-site-isolation-trials >/dev/null 2>&1 &
browser_pid=$!
unset LD_LIBRARY_PATH
log "browser started"

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

go_to_sleep() {
  [ "$state" = awake ] || return
  state=sleeping
  log "going to sleep"
  lipc-get-prop com.lab126.powerd flIntensity > /tmp/inkhouse.light 2>/dev/null
  pd flIntensity 0
  pd preventScreenSaver 0
  pd powerButton 1          # same as a short power press: the Kindle goes to sleep
}

main_loop() {
  state=awake
  last_touch=$(date +%s)
  while true; do
    if read -t 30 -r ev; then
      now=$(date +%s)
      [ "$ev" = touch ] || log "event: $ev (state $state)"
      case "$ev" in
        selftest) : > /tmp/inkhouse.ok ;;
        *magSensorClosed*) go_to_sleep ;;
        *magSensorOpened*) [ "$state" != awake ] && pd wakeUp 1 ;;
        *goingToScreenSaver*) state=asleep ;;
        *outOfScreenSaver*)
          state=awake; last_touch=$now; wake_time=$now
          pd preventScreenSaver 1
          pd flIntensity "$(cat /tmp/inkhouse.light 2>/dev/null || echo "$LIGHT")"
          ;;
        touch) [ "$state" = awake ] && last_touch=$now ;;
        power)
          # WHY: the press that wakes the Kindle also arrives here a moment later; ignore it
          if [ "$state" = awake ] && [ $((now - ${wake_time:-0})) -gt 3 ]; then log "leaving"; break; fi
          ;;
      esac
    else
      now=$(date +%s)
      if [ "$IDLE_MIN" -gt 0 ] && [ "$state" = awake ] && [ $((now - last_touch)) -ge $((IDLE_MIN * 60)) ]; then
        go_to_sleep
      fi
    fi
  done
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
