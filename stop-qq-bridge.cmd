@echo off
chcp 65001 >nul
title Stop DeepSeek Whale QQ Bridge
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
pause
