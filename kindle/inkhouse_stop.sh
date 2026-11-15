#!/bin/bash
# Name: Inkhouse - stop
# Author: Inkhouse
# DontUseFBInk

# Rescue: closes the full-screen panel and brings the Kindle home screen back
# if the power button ever fails to do it.
eips -c >/dev/null 2>&1
killall kindle_browser 2>/dev/null
lipc-set-prop com.lab126.powerd preventScreenSaver 0
cd / && start lab126_gui
usleep 1250000
eips -c >/dev/null 2>&1
exit 0
