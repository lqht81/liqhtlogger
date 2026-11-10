@echo off
title LiqhtLogger Kurulum
echo LiqhtLogger kurulum dosyasi GitHub'dan indiriliyor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; irm 'https://raw.githubusercontent.com/lqht81/liqhtlogger/main/install.ps1' | iex"
echo.
pause
