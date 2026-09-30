@echo off
title SWITCHBOARD / 01
cd /d "%~dp0"
echo Starting SWITCHBOARD / 01 ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\serve.ps1" -Root "%~dp0app"
if errorlevel 1 (
  echo.
  echo SWITCHBOARD could not start. See "START HERE.txt" for other ways to open it.
  pause
)
