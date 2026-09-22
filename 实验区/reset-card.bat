@echo off
rem Double-click to reset the lab card from the pristine character sheet.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-card.ps1"
pause
