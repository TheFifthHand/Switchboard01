@echo off
title Omni Song
cd /d "%~dp0"
echo Starting Omni Song ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\serve.ps1" -Root "%~dp0app"
if errorlevel 1 (
  echo.
  echo Omni Song could not start. See "START HERE.txt" for other ways to open it.
  pause
)