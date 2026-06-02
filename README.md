# code2.Mode — Smart Helpdesk WhatsApp

## Démarrage rapide

### 1. Prérequis
- PHP 8.2+ (WAMP inclus)
- MySQL 8.0 (WAMP inclus)
- Node.js 18+
- npm

### 2. Base de données
```bash
mysql -u root < backend/sql/schema.sql
mysql -u root < backend/sql/seed.sql
```

Ou via phpMyAdmin : importez les fichiers SQL dans l'ordre.

### 3. Lancer les services

**Option A — Script automatique (Windows)**
```
double-cliquer sur start.bat
```

**Option B — Manuellement**
```bash
# Terminal 1 — Bridge WhatsApp (port 3001)
cd whatsapp-bridge && npm install && node bridge.js

# Terminal 2 — Backend PHP (port 8000)
cd backend && php -S localhost:8000 public/index.php

# Terminal 3 — Frontend (port 5500)
npx serve frontend -p 5500
```

### 4. Accès
- **Frontend** : http://localhost:5500
- **API Health** : http://localhost:8000/api/health
- **Bridge WA** : http://localhost:3001/status

### 5. Comptes de démonstration
| Rôle  | Email | Mot de passe |
|-------|-------|-------------|
| Admin | admin@demo.com | password |
| Agent | agent@demo.com | agent123 |

### 6. Configuration Claude API
Éditez `backend/config/config.php` et remplacez `sk-ant-xxxxxxxxxx` par votre clé API Anthropic.

## Architecture

```
backend/          PHP 8.2 — MVC maison — API REST JSON — port 8000
whatsapp-bridge/  Node.js — whatsapp-web.js — port 3001
frontend/         HTML + Tailwind CSS + Vanilla JS — port 5500
```

## Fonctionnalités
- Gestion centralisée des conversations WhatsApp
- Temps réel via SSE (Server-Sent Events)
- Suggestions IA via Claude API
- Auto-réponses configurables
- Analytics et reporting
- Multi-agents avec assignation automatique
- QR Code pour connexion WhatsApp
