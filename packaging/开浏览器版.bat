@echo off
rem Browser mode: no native window, just open the UI in the default browser.
rem The server only listens on 127.0.0.1.
cd /d "%~dp0"
start "" "quickref.exe" --port 8765
