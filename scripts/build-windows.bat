@echo off
REM Wrapper for build-windows.ps1 so it can be double-clicked or run from cmd.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1" %*
