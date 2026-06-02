// ── DOIT être défini avant tout require de puppeteer/whatsapp-web.js ─────
const path = require('path');
const fs   = require('fs');

// Forcer le cache Puppeteer dans le projet — indépendant du compte Windows
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache', 'puppeteer');

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode  = require('qrcode');
const axios   = require('axios');

const app = express();
app.use(express.json());

const PHP_WEBHOOK = process.env.PHP_WEBHOOK || 'http://localhost/WhatFlow/backend/public/api/webhook/whatsapp';
const SECRET      = process.env.BRIDGE_SECRET || 'bridge-internal-secret';
const PORT        = process.env.PORT || 3001;

// Middleware d'authentification — toutes les routes sauf /health
function requireSecret(req, res, next) {
    const header = req.headers['x-bridge-secret'];
    if (!header || header !== SECRET) {
        console.warn(`[auth] Accès refusé  route=${req.path}  ip=${req.ip}`);
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    requireSecret(req, res, next);
});

// ── Fichiers PID + Log ────────────────────────────────────────────────────
const STORAGE_DIR = path.join(__dirname, '..', 'backend', 'storage');
const LOG_DIR     = path.join(STORAGE_DIR, 'logs');
const PID_FILE    = path.join(STORAGE_DIR, 'bridge.pid');
const LOG_FILE    = path.join(LOG_DIR, 'bridge.log');

try { if (!fs.existsSync(LOG_DIR))     fs.mkdirSync(LOG_DIR,     { recursive: true }); } catch {}
try { if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true }); } catch {}
try {
    fs.writeFileSync(PID_FILE, String(process.pid));
} catch (e) {
    try { fs.writeFileSync(path.join(__dirname, 'bridge.pid'), String(process.pid)); } catch {}
}

// Log stream — toutes les traces vont aussi dans bridge.log
let _logStream = null;
try { _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); } catch {}

function _writeLine(level, args) {
    if (!_logStream) return;
    const msg  = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    _logStream.write(line);
}

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => { _log(...a);   _writeLine('INFO',  a); };
console.warn  = (...a) => { _warn(...a);  _writeLine('WARN',  a); };
console.error = (...a) => { _error(...a); _writeLine('ERROR', a); };

// Nettoyage PID à la fermeture
function _cleanup() { try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {} }
process.on('exit',   _cleanup);
process.on('SIGINT',  () => { _cleanup(); process.exit(0); });
process.on('SIGTERM', () => { _cleanup(); process.exit(0); });

// ── État client ───────────────────────────────────────────────────────────
let currentQR      = null;
let isConnected    = false;
let clientPhone    = null;
let waState        = 'UNKNOWN'; // état interne WhatsApp Web
let reconnectTimer = null;      // guard anti-reconnexion double

// ── Suivi des ACK d'envoi ─────────────────────────────────────────────────
// sendMessage() résout dès la mise en file locale — pas une preuve de livraison.
// message_ack confirme que WhatsApp Server a bien reçu le message.
const pendingAcks = new Map(); // msgId._serialized → { resolve, timer }

const ACK_NAMES = {
    '-1': 'ERROR',
    0:    'PENDING',    // en attente de serveur
    1:    'SERVER',     // ✓  reçu par les serveurs WhatsApp
    2:    'DEVICE',     // ✓✓ délivré sur l'appareil du destinataire
    3:    'READ',       // ✓✓ lu par le destinataire
    4:    'PLAYED',     // lu (media)
};

// ── LID cache (résolution numéro → chatId) ────────────────────────────────
const lidCache = new Map(); // phone → { chatId, ts }
const LID_TTL  = 1800 * 1000; // 30 minutes

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Planifie une réinitialisation du client WhatsApp.
 * Guard interne (reconnectTimer) empêche les doublons.
 */
function scheduleReinit(delayMs = 15000) {
    if (reconnectTimer) return;
    isConnected = false;
    waState     = 'REINITIALIZING';
    lidCache.clear();
    console.log(`♻️  Réinitialisation planifiée dans ${delayMs / 1000}s...`);
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        console.log('♻️  Réinitialisation du client WhatsApp...');
        try {
            await client.initialize();
        } catch (e) {
            console.error('❌ Erreur réinitialisation:', e.message);
            scheduleReinit(30000); // retry dans 30s
        }
    }, delayMs);
}

/**
 * Renvoie true si l'ID WhatsApp est un canal/newsletter (unidirectionnel).
 * Ces IDs commencent par 120363 ou se terminent par @newsletter/@broadcast.
 * On ne PEUT PAS envoyer de messages à ces destinations.
 */
function isChannelId(chatId) {
    if (!chatId) return false;
    return chatId.endsWith('@newsletter')
        || chatId.endsWith('@broadcast')
        || /^120363\d+@/.test(chatId);
}

/**
 * Résout un numéro de téléphone en identifiant WhatsApp réel via getNumberId().
 * Met en cache le résultat 1h pour éviter des appels répétés.
 */
async function resolveWhatsAppId(phone) {
    if (phone.includes('@')) return phone;

    const hit = lidCache.get(phone);
    if (hit && (Date.now() - hit.ts) < LID_TTL) {
        console.log(`[LID cache] hit   ${phone} → ${hit.chatId}`);
        return hit.chatId;
    }

    console.log(`[LID cache] miss  ${phone} — appel getNumberId…`);
    const numberId = await client.getNumberId(phone);
    if (!numberId) return null;

    const chatId = numberId._serialized;
    lidCache.set(phone, { chatId, ts: Date.now() });
    console.log(`[LID cache] store ${phone} → ${chatId}`);
    return chatId;
}

/**
 * Attend la confirmation WhatsApp Server (ACK ≥ 1) pour un message envoyé.
 * Résout avec { ack, ackName } ou avec ackName='TIMEOUT' si pas de réponse.
 */
function waitForAck(msgSerializedId, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingAcks.delete(msgSerializedId);
            console.warn(`[ACK] timeout  msgId=${msgSerializedId}`);
            resolve({ ack: -1, ackName: 'TIMEOUT' });
        }, timeoutMs);

        pendingAcks.set(msgSerializedId, {
            resolve: (result) => {
                clearTimeout(timer);
                pendingAcks.delete(msgSerializedId);
                resolve(result);
            },
        });
    });
}

// ── Détection Chrome système ──────────────────────────────────────────────
function findSystemChrome() {
    const candidates = [
        // Windows — chemins courants
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA  || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env.LOCALAPPDATA  || '', 'Chromium\\Application\\chrome.exe'),
        // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
    ].filter(Boolean);

    for (const p of candidates) {
        try { if (fs.existsSync(p)) { console.log(`[chrome] Trouvé : ${p}`); return p; } } catch {}
    }
    console.warn('[chrome] Aucun Chrome système trouvé — utilisation du Chrome téléchargé par Puppeteer');
    return undefined;
}

const CHROME_PATH = findSystemChrome();

// ── Client WhatsApp ───────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),

    // Cache la version de WhatsApp Web localement → évite les recharges d'update
    webVersionCache: {
        type: 'local',
        path: path.join(__dirname, '.wwebjs_cache'),
    },

    puppeteer: {
        headless:       true,
        executablePath: CHROME_PATH,   // undefined = Puppeteer utilise son Chrome interne
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
        ],
    },

    restartOnAuthFail:  true,
    takeoverOnConflict: true,
    takeoverTimeoutMs:  10000,
});

// ── Événements client WhatsApp ────────────────────────────────────────────

client.on('qr', async (qr) => {
    try {
        currentQR   = await qrcode.toDataURL(qr);
        isConnected = false;
        console.log('📱 QR Code généré — scannez avec WhatsApp.');
    } catch (e) {
        console.error('QR generation error:', e.message);
    }
});

client.on('ready', () => {
    isConnected = true;
    currentQR   = null;
    clientPhone = client.info?.wid?.user || null;
    waState     = 'CONNECTED';
    console.log('✅ WhatsApp connecté — numéro:', clientPhone);
});

client.on('disconnected', (reason) => {
    isConnected = false;
    waState     = 'DISCONNECTED';
    lidCache.clear(); // les IDs résolus peuvent être périmés après reconnexion
    console.log('❌ WhatsApp déconnecté:', reason);

    // LOGOUT = déconnexion volontaire depuis le téléphone — pas de reconnexion auto
    if (reason === 'LOGOUT') {
        console.log('🚪 Déconnexion volontaire — bridge en attente, rescannez le QR code');
        return;
    }

    scheduleReinit(15000);
});

client.on('auth_failure', (msg) => {
    isConnected = false;
    waState     = 'AUTH_FAILURE';
    console.error('❌ Échec d\'authentification WhatsApp:', msg);
});

client.on('change_state', (state) => {
    waState = state;
    console.log('[WA state]', state);
    if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
        isConnected = false;
        console.warn(`⚠️  Session WhatsApp invalide (${state}) — reconnexion nécessaire`);
    }
});

// Confirmation de livraison réelle par WhatsApp Server
client.on('message_ack', (msg, ack) => {
    const id      = msg.id._serialized;
    const ackName = ACK_NAMES[ack] ?? String(ack);
    console.log(`[ACK] ${ackName.padEnd(7)} ack=${ack}  msgId=${id}`);

    const pending = pendingAcks.get(id);
    if (pending) {
        pending.resolve({ ack, ackName });
    }

    // Notifier PHP quand le message est lu (ACK ≥ 3 = READ)
    if (ack >= 3) {
        const ackUrl = PHP_WEBHOOK.replace('/webhook/whatsapp', '/webhook/message-ack');
        axios.post(ackUrl, {
            whatsapp_message_id: id,
            ack_level:           ack,
            secret:              SECRET,
        }, { timeout: 5000 }).catch(e => {
            console.warn('[message_ack] webhook PHP échoué:', e.message);
        });
    }
});

// Messages entrants → webhook PHP
client.on('message', async (msg) => {
    if (msg.fromMe) return;

    const from = msg.from ?? '';

    // Filtrer canaux, broadcasts et groupes (unidirectionnel ou non géré)
    if (!from
        || from.endsWith('@broadcast')
        || from.endsWith('@newsletter')
        || from.endsWith('@g.us')
        || isChannelId(from)
    ) {
        console.log(`⏭️  Message ignoré (${from.split('@')[1] ?? 'inconnu'}): ${from}`);
        return;
    }

    // ── Résolution du contact ─────────────────────────────────────────────
    // Les IDs @lid ne sont PAS des numéros de téléphone : contact.number donne le vrai numéro.
    // Chaîne de fallback : on strip le suffixe @xxx si getContact() échoue.
    let contactNumber = null; // vrai numéro téléphone — null si @lid sans résolution
    let pushname      = msg.pushname || msg._data?.notifyName || '';

    try {
        const contact = await msg.getContact();
        if (contact.number) contactNumber = contact.number;
        pushname = contact.pushname || contact.name || contact.shortName || pushname;
        console.log(`[contact] ${from} → number=${contactNumber ?? 'null'}  name="${pushname}"`);
    } catch (e) {
        if (!isContextError(e?.message || String(e))) {
            console.warn(`[message] getContact() failed for ${from}: ${e?.message}`);
        }
    }

    const payload = {
        whatsapp_jid:    from,           // JID complet pour le routage (@c.us ou @lid)
        whatsapp_number: contactNumber,  // vrai numéro, null si @lid non résolu
        body:      msg.body,
        type:      msg.type,
        messageId: msg.id.id,
        timestamp: msg.timestamp,
        pushname,
        secret:    SECRET,
    };

    try {
        const res = await axios.post(PHP_WEBHOOK, payload, { timeout: 10000 });
        console.log(`✅ Webhook OK — HTTP ${res.status}  from=${payload.from}`);
    } catch (e) {
        const status  = e.response?.status ?? 'no response';
        const resStr  = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : '(aucune réponse)';
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('❌ Webhook error');
        console.error(`   URL     : ${PHP_WEBHOOK}`);
        console.error(`   Status  : ${status}${e.code ? ` (${e.code})` : ''}`);
        console.error(`   Message : ${e.message}`);
        console.error(`   Réponse : ${resStr}`);
        console.error(`   Payload : from=${payload.from}, type=${payload.type}`);
        console.error(e.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }
});

// ── Gestionnaires d'erreurs process ───────────────────────────────────────
// En Node.js v15+, une promesse rejetée non gérée tue le process par défaut.
// Ces handlers empêchent le crash et planifient une réinit si nécessaire.

const CONTEXT_ERRORS = [
    'Execution context was destroyed',
    'Session closed',
    'Target closed',
    'Protocol error',
    'Connection closed',
    'Page crashed',
];

function isContextError(msg) {
    return CONTEXT_ERRORS.some(e => msg.includes(e));
}

process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (isContextError(msg)) {
        console.warn(`⚠️  [UnhandledRejection] Contexte Puppeteer perdu: ${msg}`);
        console.warn('♻️  Réinitialisation dans 5s...');
        scheduleReinit(5000);
        return;
    }
    // Autres rejections : log sans crash
    console.error('⚠️  [UnhandledRejection]', msg);
    if (reason?.stack) console.error(reason.stack);
});

process.on('uncaughtException', (err) => {
    const msg = err?.message || String(err);
    if (isContextError(msg)) {
        console.warn(`⚠️  [UncaughtException] Contexte Puppeteer perdu: ${msg}`);
        console.warn('♻️  Réinitialisation dans 5s...');
        scheduleReinit(5000);
        return;
    }
    // Erreur fatale réelle → log complet + exit propre
    console.error('💥 [UncaughtException] Erreur fatale:', msg);
    console.error(err.stack);
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM reçu — arrêt propre du bridge');
    _cleanup();
    process.exit(0);
});

// ── Démarrage ─────────────────────────────────────────────────────────────
async function initClient() {
    try {
        await client.initialize();
    } catch (e) {
        const msg = e?.message || String(e);
        console.error('Init error:', msg);
        if (msg.includes('browser is already running')) {
            // Previous Chrome not cleaned up — delete lock file and retry
            const lockFile = path.join(__dirname, '.wwebjs_auth', 'session', 'SingletonLock');
            try { fs.unlinkSync(lockFile); console.log('🔑 Verrou singleton supprimé — nouvelle tentative...'); } catch {}
            await new Promise(r => setTimeout(r, 2000));
            client.initialize().catch(e2 => console.error('Init retry error:', e2.message));
        }
    }
}
initClient();

// ── API Endpoints ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, phone: clientPhone });
});

app.get('/qr', (req, res) => {
    if (isConnected) return res.json({ connected: true });
    res.json({ connected: false, qr: currentQR });
});

// Diagnostic complet de l'état du client
app.get('/debug', async (req, res) => {
    let liveState = null;
    try { liveState = await client.getState(); } catch (e) { liveState = `erreur: ${e.message}`; }

    res.json({
        isConnected,
        clientPhone,
        waState,
        liveState,
        pendingAcks:  pendingAcks.size,
        lidCacheSize: lidCache.size,
        lidCacheEntries: [...lidCache.entries()].map(([k, v]) => ({
            phone: k,
            chatId: v.chatId,
            ageMin: Math.round((Date.now() - v.ts) / 60000),
        })),
        ts: new Date().toISOString(),
    });
});

app.post('/send', async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'to and message required' });
    }

    // ── 1. Vérifier l'état réel du client ─────────────────────────────────
    if (!isConnected) {
        console.error(`❌ /send — WhatsApp non connecté  to=${to}  waState=${waState}`);
        return res.status(503).json({ success: false, error: `WhatsApp non connecté (état: ${waState})` });
    }

    let liveState;
    try {
        liveState = await client.getState();
    } catch (e) {
        liveState = 'UNKNOWN';
    }

    if (liveState !== 'CONNECTED') {
        console.error(`❌ /send — État client invalide: ${liveState}  to=${to}`);
        return res.status(503).json({
            success: false,
            error:   `Session WhatsApp invalide (état réel: ${liveState}) — relancez le bridge`,
        });
    }

    // ── 2. Résoudre le vrai identifiant WhatsApp ───────────────────────────
    let chatId;
    try {
        chatId = await resolveWhatsAppId(to);
    } catch (e) {
        console.error(`❌ /send — getNumberId exception  to=${to}: ${e.message}`);
        return res.status(500).json({ success: false, error: `Erreur résolution ID: ${e.message}` });
    }

    if (!chatId) {
        console.warn(`⚠️  /send — numéro ${to} introuvable sur WhatsApp`);
        return res.status(404).json({ success: false, error: `Numéro ${to} non enregistré sur WhatsApp` });
    }

    // ── 3. Détecter les canaux (envoi impossible) ─────────────────────────
    if (isChannelId(chatId)) {
        console.warn(`⚠️  /send — destination est un canal WhatsApp (unidirectionnel)  chatId=${chatId}`);
        return res.status(422).json({
            success: false,
            error:   `Impossible d'envoyer à un canal WhatsApp (${chatId}) — communication unidirectionnelle`,
        });
    }

    // ── 4. Envoi + attente de confirmation ACK WhatsApp Server ─────────────
    console.log(`📤 /send  to=${to}  chatId=${chatId}  msg="${String(message).slice(0, 100)}"`);

    let sentMsg;
    try {
        sentMsg = await client.sendMessage(chatId, message);
    } catch (e) {
        lidCache.delete(to); // invalider le cache — l'ID résolu est peut-être périmé
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error(`❌ /send FAILED  to=${to}  chatId=${chatId}`);
        console.error(`   error : ${e.message}`);
        console.error(e.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return res.status(500).json({ success: false, error: e.message });
    }

    const msgId = sentMsg?.id?._serialized;
    console.log(`📨 Message mis en file  msgId=${msgId}  — attente ACK serveur WhatsApp…`);

    // Attendre la confirmation du serveur WhatsApp (max 8s)
    const ackResult = await waitForAck(msgId, 8000);

    if (ackResult.ack >= 1) {
        // ≥ SERVER : WhatsApp a bien reçu le message
        console.log(`✅ /send CONFIRMED  to=${to}  msgId=${msgId}  ack=${ackResult.ackName}`);
        res.json({ success: true, chatId, messageId: msgId, ack: ackResult.ackName });
    } else {
        // TIMEOUT ou ERROR : le message n'a pas été confirmé par les serveurs WhatsApp
        console.error(`❌ /send UNCONFIRMED  to=${to}  msgId=${msgId}  ack=${ackResult.ackName}`);
        console.error(`   Causes possibles :`);
        console.error(`   - Session WhatsApp Web déconnectée côté téléphone`);
        console.error(`   - Numéro inexistant ou bloqué`);
        console.error(`   - Restriction WhatsApp Business API`);
        res.status(502).json({
            success:   false,
            error:     `Message non confirmé par WhatsApp (${ackResult.ackName})`,
            messageId: msgId,
            chatId,
        });
    }
});

// ── Helper partagé : vérification connexion + résolution chatId ───────────
async function resolveChat(to, res, route) {
    if (!isConnected) {
        res.status(503).json({ success: false, error: `WhatsApp non connecté (état: ${waState})` });
        return null;
    }
    let liveState;
    try { liveState = await client.getState(); } catch { liveState = 'UNKNOWN'; }
    if (liveState !== 'CONNECTED') {
        res.status(503).json({ success: false, error: `Session WhatsApp invalide (${liveState})` });
        return null;
    }
    let chatId;
    try { chatId = await resolveWhatsAppId(to); } catch (e) {
        res.status(500).json({ success: false, error: `Erreur résolution ID: ${e.message}` });
        return null;
    }
    if (!chatId) {
        res.status(404).json({ success: false, error: `Numéro ${to} non enregistré sur WhatsApp` });
        return null;
    }
    if (isChannelId(chatId)) {
        res.status(422).json({ success: false, error: `Impossible d'envoyer à un canal WhatsApp` });
        return null;
    }
    return chatId;
}

app.post('/send-media', async (req, res) => {
    const { to, base64, mimetype, filename, caption = '', asVoice = false } = req.body;

    if (!to || !base64 || !mimetype) {
        return res.status(400).json({ success: false, error: 'to, base64 and mimetype required' });
    }

    const chatId = await resolveChat(to, res, '/send-media');
    if (!chatId) return;

    console.log(`📤 /send-media  to=${to}  chatId=${chatId}  mime=${mimetype}  asVoice=${asVoice}`);

    let sentMsg;
    try {
        const media   = new MessageMedia(mimetype, base64, filename || 'file');
        const options = { caption };
        if (asVoice) options.sendAudioAsVoice = true;
        sentMsg = await client.sendMessage(chatId, media, options);
    } catch (e) {
        lidCache.delete(to);
        console.error(`❌ /send-media FAILED  to=${to}: ${e.message}`);
        return res.status(500).json({ success: false, error: e.message });
    }

    const msgId     = sentMsg?.id?._serialized;
    const ackResult = await waitForAck(msgId, 10000);

    if (ackResult.ack >= 1) {
        console.log(`✅ /send-media CONFIRMED  to=${to}  msgId=${msgId}  ack=${ackResult.ackName}`);
        res.json({ success: true, chatId, messageId: msgId, ack: ackResult.ackName });
    } else {
        console.error(`❌ /send-media UNCONFIRMED  to=${to}  ack=${ackResult.ackName}`);
        res.status(502).json({ success: false, error: `Média non confirmé (${ackResult.ackName})`, messageId: msgId, chatId });
    }
});

// ── Arrêt gracieux ────────────────────────────────────────────────────────
app.post('/shutdown', (req, res) => {
    res.json({ ok: true });
    console.log('🛑 Arrêt gracieux demandé...');
    const doExit = () => { _cleanup(); process.exit(0); };
    // Always destroy to close Chrome, whether connected or still initializing
    client.destroy().then(doExit).catch(doExit);
});

app.listen(PORT, () => console.log(`🌉 Bridge WhatsApp sur http://localhost:${PORT}`));
