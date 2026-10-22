@echo off
title shapez-ai-bridge GUI
cd /d "%~dp0.."
node gui\server.mjs
if errorlevel 1 pause
