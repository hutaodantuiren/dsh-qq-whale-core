@echo off
chcp 65001 >nul
title 安装 DeepSeek 小鲸鱼 QQ 桥接
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
pause
