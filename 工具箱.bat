@echo off
rem Keep this file ASCII-only: cmd.exe parses .bat using the system ANSI codepage.
rem Chinese UI text lives in menu.mjs, which runs after `chcp 65001`.
chcp 65001 >nul
cd /d "%~dp0"
title social-media-hacker-list toolbox

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found. Install Node 18+ first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

node menu.mjs

echo.
pause
