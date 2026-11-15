#!/bin/bash
# Name: Inkhouse
# Author: Inkhouse
# DontUseFBInk

# Opens the Inkhouse panel full screen in the Kindle's built-in browser.
# Press the power button to leave; the Kindle home screen comes back.
# Approach (stop the Kindle UI, run kindle_browser with its toolbar hidden) learned from
# mitchellurgero/kindle-shortcut-browser 1.0.6; this is a smaller rewrite without its binaries.

PANEL_URL="http://192.168.1.10:8190/"   # change to your Inkhouse server address
KEEP_AWAKE=true   # stop the screensaver while the panel is open

refresh_screen() { eips -c >/dev/null 2>&1; eips -c >/dev/null 2>&1; }

if [ ! -x /usr/bin/chromium/bin/kindle_browser ]; then
  eips 1 1 "Inkhouse: this Kindle has no built-in browser"
  sleep 5
  exit 1
fi

# Stop the Kindle UI so the browser gets the whole screen
refresh_screen
trap "" TERM
stop lab126_gui
usleep 1250000
trap - TERM
refresh_screen
# WHY: stopping the UI also stops the touch keyboard service; restart it so text fields still work
start kb >/dev/null 2>&1

[ "$KEEP_AWAKE" = true ] && lipc-set-prop com.lab126.powerd preventScreenSaver 1

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

# Wait for a power button press (key code 116) on the Kindle's button input device
while true; do
  event=$(dd if=/dev/input/event1 bs=16 count=1 2>/dev/null | hexdump -v -e '16/1 "%02X"')
  if [ "${event:16:4}" = "0100" ] && [ "${event:20:4}" = "7400" ] && [ "${event:24:8}" = "01000000" ]; then
    break   # WHY: break, not exit, so the cleanup below always runs (the original exits here and leaves the UI stopped)
  fi
done

kill "$browser_pid" 2>/dev/null; sleep 1; killall kindle_browser 2>/dev/null
[ "$KEEP_AWAKE" = true ] && lipc-set-prop com.lab126.powerd preventScreenSaver 0
refresh_screen
# WHY: the Kindle UI takes 30-60 s to start again; without a message the screen just looks white and stuck
eips 2 10 "Inkhouse closed."
eips 2 12 "Kindle home screen is starting."
eips 2 14 "This takes up to a minute."
cd / && start lab126_gui
exit 0
