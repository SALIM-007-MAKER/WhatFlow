@echo off
title code2.Mode — Démarrage
echo.
echo  ██████╗ ██████╗ ██████╗ ███████╗██████╗ ██╗███╗   ███╗ ██████╗ ██████╗ ███████╗
echo  ██╔════╝██╔═══██╗██╔══██╗██╔════╝╚════██╗██║████╗ ████║██╔═══██╗██╔══██╗██╔════╝
echo  ██║     ██║   ██║██║  ██║█████╗   █████╔╝██║██╔████╔██║██║   ██║██║  ██║█████╗
echo  ██║     ██║   ██║██║  ██║██╔══╝  ██╔═══╝ ██║██║╚██╔╝██║██║   ██║██║  ██║██╔══╝
echo  ╚██████╗╚██████╔╝██████╔╝███████╗███████╗██║██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗
echo   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
echo.
echo  Smart Helpdesk WhatsApp — localhost
echo  ════════════════════════════════════════════════════════════
echo.
echo  1. Assurez-vous que MySQL (WAMP) est démarré
echo  2. Importez la base de données:
echo     mysql -u root code2mode ^< backend\sql\schema.sql
echo     mysql -u root code2mode ^< backend\sql\seed.sql
echo.
echo  Démarrage des services...
echo.

REM Terminal 1 - Bridge WhatsApp
start "Bridge WhatsApp :3001" cmd /k "cd whatsapp-bridge && npm install && node bridge.js"

echo.
echo  Services lancés dans des fenêtres séparées.
echo.
echo  NOTE: Frontend et backend sont tous les deux servis par Apache (WAMP)
echo.
echo  URLs:
echo    Frontend  : http://localhost/WhatFlow/frontend/
echo    Backend   : http://localhost/WhatFlow/backend/public/api/health
echo    Bridge WA : http://localhost:3001/status
echo.
echo  Comptes:
echo    Admin : admin@demo.com / password
echo    Agent : agent@demo.com / agent123
echo.
pause
