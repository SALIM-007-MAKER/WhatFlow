// Apply saved dark mode immediately to avoid flash-of-white
(function () {
    if (localStorage.getItem('theme') === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();

// ── Debounce ──────────────────────────────────────────────────────────────
function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── State ─────────────────────────────────────────────────────────────────
const State = {
    user:             null,
    conversations:    [],
    currentConvId:    null,
    messages:         [],
    agents:           [],
    unreadCount:      0,
    notifCount:       0,
    currentFilter:    'all',
    sse:              null,
    // Conversation pagination
    convPage:         1,
    convTotal:        0,
    // Message cursor-based infinite scroll
    msgOldestId:      null,
    msgTotal:         0,
    msgLoading:       false,
    // Contacts pagination
    contactPage:      1,
    contactTotal:     0,
    // New-message banner (received while scrolled up)
    newMsgCount:      0,
    // Focus mode: suppress non-assigned conv notifications
    focusMode:        false,
    // Conversation tabs (multi-tasking)
    openTabs:         [],
    // Bulk selection
    selectedConvIds:  new Set(),
};

// Debounced search handlers (defined after State so closures reference it)
const debouncedConvSearch    = debounce(() => loadConversations(State.currentFilter), 300);
const debouncedContactSearch = debounce((q) => loadContacts(q), 300);

// Tracks IDs of messages already rendered — prevents SSE + optimistic duplicates
const renderedMsgIds = new Set();

// Last rendered message — used for grouping and date separators on new appends
let _lastRenderedMsg = null;

// ── Status config ─────────────────────────────────────────────────────────
const STATUS_MAP = {
    available: { label: 'Disponible', dot: 'bg-green-400' },
    busy:      { label: 'Occupé',     dot: 'bg-yellow-400' },
    inactive:  { label: 'Inactif',    dot: 'bg-gray-400' },
    offline:   { label: 'Hors ligne', dot: 'bg-gray-600' },
};

// ── Sidebar dynamique par rôle ────────────────────────────────────────────
// Chaque section filtrée par section.roles ; chaque item filtré par item.roles.
// Une section sans items visibles est supprimée du rendu.
const NAV_SECTIONS = [
    {
        label: 'Principal',
        collapsible: false,
        roles: ['agent', 'admin', 'super_admin'],
        items: [
            { id: 'conversations',    icon: '<i class="fa-solid fa-comments fa-fw"></i>',   label: 'Conversations', badge: 'unread-badge', roles: ['agent','admin','super_admin'] },
            { id: 'contacts',         icon: '<i class="fa-solid fa-users fa-fw"></i>',       label: 'Contacts',                             roles: ['agent','admin','super_admin'] },
            { id: 'canned-responses', icon: '<i class="fa-solid fa-reply-all fa-fw"></i>',  label: 'Templates',                            roles: ['agent','admin','super_admin'] },
            { id: 'notifications',    icon: '<i class="fa-solid fa-bell fa-fw"></i>',        label: 'Notifications', badge: 'notif-badge',  roles: ['agent','admin','super_admin'] },
        ],
    },
    {
        label: 'Gestion',
        collapsible: true,
        roles: ['admin', 'super_admin'],
        items: [
            { id: 'agents',    icon: '<i class="fa-solid fa-user-tie fa-fw"></i>',  label: 'Agents',    roles: ['admin','super_admin'] },
            { id: 'analytics', icon: '<i class="fa-solid fa-chart-bar fa-fw"></i>', label: 'Analytics', roles: ['admin','super_admin'] },
        ],
    },
    {
        label: 'Configuration',
        collapsible: true,
        defaultCollapsed: true,
        roles: ['admin', 'super_admin'],
        items: [
            { id: 'settings',   icon: '<i class="fa-solid fa-gear fa-fw"></i>',            label: 'Paramètres', roles: ['admin','super_admin'] },
            { id: 'bridge',     icon: '<i class="fa-solid fa-network-wired fa-fw"></i>',   label: 'Bridge',     roles: ['admin','super_admin'] },
            { id: 'ai-config',  icon: '<i class="fa-solid fa-robot fa-fw"></i>',           label: 'Config. IA', roles: ['super_admin'] },
            { id: 'audit-logs', icon: '<i class="fa-solid fa-shield-halved fa-fw"></i>',   label: 'Logs audit', roles: ['super_admin'] },
        ],
    },
];

// ── Sounds (Web Audio API — no external deps) ─────────────────────────────
const Sounds = (() => {
    let _ctx = null;
    function _ctx_get() {
        if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
        return _ctx;
    }
    function _beep(freq, dur, vol = 0.18, type = 'sine') {
        try {
            const ctx = _ctx_get();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(vol, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + dur);
        } catch {}
    }
    return {
        newMessage()      { _beep(880, 0.12, 0.15); setTimeout(() => _beep(1100, 0.1, 0.1), 80); },
        newConversation() { _beep(660, 0.1, 0.13); setTimeout(() => _beep(880, 0.1, 0.13), 90); setTimeout(() => _beep(1100, 0.12, 0.1), 180); },
        alert()           { _beep(440, 0.15, 0.2, 'sawtooth'); },
    };
})();

// ── Desktop notifications ──────────────────────────────────────────────────
const Notifs = (() => {
    const supported = 'Notification' in window;

    function _tabActive() {
        return document.visibilityState === 'visible' && document.hasFocus();
    }

    function _show(title, body, convId) {
        if (!supported || Notification.permission !== 'granted') return;
        if (_tabActive()) return; // user already sees the app

        const n = new Notification(title, {
            body,
            icon: '/WhatFlow/frontend/assets/icon-192.png',
            tag:  convId ? `conv-${convId}` : undefined, // dedupe same conv
            renotify: true,
        });
        if (convId) {
            n.onclick = () => {
                window.focus();
                openConversation(convId);
                n.close();
            };
        }
    }

    return {
        async request() {
            if (!supported || Notification.permission !== 'default') return;
            await Notification.requestPermission();
        },
        newMessage(senderName, preview, convId) {
            _show(`💬 ${senderName}`, preview ? String(preview).slice(0, 80) : '', convId);
        },
        newConversation(contactName, convId) {
            _show('🆕 Nouvelle conversation', contactName || '', convId);
        },
    };
})();

// ── Badge pop animation ────────────────────────────────────────────────────
function _pulseBadge(el) {
    if (!el || el.classList.contains('hidden')) return;
    el.classList.remove('badge-pop');
    void el.offsetWidth; // force reflow
    el.classList.add('badge-pop');
    el.addEventListener('animationend', () => el.classList.remove('badge-pop'), { once: true });
}

// ── SSE connection indicator ───────────────────────────────────────────────
function updateSSEDot() {
    const dot = document.getElementById('sse-status-dot');
    if (!dot) return;
    const rs = State.sse?.es?.readyState;
    dot.className = 'sse-dot w-2 h-2 rounded-full flex-shrink-0 ' +
        (rs === 1 ? 'sse-ok' : rs === 0 ? 'sse-wait' : 'sse-fail');
}

// ── Sidebar collapse ──────────────────────────────────────────────────────
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const collapsed = sidebar.classList.toggle('sidebar-collapsed');
    localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0');
    const icon = sidebar.querySelector('[onclick="toggleSidebar()"] i');
    if (icon) {
        icon.className = collapsed
            ? 'fa-solid fa-angles-right text-[10px] text-slate-400'
            : 'fa-solid fa-angles-left text-[10px] text-slate-400';
    }
}

// ── Focus mode ────────────────────────────────────────────────────────────
function toggleFocusMode() {
    State.focusMode = !State.focusMode;
    const btn = document.getElementById('focus-mode-btn');
    if (btn) {
        const icon  = btn.querySelector('i');
        const label = btn.querySelector('span');
        if (icon)  icon.className   = State.focusMode
            ? 'fa-solid fa-eye fa-fw w-4 text-center text-[#25D366] flex-shrink-0'
            : 'fa-solid fa-eye-slash fa-fw w-4 text-center text-slate-400 flex-shrink-0';
        if (label) label.textContent = State.focusMode ? 'Focus actif' : 'Mode focus';
    }
    showToast(
        State.focusMode ? 'Mode focus activé' : 'Mode focus désactivé',
        State.focusMode ? "Seules vos conversations s'affichent" : 'Toutes les notifications actives',
        'info'
    );
}

// ── Dark mode ─────────────────────────────────────────────────────────────
function initDarkMode() {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') _applyDarkMode(true, false);
}

function toggleDarkMode() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    _applyDarkMode(!isDark, true);
}

function _applyDarkMode(dark, save) {
    const html  = document.documentElement;
    const icon  = document.getElementById('dark-mode-icon');
    const label = document.getElementById('dark-mode-label');

    if (dark) {
        html.setAttribute('data-theme', 'dark');
        if (icon)  icon.className  = 'fa-solid fa-sun fa-fw w-4 text-center text-slate-400 flex-shrink-0';
        if (label) label.textContent = 'Mode clair';
    } else {
        html.removeAttribute('data-theme');
        if (icon)  icon.className  = 'fa-solid fa-moon fa-fw w-4 text-center text-slate-400 flex-shrink-0';
        if (label) label.textContent = 'Mode sombre';
    }
    if (save) localStorage.setItem('theme', dark ? 'dark' : 'light');
}

// ── Mobile navigation ─────────────────────────────────────────────────────
function openMobileSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('mobile-overlay');
    if (sidebar)  sidebar.classList.add('mobile-open');
    if (overlay) overlay.classList.add('active');
}

function closeMobileSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const overlay  = document.getElementById('mobile-overlay');
    if (sidebar)  sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('active');
}

function mobileGoBack() {
    const chatArea = document.getElementById('chat-area');
    if (chatArea) chatArea.classList.remove('mobile-open');
}

function mobileOpenChat() {
    if (window.innerWidth >= 768) return;
    const chatArea = document.getElementById('chat-area');
    if (chatArea) chatArea.classList.add('mobile-open');
}

// ── Auth Guard ────────────────────────────────────────────────────────────
async function bootstrap() {
    const token = localStorage.getItem('token');
    if (!token) return showPage('login');

    try {
        State.user = await API.get('/api/auth/me');
        initApp();
    } catch {
        localStorage.clear();
        showPage('login');
    }
}

function setupGlobalDragDrop() {
    const area    = document.getElementById('chat-area');
    const overlay = document.getElementById('drag-overlay');
    if (!area || !overlay) return;

    let depth = 0;

    area.addEventListener('dragenter', e => {
        if (!State.currentConvId) return;
        e.preventDefault();
        depth++;
        if (depth === 1) overlay.classList.add('active');
    });
    area.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) overlay.classList.remove('active');
    });
    area.addEventListener('dragover', e => {
        if (!State.currentConvId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    area.addEventListener('drop', e => {
        e.preventDefault();
        depth = 0;
        overlay.classList.remove('active');
        if (!State.currentConvId) return;
        const file = e.dataTransfer.files[0];
        if (file) handleFileSelect(file);
    });
}

function initApp() {
    showPage('app');
    renderUserInfo();
    buildSidebarNav(State.user.role);

    // Hide admin-only settings cards for non-admins
    if (!['super_admin', 'admin'].includes(State.user?.role)) {
        document.getElementById('webhooks-settings-card')?.classList.add('hidden');
    }
    loadConversations();
    loadAgents();
    setupSSE();
    setupGlobalDragDrop();

    // Restore sidebar collapsed state
    const sidebar = document.getElementById('sidebar');
    if (sidebar && localStorage.getItem('sidebar_collapsed') === '1') {
        sidebar.classList.add('sidebar-collapsed');
        const icon = sidebar.querySelector('[onclick="toggleSidebar()"] i');
        if (icon) icon.className = 'fa-solid fa-angles-right text-[10px] text-slate-400';
    }

    // SSE status dot — poll every 2s
    setInterval(updateSSEDot, 2000);
    updateSSEDot();

    // SLA badges — recalculate every minute so colours update without reload
    setInterval(renderConversationList, 60000);

    // Keyboard shortcuts
    setupKeyboardShortcuts();

    // Typing indicators
    setupTypingIndicator();

    // Dark mode — sync button state with current setting
    initDarkMode();

    // Desktop notifications — ask permission once after login
    Notifs.request();

    // Canned responses trigger + warm cache
    setupCannedTrigger();
    API.get('/api/canned-responses').then(data => { _cannedCache = data || []; }).catch(() => {});

    window.addEventListener('beforeunload', () => {
        if (State.sse?.es) State.sse.es.close();
        if (_previewObjectUrl) URL.revokeObjectURL(_previewObjectUrl);
        if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
        document.querySelectorAll('audio').forEach(a => a.pause());
    });
    // Close status dropdown on outside click
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('status-dropdown');
        if (dd && !dd.classList.contains('hidden') &&
            !e.target.closest('#status-dropdown') &&
            !e.target.closest('[onclick*="toggleStatusDropdown"]')) {
            dd.classList.add('hidden');
        }
    });
}

let _refreshTimer = null;
function scheduleTokenRefresh() {
    clearTimeout(_refreshTimer);
    const exp = API._tokenExp();
    if (!exp) return;
    // Refresh 3 minutes before expiry (or immediately if already close/past)
    const msUntilRefresh = Math.max(0, (exp - 180) * 1000 - Date.now());
    _refreshTimer = setTimeout(async () => {
        const ok = await API._doRefresh();
        if (ok) {
            scheduleTokenRefresh(); // reschedule for the new token
        } else {
            logout();
        }
    }, msUntilRefresh);
}

function buildSidebarNav(role) {
    const nav = document.getElementById('sidebar-nav');
    if (!nav) return;

    const collapsed = JSON.parse(localStorage.getItem('sb-collapsed') || '[]');

    let html = '';
    NAV_SECTIONS.forEach(section => {
        if (!section.roles.includes(role)) return;

        const visibleItems = section.items.filter(item => item.roles.includes(role));
        if (!visibleItems.length) return;

        // If user has explicitly toggled, use their preference; otherwise use defaultCollapsed
        const userToggled    = collapsed.includes(section.label) || collapsed.includes('open:' + section.label);
        const startCollapsed = section.collapsible && (
            userToggled ? collapsed.includes(section.label) : !!section.defaultCollapsed
        );

        if (section.collapsible) {
            html += `<button onclick="_toggleSbSection('${section.label}', this)"
                class="sb-section-toggle w-full flex items-center justify-between px-3 pt-4 pb-1 group">
                <span class="sb-text text-[10px] font-semibold text-slate-500 uppercase tracking-widest">${section.label}</span>
                <i class="fa-solid fa-chevron-down text-[9px] text-slate-600 group-hover:text-slate-400 transition-transform duration-200 ${startCollapsed ? '-rotate-90' : ''}"></i>
            </button>`;
        } else {
            html += `<div class="sb-text px-3 pt-4 pb-1 text-[10px] font-semibold text-slate-500 uppercase tracking-widest select-none">${section.label}</div>`;
        }

        html += `<div class="sb-section-items overflow-hidden transition-all duration-200" data-section="${section.label}" style="${startCollapsed ? 'max-height:0;opacity:0' : 'max-height:500px;opacity:1'}">`;
        visibleItems.forEach(item => {
            const isActive = item.id === 'conversations';
            html += `<button data-nav="${item.id}"
                class="nav-btn w-full flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm${isActive ? ' nav-active text-[#25D366]' : ''}">
                <span class="text-base flex-shrink-0 leading-none w-5 text-center">${item.icon}</span>
                <span class="sb-text flex-1 text-left font-medium">${item.label}</span>
                ${item.badge ? `<span id="${item.badge}" class="sb-badge hidden bg-red-500 text-white text-[10px] rounded-full min-w-[1.1rem] h-[1.1rem] flex items-center justify-center px-0.5 font-bold">0</span>` : ''}
            </button>`;
        });
        html += `</div>`;
    });

    nav.innerHTML = html;
    setupNavigation();
}

function _toggleSbSection(label, btn) {
    const container = document.querySelector(`.sb-section-items[data-section="${label}"]`);
    if (!container) return;

    const isCollapsed = container.style.maxHeight === '0px' || container.style.opacity === '0';
    const chevron     = btn?.querySelector('i');

    if (isCollapsed) {
        container.style.maxHeight = '500px';
        container.style.opacity   = '1';
        if (chevron) chevron.classList.remove('-rotate-90');
        _setSbCollapsed(label, false);
    } else {
        container.style.maxHeight = '0px';
        container.style.opacity   = '0';
        if (chevron) chevron.classList.add('-rotate-90');
        _setSbCollapsed(label, true);
    }
}

function _setSbCollapsed(label, isCollapsed) {
    const list     = JSON.parse(localStorage.getItem('sb-collapsed') || '[]');
    const closeKey = label;
    const openKey  = 'open:' + label;
    // Remove both keys then set the right one
    const clean = list.filter(k => k !== closeKey && k !== openKey);
    clean.push(isCollapsed ? closeKey : openKey);
    localStorage.setItem('sb-collapsed', JSON.stringify(clean));
}

// ── SSE Setup ─────────────────────────────────────────────────────────────
function setupSSE() {
    const token = localStorage.getItem('token');
    State.sse   = new SSEClient(token);

    State.sse
        .on('conversation:new', (data) => {
            State.conversations.unshift(data);
            State.convTotal++;
            renderConversationList();
            State.unreadCount++;
            updateUnreadBadge();
            State.notifCount++;
            updateNotifBadge();
            if (!State.focusMode) {
                const contactName = data.effective_name || data.custom_name || data.display_name || data.whatsapp_number || data.whatsapp_jid?.split('@')[0] || '?';
                Sounds.newConversation();
                showToast('Nouvelle conversation', contactName, 'info');
                Notifs.newConversation(contactName, data.id);
            }
        })
        .on('conversation:updated', (data) => {
            const idx = State.conversations.findIndex(c => c.id === data.id);
            if (idx !== -1) {
                State.conversations[idx] = { ...State.conversations[idx], ...data };
                renderConversationList();
                if (data.id === State.currentConvId) {
                    renderChatHeader(State.conversations[idx]);
                    renderAIContextBar(State.conversations[idx]);
                }
            }
            // Sync tab name if tags/name changed
            const tab = State.openTabs.find(t => t.id === data.id);
            if (tab && data.effective_name) tab.name = data.effective_name;
            renderConvTabs();

            // SLA escalation toast
            if (data.sla_escalated && data.priority) {
                const PRIO_LABEL = { high: 'Haute', urgent: 'Urgente' };
                const label = PRIO_LABEL[data.priority] || data.priority;
                showToast(`SLA — Priorité ${label}`, `Conversation #${data.id} escaladée automatiquement`, 'warning');
            }
        })
        .on('message:new', (data) => {
            // Update conversation list: move to top, update last message preview
            const idx = State.conversations.findIndex(c => c.id === data.conversation_id);
            if (idx !== -1) {
                State.conversations[idx].last_message    = data.content;
                State.conversations[idx].last_message_at = data.sent_at;
                State.conversations[idx].last_msg_sender  = data.sender_type;
                if (data.conversation_id !== State.currentConvId) {
                    State.conversations[idx].unread = (State.conversations[idx].unread || 0) + 1;
                }
                const [conv] = State.conversations.splice(idx, 1);
                State.conversations.unshift(conv);
                renderConversationList();
            }

            if (data.conversation_id === State.currentConvId) {
                appendMessage(data); // smart scroll handled inside appendMessage
                if (data.sender_type === 'contact') Sounds.newMessage();
            } else {
                State.notifCount++;
                updateNotifBadge();
                // Focus mode: only notify for conversations assigned to current user
                const conv = State.conversations.find(c => c.id === data.conversation_id);
                const isAssignedToMe = conv?.assigned_agent_id === State.user?.id;
                if (!State.focusMode || isAssignedToMe) {
                    Sounds.newMessage();
                    const sender  = data.contact?.display_name || data.contact?.whatsapp_number
                        || conv?.effective_name || 'Client';
                    const preview = String(data.content || '').slice(0, 60);
                    showToast('Nouveau message', `${sender} : ${preview}`, 'info');
                    Notifs.newMessage(sender, preview, data.conversation_id);
                }
            }
        })
        .on('agent:status', (data) => {
            const idx = State.agents.findIndex(a => a.id === data.id);
            if (idx !== -1) State.agents[idx].status = data.status;
        })
        .on('contact:renamed', (data) => {
            State.conversations.forEach(c => {
                if (c.contact_id === data.contact_id) {
                    c.custom_name   = data.custom_name;
                    c.effective_name = data.custom_name;
                }
            });
            renderConversationList();
            const cur = State.conversations.find(c => c.id === State.currentConvId);
            if (cur?.contact_id === data.contact_id) renderChatHeader(cur);
        })
        .on('message:status', (data) => {
            const msg = State.messages.find(m => m.id === data.id);
            if (msg) {
                msg.status = data.status;
                if (data.conversation_id === State.currentConvId) {
                    const el = document.querySelector(`[data-msg-id="${data.id}"]`);
                    if (el) {
                        const wrapper = document.createElement('div');
                        wrapper.innerHTML = buildMessageHTML(msg);
                        const newEl = wrapper.firstElementChild;
                        if (newEl) el.replaceWith(newEl);
                    }
                }
            }
        })
        .on('notification:admin', (data) => {
            if (['super_admin', 'admin'].includes(State.user?.role)) {
                State.notifCount++;
                updateNotifBadge();
                showToast('Alerte', data.message, 'warning');
            }
        })
        .on('agent:typing', (data) => {
            _handleTypingEvent(data);
        });
}

// ── Pages ─────────────────────────────────────────────────────────────────
function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    const page = document.getElementById(`page-${name}`);
    if (page) page.classList.remove('hidden');
}

function setupNavigation() {
    document.querySelectorAll('[data-nav]').forEach(el => {
        el.addEventListener('click', () => {
            const target = el.dataset.nav;
            document.querySelectorAll('[data-nav]').forEach(x => x.classList.remove('nav-active'));
            el.classList.add('nav-active');
            closeMobileSidebar();

            switch (target) {
                case 'conversations':  showMainView('chat'); break;
                case 'contacts':       showMainView('contacts'); loadContacts(); break;
                case 'agents':         showMainView('agents'); loadAgentsView(); break;
                case 'settings':       showMainView('settings'); loadSettings(); break;
                case 'analytics':      showMainView('analytics'); loadAnalytics(); break;
                case 'notifications':  showMainView('notifications'); loadNotifications(); break;
                case 'audit-logs':     showMainView('audit-logs'); loadAuditLogs(); break;
                case 'ai-config':      showMainView('ai-config'); loadAIConfig(); break;
                case 'bridge':            showMainView('bridge'); initBridgePanel(); break;
                case 'canned-responses':  showMainView('canned-responses'); loadCannedResponses(); break;
            }
        });
    });
}

function showMainView(name) {
    if (name !== 'bridge') _stopBridgeAutoRefresh();
    document.querySelectorAll('.main-view').forEach(v => v.classList.add('hidden'));
    const v = document.getElementById(`view-${name}`);
    if (v) v.classList.remove('hidden');
}

const ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', agent: 'Agent' };

function renderUserInfo() {
    const u    = State.user;
    const role = ROLE_LABELS[u.role] || u.role;
    document.getElementById('user-name').textContent   = u.name;
    document.getElementById('user-avatar').textContent = u.name[0].toUpperCase();
    const roleEl = document.getElementById('user-role');
    if (roleEl) { roleEl.textContent = '· ' + role; roleEl.classList.remove('hidden'); }
    updateStatusUI(u.status || 'offline');
}

// ── Skeleton loaders ──────────────────────────────────────────────────────
function skeletonConvList(n = 7) {
    return Array(n).fill(0).map(() => `
        <div class="flex items-center px-4 py-3.5 gap-3 border-b border-gray-50">
            <div class="w-12 h-12 rounded-full skeleton flex-shrink-0"></div>
            <div class="flex-1 space-y-2">
                <div class="h-3 skeleton rounded-full" style="width:${55+Math.random()*30}%"></div>
                <div class="h-2.5 skeleton rounded-full" style="width:${30+Math.random()*30}%"></div>
            </div>
            <div class="h-2.5 skeleton rounded-full w-8 flex-shrink-0"></div>
        </div>`).join('');
}

function skeletonMessages(n = 9) {
    const widths = ['w-40','w-56','w-48','w-64','w-36','w-52','w-44','w-60','w-32'];
    return Array(n).fill(0).map((_, i) => {
        const isRight = [1,1,0,1,0,1,1,0,1][i % 9];
        return `<div class="flex ${isRight ? 'justify-end pr-5' : 'justify-start pl-5'} mb-1">
            <div class="${widths[i % widths.length]} h-9 skeleton rounded-2xl ${isRight ? 'rounded-tr-sm' : 'rounded-tl-sm'}"></div>
        </div>`;
    }).join('');
}

function skeletonContacts(n = 6) {
    return `<div class="grid gap-2.5">` +
        Array(n).fill(0).map(() => `
        <div class="bg-white rounded-xl px-4 py-3 border border-gray-100 flex items-center gap-3">
            <div class="w-10 h-10 rounded-full skeleton flex-shrink-0"></div>
            <div class="flex-1 space-y-2">
                <div class="h-3 skeleton rounded-full" style="width:${40+Math.random()*35}%"></div>
                <div class="h-2.5 skeleton rounded-full" style="width:${25+Math.random()*25}%"></div>
            </div>
        </div>`).join('') + `</div>`;
}

function skeletonAnalytics() {
    return `
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            ${Array(4).fill(0).map(() => `
                <div class="rounded-2xl p-5 border border-gray-100 bg-white shadow-sm space-y-3">
                    <div class="h-8 skeleton rounded-lg w-16"></div>
                    <div class="h-2.5 skeleton rounded-full w-28"></div>
                </div>`).join('')}
        </div>
        <div class="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm mb-6">
            <div class="h-3 skeleton rounded-full w-48 mb-5"></div>
            <div class="flex items-end gap-2" style="height:96px">
                ${Array(7).fill(0).map((_, i) => {
                    const h = [45,70,55,85,40,65,50][i];
                    return `<div class="flex-1 flex flex-col items-center gap-1">
                        <div class="h-2 skeleton rounded-full w-5"></div>
                        <div class="w-full skeleton rounded-t-sm" style="height:${h}%"></div>
                        <div class="h-2 skeleton rounded-full w-8"></div>
                    </div>`;
                }).join('')}
            </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
            ${Array(2).fill(0).map(() => `
                <div class="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm space-y-3">
                    <div class="h-3 skeleton rounded-full w-32 mb-4"></div>
                    ${Array(4).fill(0).map(() => `<div class="h-2.5 skeleton rounded-full" style="width:${50+Math.random()*40}%"></div>`).join('')}
                </div>`).join('')}
        </div>`;
}

// ── Smart scroll helpers ───────────────────────────────────────────────────
function _isAtBottom() {
    const c = document.getElementById('messages-container');
    return !c || (c.scrollHeight - c.scrollTop - c.clientHeight < 100);
}

function _updateNewMsgBanner() {
    const banner = document.getElementById('new-msg-banner');
    const label  = document.getElementById('new-msg-count-label');
    if (!banner) return;
    if (State.newMsgCount === 0) { banner.classList.add('hidden'); return; }
    const txt = State.newMsgCount === 1
        ? '1 nouveau message'
        : `${State.newMsgCount} nouveaux messages`;
    if (label) label.textContent = txt;
    banner.classList.remove('hidden');
}

function scrollToBottomAndClear() {
    State.newMsgCount = 0;
    _updateNewMsgBanner();
    const c = document.getElementById('messages-container');
    if (c) c.scrollTop = c.scrollHeight;
}

// ── Message grouping helpers ───────────────────────────────────────────────
function _isGrouped(msg, prev) {
    if (!prev || prev.type === 'note' || msg.type === 'note') return false;
    if (prev.sender_type !== msg.sender_type) return false;
    if (msg.sender_type === 'agent' && String(prev.sender_id) !== String(msg.sender_id)) return false;
    const a = new Date((prev.sent_at || '').replace(' ', 'T'));
    const b = new Date((msg.sent_at  || '').replace(' ', 'T'));
    const dt = b - a;
    return dt >= 0 && dt < 3 * 60 * 1000; // 3-minute grouping window
}

function _dayKey(ts) {
    return ts ? String(ts).slice(0, 10) : '';
}

function buildDateSeparator(ts) {
    const d   = new Date((ts || '').replace(' ', 'T'));
    if (isNaN(d)) return '';
    const now = new Date();
    const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay    = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays  = Math.round((today - msgDay) / 86400000);
    const label = diffDays === 0 ? "Aujourd'hui"
                : diffDays === 1 ? 'Hier'
                : d.toLocaleDateString('fr-FR', {
                    day: 'numeric', month: 'long',
                    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
                  });
    return `<div class="flex items-center gap-3 my-4 px-4 select-none">
        <div class="flex-1 h-px bg-[#E9EDEF]"></div>
        <span class="text-[11px] text-[#8696A0] font-medium px-3 py-1 bg-[#D9F5E5]/60 rounded-full whitespace-nowrap">${label}</span>
        <div class="flex-1 h-px bg-[#E9EDEF]"></div>
    </div>`;
}

// ── Conversations ─────────────────────────────────────────────────────────
async function loadConversations(filter = 'all', reset = true) {
    State.currentFilter = filter;
    if (reset) {
        State.convPage = 1;
        if (State.selectedConvIds.size) {
            State.selectedConvIds.clear();
            _updateBulkBar();
        }
    }

    // Update active filter button — each filter has its own color
    const FILTER_COLORS = {
        all:     'bg-[#25D366]',
        new:     'bg-[#3B82F6]',
        ongoing: 'bg-[#8B5CF6]',
        waiting: 'bg-[#F59E0B]',
        closed:  'bg-[#6B7280]',
    };
    document.querySelectorAll('.filter-btn').forEach(btn => {
        const active     = btn.dataset.filter === filter;
        const colorClass = FILTER_COLORS[btn.dataset.filter] || 'bg-[#25D366]';
        Object.values(FILTER_COLORS).forEach(c => btn.classList.remove(c));
        if (active) btn.classList.add(colorClass);
        btn.classList.toggle('text-white',     active);
        btn.classList.toggle('text-[#667781]', !active);
    });

    const search  = document.getElementById('conv-search')?.value.trim() || '';
    const perPage = 30;
    let path = `/api/conversations?per_page=${perPage}&page=${State.convPage}`;
    if (filter !== 'all') path += `&status=${filter}`;
    if (search)           path += `&search=${encodeURIComponent(search)}`;

    // Show skeleton only on fresh load (not load-more)
    if (reset) {
        const list = document.getElementById('conv-list');
        if (list) list.innerHTML = skeletonConvList();
    }

    try {
        const data = await API.get(path);
        if (reset) {
            State.conversations  = data.items;
            _focusedConvIndex    = -1;
        } else {
            // Append — avoid duplicates by id
            const existing = new Set(State.conversations.map(c => c.id));
            State.conversations.push(...data.items.filter(c => !existing.has(c.id)));
        }
        State.convTotal = data.total;
        renderConversationList();
        // Show "load more" if more pages exist
        const btn = document.getElementById('conv-load-more');
        if (btn) btn.classList.toggle('hidden', State.conversations.length >= State.convTotal);
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function loadMoreConversations() {
    State.convPage++;
    await loadConversations(State.currentFilter, false);
}

function waitingBadge(conv) {
    if (conv.status === 'closed') return '';
    if (conv.last_msg_sender !== 'contact') return '';
    if (!conv.last_message_at) return '';

    const diffMs  = Date.now() - new Date(conv.last_message_at).getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 5) return '';

    let label, cls;
    if (diffMin < 30) {
        label = diffMin + 'min';
        cls   = 'bg-amber-50 text-amber-600 border-amber-200';
    } else if (diffMin < 60) {
        label = diffMin + 'min';
        cls   = 'bg-orange-50 text-orange-600 border-orange-200';
    } else {
        const h = Math.floor(diffMin / 60);
        const m = diffMin % 60;
        label   = m > 0 ? `${h}h${m}` : `${h}h`;
        cls     = 'bg-red-50 text-red-600 border-red-200';
    }

    const pulse = diffMin >= 30
        ? `<span class="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1"></span>`
        : '';
    return `<span class="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${cls}">${pulse}${label}</span>`;
}

function renderConversationList() {
    const list = document.getElementById('conv-list');
    if (!list) return;

    const countEl = document.getElementById('conv-count');
    if (countEl) countEl.textContent = State.convTotal || State.conversations.length || '';

    if (!State.conversations.length) {
        list.innerHTML = `<div class="p-4 text-center text-gray-400 text-sm">Aucune conversation</div>`;
        return;
    }

    list.innerHTML = State.conversations.map(c => {
        const isActive    = c.id === State.currentConvId;
        const isUnnamed   = !c.custom_name && !c.display_name;
        const name        = c.effective_name || c.custom_name || c.display_name || c.whatsapp_number || c.whatsapp_jid?.split('@')[0] || 'Inconnu';
        const time        = formatTime(c.last_message_at);
        const avatarBg    = isUnnamed ? 'bg-[#DEB887]' : 'bg-[#DFE5E7]';
        const avatarColor = isUnnamed ? 'text-white' : 'text-[#54656F]';
        const avatarChar  = isUnnamed ? '?' : name[0].toUpperCase();
        const unread      = c.unread > 0;
        const lastMsg     = c.last_message
            ? escHtml(String(c.last_message).slice(0, 55))
            : `<span class="italic text-[#8696A0]">${c.status}</span>`;
        const tagPills    = renderTagPills(c.tags);
        const hasTags     = parseTags(c.tags).length > 0;
        const slaBadge    = waitingBadge(c);

        // Priority: dot color in time area
        const priorityDot = {
            urgent: 'text-red-500',
            high:   'text-orange-400',
            normal: '',
            low:    '',
        }[c.priority] || '';
        const prioIcon = c.priority === 'urgent'
            ? `<i class="fa-solid fa-circle-exclamation text-red-500 text-[10px] mr-0.5"></i>`
            : c.priority === 'high'
            ? `<i class="fa-solid fa-circle-up text-orange-400 text-[10px] mr-0.5"></i>`
            : '';

        // AI sentiment quick badge
        const aiIcon = c.ai_sentiment === 'negative' || c.ai_sentiment === 'urgent'
            ? `<span class="w-3.5 h-3.5 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0" title="Sentiment négatif"><i class="fa-regular fa-face-frown text-red-500" style="font-size:9px"></i></span>`
            : c.ai_sentiment === 'positive'
            ? `<span class="w-3.5 h-3.5 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0" title="Sentiment positif"><i class="fa-regular fa-face-smile text-green-500" style="font-size:9px"></i></span>`
            : '';

        const isSelected = State.selectedConvIds.has(c.id);
        return `
        <div class="wa-conv-item ${isActive ? 'active' : ''} ${isSelected ? 'is-selected' : ''}" data-id="${c.id}" data-priority="${c.priority || 'normal'}"
             onclick="handleConvItemClick(event, ${c.id})">
            <div class="priority-bar"></div>
            <div class="relative flex-shrink-0 mr-3">
                <div class="conv-check absolute inset-0 z-10 flex items-center justify-center rounded-full bg-white/80 cursor-pointer"
                     onclick="event.stopPropagation(); toggleConvSelection(${c.id})">
                    <input type="checkbox" class="w-4 h-4 accent-[#25D366] pointer-events-none" ${isSelected ? 'checked' : ''}>
                </div>
                <div class="w-12 h-12 rounded-full ${avatarBg} ${avatarColor} flex items-center justify-center text-xl font-semibold select-none">
                    ${avatarChar}
                </div>
                ${isUnnamed ? `<span class="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-amber-500 border-2 border-white flex items-center justify-center text-white text-[9px] font-bold leading-none">!</span>` : ''}
            </div>
            <div class="flex-1 min-w-0 overflow-hidden">
                <div class="flex items-baseline justify-between gap-2">
                    <span class="font-semibold text-[15px] truncate ${isUnnamed ? 'text-amber-600 italic' : 'text-[#111B21]'}">${escHtml(name)}</span>
                    <span class="flex items-center text-xs ${unread ? 'text-[#25D366] font-medium' : 'text-[#667781]'} flex-shrink-0 whitespace-nowrap">${prioIcon}${time}</span>
                </div>
                <div class="flex items-center justify-between gap-2 mt-0.5">
                    <span class="text-sm text-[#667781] truncate">${lastMsg}</span>
                    <div class="flex items-center gap-1 flex-shrink-0">
                        ${aiIcon}
                        ${slaBadge}
                        ${unread ? `<span class="min-w-[18px] h-[18px] px-1 rounded-full bg-[#25D366] text-white text-xs flex items-center justify-center font-semibold leading-none">${c.unread}</span>` : ''}
                    </div>
                </div>
                ${hasTags ? `<div class="flex items-center gap-1 mt-1 flex-wrap">${tagPills}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

// ── Bulk selection ─────────────────────────────────────────────────────────
function handleConvItemClick(event, id) {
    // Clicks on the checkbox overlay are handled by stopPropagation + toggleConvSelection directly
    openConversation(id);
}

function toggleConvSelection(id) {
    if (State.selectedConvIds.has(id)) {
        State.selectedConvIds.delete(id);
    } else {
        State.selectedConvIds.add(id);
    }
    renderConversationList();
    _updateBulkBar();
}

function clearBulkSelection() {
    State.selectedConvIds.clear();
    renderConversationList();
    _updateBulkBar();
}

function bulkSelectAll() {
    State.conversations.forEach(c => State.selectedConvIds.add(c.id));
    renderConversationList();
    _updateBulkBar();
}

function _updateBulkBar() {
    const bar   = document.getElementById('bulk-action-bar');
    const label = document.getElementById('bulk-count-label');
    const n     = State.selectedConvIds.size;
    if (!bar) return;
    if (n === 0) {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
    } else {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
        bar.style.flexDirection = 'column';
        if (label) label.textContent = `${n} conversation${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}`;
    }
    // Populate agent dropdown once
    _populateBulkAgentDropdown();
}

function _populateBulkAgentDropdown() {
    const dd = document.getElementById('bulk-assign-dropdown');
    if (!dd || dd.dataset.populated) return;
    dd.dataset.populated = '1';
    dd.innerHTML = State.agents
        .filter(a => a.status === 'available' || a.status === 'busy')
        .map(a => `<button onclick="bulkAction('assign','${a.id}'); toggleBulkAssignDropdown()"
                        class="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full ${a.status === 'available' ? 'bg-green-400' : 'bg-amber-400'} flex-shrink-0"></span>
                    ${escHtml(a.name)}
                   </button>`)
        .join('') || '<p class="px-3 py-2 text-xs text-gray-400">Aucun agent disponible</p>';
}

function toggleBulkAssignDropdown() {
    const dd = document.getElementById('bulk-assign-dropdown');
    if (!dd) return;
    dd.classList.toggle('hidden');
    if (!dd.classList.contains('hidden')) {
        dd.dataset.populated = '';
        _populateBulkAgentDropdown();
    }
}

async function bulkAction(action, value = null) {
    const ids = [...State.selectedConvIds];
    if (!ids.length) return;
    document.getElementById('bulk-assign-dropdown')?.classList.add('hidden');
    try {
        const res = await API.put('/api/conversations/bulk', { ids, action, value });
        showToast('Actions groupées', `${res.affected} conversation(s) mise(s) à jour`, 'success');
        clearBulkSelection();
        await loadConversations(State.currentFilter);
    } catch (e) {
        showToast('Erreur', e.message, 'error');
    }
}

async function openConversation(id) {
    State.currentConvId = id;
    State.msgOldestId   = null;
    State.msgTotal      = 0;
    State.msgLoading    = false;
    State.newMsgCount   = 0;
    _lastRenderedMsg    = null;
    _noteMode           = false;
    toggleNoteMode(false);
    _clearTypingIndicator();
    clearTimeout(_typingStopTimer);
    _lastTypingSent = 0;
    _updateNewMsgBanner();
    renderConversationList();
    mobileOpenChat();

    const chatPanel  = document.getElementById('chat-panel');
    const emptyState = document.getElementById('chat-empty');
    if (chatPanel)  chatPanel.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    // Show message skeleton while loading
    const container = document.getElementById('messages-container');
    if (container) container.innerHTML = skeletonMessages();

    setChatInputState('loading');

    try {
        const [conv, msgData] = await Promise.all([
            API.get(`/api/conversations/${id}`),
            API.get(`/api/conversations/${id}/messages?per_page=50`)
        ]);

        renderChatHeader(conv);
        addConvTab(conv);
        renderAIContextBar(conv);
        State.messages    = msgData.items;
        State.msgTotal    = msgData.total;
        State.msgOldestId = msgData.items[0]?.id ?? null;
        renderMessages();
        scrollToBottom();
        setupMessageInfiniteScroll();
        setChatInputState(conv.status === 'closed' ? 'closed' : 'open');

        if (!conv.custom_name && !conv.display_name && conv.contact_id) {
            setTimeout(() => startRename(conv.id, conv.contact_id,
                conv.whatsapp_number || conv.whatsapp_jid?.split('@')[0] || ''), 400);
        }
    } catch (e) {
        setChatInputState('error');
        const msg = e.message?.includes('403') || e.message?.includes('interdit')
            ? 'Conversation non assignée — lecture seule'
            : e.message;
        showChatError(msg);
    }
}

function setChatInputState(state) {
    const input   = document.getElementById('msg-input');
    const sendBtn = document.querySelector('[onclick="sendMessage()"]');
    const aiBtn   = document.querySelector('[onclick="getSuggestions()"]');
    const bar     = document.getElementById('chat-input-bar');

    if (!input) return;

    const disabled = state !== 'open';
    input.disabled   = disabled;
    if (sendBtn) sendBtn.disabled = disabled;
    if (aiBtn)   aiBtn.disabled   = disabled;

    if (bar) {
        bar.classList.toggle('opacity-50', disabled);
        bar.classList.toggle('pointer-events-none', disabled);
    }

    const hint = document.getElementById('chat-input-hint');
    if (hint) {
        if (state === 'closed') {
            hint.textContent = 'Conversation fermée';
            hint.classList.remove('hidden');
        } else if (state === 'error') {
            hint.textContent = 'Accès restreint — lecture seule';
            hint.classList.remove('hidden');
        } else {
            hint.classList.add('hidden');
        }
    }
}

function showChatError(msg) {
    const container = document.getElementById('messages-container');
    const header    = document.getElementById('chat-header');
    if (header && !header.innerHTML.trim()) {
        header.innerHTML = `<div class="text-sm text-gray-400 italic px-2">Conversation</div>`;
    }
    if (container) {
        container.innerHTML = `
            <div class="flex items-center justify-center h-full">
                <div class="text-center text-gray-400 text-sm">
                    <div class="text-2xl mb-2">🔒</div>
                    <div>${escHtml(msg || 'Impossible de charger cette conversation')}</div>
                </div>
            </div>`;
    }
}

function renderChatHeader(conv) {
    const isUnnamed = !conv.custom_name && !conv.display_name;
    const name   = conv.effective_name || conv.custom_name || conv.display_name
                   || conv.whatsapp_number || conv.whatsapp_jid?.split('@')[0] || 'Contact inconnu';
    const avatar = isUnnamed ? '?' : (name.trim()[0]?.toUpperCase() ?? '?');
    const header = document.getElementById('chat-header');
    if (!header) return;

    const isAdmin  = ['super_admin','admin'].includes(State.user?.role);
    const isClosed = conv.status === 'closed';
    const avatarBg = isClosed ? 'bg-[#90A4AE]' : (isUnnamed ? 'bg-[#DEB887]' : 'bg-[#DFE5E7]');

    const renameBtn = isUnnamed
        ? `<button onclick="startRename(${conv.id}, ${conv.contact_id}, '${escAttr(conv.whatsapp_number || conv.whatsapp_jid?.split('@')[0] || '')}')"
               title="Nommer ce contact"
               class="flex items-center gap-1 text-xs bg-amber-100 text-amber-700 border border-amber-300 px-2 py-0.5 rounded-full hover:bg-amber-200 transition-colors font-medium">
               <i class="fa-solid fa-tag text-[10px]"></i> Nommer</button>`
        : `<button onclick="startRename(${conv.id}, ${conv.contact_id}, '${escAttr(name)}')"
               title="Renommer ce contact"
               class="text-gray-300 hover:text-[#25D366] transition-colors leading-none select-none">
               <i class="fa-solid fa-pen text-xs"></i></button>`;

    const statusColors = {
        new:      'bg-[#E8F5E9] text-[#1B5E20]',
        assigned: 'bg-[#FFF3E0] text-[#E65100]',
        ongoing:  'bg-[#E3F2FD] text-[#0D47A1]',
        waiting:  'bg-[#FFF8E1] text-[#F57F17]',
        closed:   'bg-[#ECEFF1] text-[#546E7A]',
    };

    const tagPills = renderTagPills(conv.tags);

    header.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-full ${avatarBg} ${isClosed ? 'text-white' : (isUnnamed ? 'text-white' : 'text-[#54656F]')} flex items-center justify-center font-semibold text-base select-none flex-shrink-0">
                ${avatar}
            </div>
            <div class="min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="font-semibold text-[15px] ${isUnnamed ? 'text-amber-600 italic' : 'text-[#111B21]'}">${escHtml(name)}</span>
                    ${renameBtn}
                    ${tagPills ? `<div class="flex items-center gap-1">${tagPills}</div>` : ''}
                </div>
                <div class="text-xs text-[#667781]">${escHtml(conv.whatsapp_number || conv.whatsapp_jid || '')}</div>
            </div>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
            <span class="text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[conv.status] || 'bg-gray-100 text-gray-600'}">${conv.status}</span>

            <!-- Tag editor toggle -->
            <div class="relative">
                <button onclick="toggleTagDropdown(${conv.id})" title="Gérer les tags"
                    class="w-7 h-7 rounded-lg text-[#8696A0] hover:text-[#111B21] hover:bg-[#E9EDEF] flex items-center justify-center transition-colors">
                    <i class="fa-solid fa-tag text-xs"></i>
                </button>
                <div id="tag-dropdown-${conv.id}" class="hidden absolute right-0 top-full mt-1 bg-white border border-[#E9EDEF] rounded-xl shadow-xl p-2 z-20 min-w-[180px]">
                    ${renderTagEditor(conv)}
                </div>
            </div>

            <!-- AI analyze -->
            <button onclick="triggerAIAnalyze(${conv.id})" title="Analyser avec l'IA"
                class="w-7 h-7 rounded-lg text-[#8696A0] hover:text-violet-600 hover:bg-violet-50 flex items-center justify-center transition-colors">
                <i class="fa-solid fa-wand-magic-sparkles text-xs"></i>
            </button>

            <select onchange="updateConvPriority(${conv.id}, this.value)"
                class="text-xs border border-[#E9EDEF] bg-white rounded-lg px-2 py-1 text-[#111B21] focus:outline-none focus:border-[#25D366]">
                <option value="low"    ${conv.priority === 'low'    ? 'selected' : ''}>Faible</option>
                <option value="normal" ${conv.priority === 'normal' ? 'selected' : ''}>Normal</option>
                <option value="high"   ${conv.priority === 'high'   ? 'selected' : ''}>Élevé</option>
                <option value="urgent" ${conv.priority === 'urgent' ? 'selected' : ''}>Urgent</option>
            </select>
            ${isAdmin ? `
            <select onchange="assignAgent(${conv.id}, this.value)"
                class="text-xs border border-[#E9EDEF] bg-white rounded-lg px-2 py-1 text-[#111B21] focus:outline-none focus:border-[#25D366]">
                <option value="">Assigner…</option>
                ${State.agents.filter(a => a.role === 'agent').map(a =>
                    `<option value="${a.id}" ${a.id == conv.assigned_agent_id ? 'selected' : ''}>${escHtml(a.name)}</option>`
                ).join('')}
            </select>` : ''}
            ${conv.status !== 'closed' ? `
            <button onclick="closeConversation(${conv.id})"
                class="text-xs text-[#54656F] hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">
                <i class="fa-solid fa-xmark mr-1"></i>Fermer
            </button>` : ''}
        </div>`;
}

function toggleTagDropdown(convId) {
    const dd = document.getElementById(`tag-dropdown-${convId}`);
    if (!dd) return;
    const isOpen = !dd.classList.contains('hidden');
    // Close all other open tag dropdowns
    document.querySelectorAll('[id^="tag-dropdown-"]').forEach(el => el.classList.add('hidden'));
    if (!isOpen) dd.classList.remove('hidden');
}

// Close tag dropdowns on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('[id^="tag-dropdown-"]') && !e.target.closest('[onclick*="toggleTagDropdown"]')) {
        document.querySelectorAll('[id^="tag-dropdown-"]').forEach(el => el.classList.add('hidden'));
    }
});

async function updateConvPriority(convId, priority) {
    try {
        await API.put(`/api/conversations/${convId}/priority`, { priority });
        const conv = State.conversations.find(c => c.id === convId);
        if (conv) conv.priority = priority;
    } catch(e) { showToast('Erreur', e.message, 'error'); }
}

function startRename(convId, contactId, currentName) {
    const header = document.getElementById('chat-header');
    if (!header) return;
    const nameSpan = header.querySelector('.font-semibold');
    if (!nameSpan) return;
    const row = nameSpan.parentElement;

    row.innerHTML = `
        <form class="flex items-center gap-1"
              onsubmit="confirmRename(event, ${convId}, ${contactId})">
            <input id="rename-input" type="text" value="${escAttr(currentName)}" maxlength="150"
                class="border border-[#25D366] rounded px-2 py-0.5 text-sm font-semibold text-gray-800
                       focus:outline-none focus:ring-1 focus:ring-[#25D366] w-36">
            <button type="submit"
                class="text-xs bg-[#25D366] text-white px-2 py-1 rounded-lg hover:bg-[#1DA851] leading-none">
                <i class="fa-solid fa-check"></i></button>
            <button type="button" onclick="cancelRename(${convId})"
                class="text-xs text-gray-400 hover:text-gray-600 px-1 leading-none">
                <i class="fa-solid fa-xmark"></i></button>
        </form>`;

    const inp = document.getElementById('rename-input');
    if (inp) { inp.focus(); inp.select(); }
}

function cancelRename(convId) {
    const conv = State.conversations.find(c => c.id === convId);
    if (conv) renderChatHeader(conv);
}

async function confirmRename(e, convId, contactId) {
    e.preventDefault();
    const name = document.getElementById('rename-input')?.value.trim();
    if (!name) return;

    try {
        await API.post('/api/contacts/alias', { contact_id: contactId, custom_name: name });
        State.conversations.forEach(c => {
            if (c.contact_id === contactId) {
                c.custom_name  = name;
                c.effective_name = name;
            }
        });
        renderConversationList();
        const conv = State.conversations.find(c => c.id === convId);
        if (conv) renderChatHeader(conv);
        showToast('Contact renommé', `"${name}"`, 'success');
    } catch (err) {
        showToast('Erreur', err.message, 'error');
        cancelRename(convId);
    }
}

function renderMessages() {
    const container = document.getElementById('messages-container');
    if (!container) return;

    container.querySelectorAll('audio').forEach(a => { a.pause(); a.src = ''; });

    renderedMsgIds.clear();
    State.messages.forEach(m => renderedMsgIds.add(String(m.id)));
    _lastRenderedMsg = State.messages[State.messages.length - 1] || null;

    const hasMore = State.messages.length < State.msgTotal;
    let html = `<div id="msg-load-indicator" class="${hasMore ? '' : 'hidden'} text-center py-2 text-xs text-[#8696A0]">
        <i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Chargement…
    </div>`;

    State.messages.forEach((msg, i) => {
        const prev    = State.messages[i - 1] || null;
        const grouped = _isGrouped(msg, prev);
        // Date separator: always before first message, and on day changes
        if (!prev || _dayKey(msg.sent_at) !== _dayKey(prev.sent_at)) {
            html += buildDateSeparator(msg.sent_at);
        }
        html += buildMessageHTML(msg, grouped);
    });

    container.innerHTML = html;
}

function setupMessageInfiniteScroll() {
    const container = document.getElementById('messages-container');
    if (!container) return;

    // Remove any previous handler stored on the element
    if (container._scrollHandler) {
        container.removeEventListener('scroll', container._scrollHandler);
    }

    container._scrollHandler = async function () {
        // Hide new-message banner when user scrolls back to bottom
        if (_isAtBottom()) {
            State.newMsgCount = 0;
            _updateNewMsgBanner();
        }

        if (this.scrollTop > 80) return;           // not near top
        if (State.msgLoading) return;              // already loading
        if (!State.msgOldestId) return;            // no anchor
        if (State.messages.length >= State.msgTotal) return; // all loaded

        State.msgLoading = true;
        const indicator = document.getElementById('msg-load-indicator');
        if (indicator) indicator.classList.remove('hidden');

        const prevScrollHeight = this.scrollHeight;
        const convId           = State.currentConvId;

        try {
            const items = await API.get(
                `/api/conversations/${convId}/messages?per_page=50&before_id=${State.msgOldestId}`
            );

            if (!items.length || convId !== State.currentConvId) return;

            State.messages    = [...items, ...State.messages];
            State.msgOldestId = items[0].id;
            items.forEach(m => renderedMsgIds.add(String(m.id)));

            // Prepend HTML after indicator without full re-render
            const frag = document.createDocumentFragment();
            const tmp  = document.createElement('div');
            tmp.innerHTML = items.map(m => buildMessageHTML(m)).join('');
            while (tmp.firstChild) frag.appendChild(tmp.firstChild);
            const anchor = indicator ? indicator.nextSibling : this.firstChild;
            this.insertBefore(frag, anchor);

            // Hide indicator when all messages are loaded
            if (State.messages.length >= State.msgTotal && indicator) {
                indicator.classList.add('hidden');
            }

            // Preserve scroll position: stay at same visual offset
            this.scrollTop = this.scrollHeight - prevScrollHeight;
        } catch (err) {
            console.error('[InfiniteScroll]', err);
        } finally {
            State.msgLoading = false;
        }
    };

    container.addEventListener('scroll', container._scrollHandler);
}

function buildMessageHTML(msg, grouped = false) {
    const isAgent = ['agent', 'bot', 'system'].includes(msg.sender_type);
    const isNote  = msg.type === 'note';
    const time    = formatTime(msg.sent_at);

    const sender  = isNote ? 'Note interne'
                  : msg.sender_type === 'bot' ? 'Bot IA'
                  : msg.sender_name || msg.contact?.custom_name || msg.contact?.display_name || (isAgent ? 'Agent' : 'Client');

    const statusMark = isAgent && !isNote
        ? (msg.status === 'sending'
            ? '<i class="fa-regular fa-clock text-[#8696A0] ml-0.5 text-[10px]"></i>'
            : msg.status === 'unconfirmed'
            ? '<i class="fa-solid fa-triangle-exclamation text-amber-400 ml-0.5 text-[10px]" title="Non confirmé par WhatsApp"></i>'
            : msg.status === 'read'
            ? '<i class="fa-solid fa-check-double text-[#53BDEB] ml-0.5 text-[11px]"></i>'
            : msg.status === 'delivered'
            ? '<i class="fa-solid fa-check-double text-[#8696A0] ml-0.5 text-[11px]"></i>'
            : '<i class="fa-solid fa-check text-[#8696A0] ml-0.5 text-[11px]"></i>')
        : '';

    if (isNote) {
        return `
        <div class="flex justify-center my-2" data-msg-id="${escHtml(String(msg.id))}">
            <div class="max-w-sm bg-[#FFFDE7] border border-[#FFE082] rounded-lg px-4 py-2.5 shadow-sm">
                <div class="flex items-center gap-1.5 mb-1">
                    <i class="fa-solid fa-lock text-[#B8860B] text-xs"></i>
                    <span class="text-xs font-semibold text-[#7B6200]">Note interne</span>
                    <span class="text-xs text-[#A0896A] ml-auto">${time}</span>
                </div>
                <p class="text-sm text-[#5D4037]">${escHtml(msg.content || '')}</p>
            </div>
        </div>`;
    }

    const isMedia = msg.media_url && msg.type !== 'text';
    const body    = isMedia
        ? buildMediaHTML(msg, isAgent) + (msg.content ? `<p class="text-[14.2px] text-[#111B21] leading-snug mt-1">${escHtml(msg.content)}</p>` : '')
        : `<p class="text-[14.2px] text-[#111B21] leading-snug">${escHtml(msg.content || '')}</p>`;

    const gapClass = grouped ? 'mt-[1px]' : 'mt-1';

    if (isAgent) {
        return `
        <div class="flex justify-end pr-5 ${gapClass}" data-msg-id="${escHtml(String(msg.id))}">
            <div class="msg-out-bubble${grouped ? ' msg-grouped' : ''} px-3 py-1.5 max-w-[65%] min-w-[80px] overflow-hidden">
                ${body}
                <div class="flex items-center justify-end gap-0.5 mt-0.5">
                    <span class="text-[11px] text-[#667781] leading-none">${time}</span>
                    ${statusMark}
                </div>
            </div>
        </div>`;
    }

    return `
    <div class="flex justify-start pl-5 ${gapClass}" data-msg-id="${escHtml(String(msg.id))}">
        <div class="msg-in-bubble${grouped ? ' msg-grouped' : ''} px-3 py-1.5 max-w-[65%] min-w-[80px] overflow-hidden">
            ${grouped ? '' : `<p class="text-xs font-semibold text-[#06CF9C] mb-0.5 leading-none">${escHtml(sender)}</p>`}
            ${body}
            <div class="flex items-center justify-end mt-0.5">
                <span class="text-[11px] text-[#667781] leading-none">${time}</span>
            </div>
        </div>
    </div>`;
}

function resolveMediaUrl(url) {
    if (!url) return '';
    if (url.startsWith('blob:') || url.startsWith('http')) return url;
    // media_url is stored as /WhatFlow/... → prepend backend origin
    try { return new URL(API.baseURL).origin + url; } catch { return url; }
}

function buildMediaHTML(msg, isAgent = false) {
    if (!msg.media_url) return '';

    const url  = resolveMediaUrl(msg.media_url);
    const safe = escHtml(url);

    switch (msg.type) {
        case 'image':
            return `<img src="${safe}" alt="image"
                         class="rounded-xl max-w-full max-h-64 object-cover cursor-pointer block"
                         onclick="window.open('${safe}','_blank')" loading="lazy">`;

        case 'video':
            return `<video controls class="rounded-xl max-w-full max-h-48 block" preload="metadata">
                        <source src="${safe}">
                    </video>`;

        case 'audio': {
            const uid          = 'aud_' + Math.random().toString(36).slice(2);
            const barInactive  = isAgent ? 'rgba(0,0,0,0.22)' : '#C5CDD3';
            const barActive    = isAgent ? '#25D366'           : '#00A884';
            return `
            <div class="flex items-center gap-2.5 py-0.5" style="min-width:230px;"
                 role="group" aria-label="Message audio">
                <button onclick="toggleAudio('${uid}')" id="playbtn_${uid}"
                    aria-label="Lire le message audio" title="Lire / Pause"
                    class="w-11 h-11 rounded-full bg-[#00A884] hover:bg-[#017A61] flex items-center justify-center flex-shrink-0 shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#00A884] focus:ring-offset-1">
                    <i id="playicon_${uid}" class="fa-solid fa-play text-white text-sm" style="margin-left:2px;" aria-hidden="true"></i>
                </button>
                <div class="flex-1 min-w-0">
                    <div class="relative flex items-end gap-[2px] h-8" id="wave_${uid}" aria-hidden="true">
                        ${generateWaveform(barInactive)}
                        <input type="range" id="seek_${uid}" value="0" min="0" max="100" step="0.1"
                            aria-label="Position de lecture"
                            class="absolute inset-0 w-full h-full cursor-pointer focus:outline-none"
                            style="opacity:0; z-index:10;"
                            oninput="seekAudio('${uid}', this.value)">
                    </div>
                    <span id="dur_${uid}" class="text-[11px] text-[#667781] tabular-nums mt-0.5 block" aria-live="polite">0:00</span>
                </div>
                <audio id="${uid}" src="${safe}" preload="metadata"
                    data-active="${barActive}" data-inactive="${barInactive}"
                    onloadedmetadata="initAudio('${uid}')"
                    ontimeupdate="updateAudioProgress('${uid}')"
                    onended="resetAudio('${uid}')"></audio>
            </div>`;
        }

        case 'document': {
            const fname = decodeURIComponent(safe.split('/').pop().split('?')[0]);
            return `<a href="${safe}" target="_blank" download
                       class="flex items-center gap-2.5 px-3 py-2.5 bg-black/5 rounded-xl hover:bg-black/10 transition-colors">
                        <i class="fa-solid fa-file-lines text-[#54656F] text-xl flex-shrink-0"></i>
                        <span class="text-sm text-[#111B21] truncate flex-1">${escHtml(fname)}</span>
                        <i class="fa-solid fa-download text-[#8696A0] text-xs flex-shrink-0"></i>
                    </a>`;
        }

        default: return '';
    }
}

function generateWaveform(color) {
    const h = [4,6,9,5,12,8,14,10,6,11,13,7,10,15,9,7,12,8,5,10,7,13,11,6,9,11,7,5,7,4];
    return h.map(px =>
        `<span class="wa-bar" style="display:inline-block;width:3px;height:${px}px;border-radius:2px;background:${color};flex-shrink:0;"></span>`
    ).join('');
}

// ── Lecteur audio custom ──────────────────────────────────────────────────
function initAudio(uid) {
    const audio = document.getElementById(uid);
    const dur   = document.getElementById('dur_' + uid);
    if (audio && dur && isFinite(audio.duration)) {
        dur.textContent = fmtDuration(audio.duration);
    }
}

function toggleAudio(uid) {
    const audio = document.getElementById(uid);
    const icon  = document.getElementById('playicon_' + uid);
    if (!audio) return;
    document.querySelectorAll('audio').forEach(a => {
        if (a.id !== uid && !a.paused) {
            a.pause();
            const i = document.getElementById('playicon_' + a.id);
            if (i) { i.classList.replace('fa-pause','fa-play'); i.style.marginLeft = '2px'; }
        }
    });
    if (audio.paused) {
        audio.play();
        icon?.classList.replace('fa-play','fa-pause');
        if (icon) icon.style.marginLeft = '0';
    } else {
        audio.pause();
        icon?.classList.replace('fa-pause','fa-play');
        if (icon) icon.style.marginLeft = '2px';
    }
}

function _colorWaveform(uid, pct) {
    const audio = document.getElementById(uid);
    const wave  = document.getElementById('wave_' + uid);
    if (!wave || !audio) return;
    const bars    = wave.querySelectorAll('.wa-bar');
    const filled  = Math.round(bars.length * pct);
    const active  = audio.dataset.active   || '#00A884';
    const inactive= audio.dataset.inactive || '#C5CDD3';
    bars.forEach((b, i) => { b.style.background = i < filled ? active : inactive; });
}

function updateAudioProgress(uid) {
    const audio = document.getElementById(uid);
    const seek  = document.getElementById('seek_' + uid);
    const dur   = document.getElementById('dur_' + uid);
    if (!audio) return;
    const pct = isFinite(audio.duration) ? audio.currentTime / audio.duration : 0;
    if (seek && isFinite(audio.duration)) seek.value = pct * 100;
    if (dur) dur.textContent = fmtDuration(audio.currentTime);
    _colorWaveform(uid, pct);
}

function seekAudio(uid, val) {
    const audio = document.getElementById(uid);
    if (audio && isFinite(audio.duration)) {
        audio.currentTime = (val / 100) * audio.duration;
        _colorWaveform(uid, val / 100);
    }
}

function resetAudio(uid) {
    const icon  = document.getElementById('playicon_' + uid);
    const seek  = document.getElementById('seek_' + uid);
    const dur   = document.getElementById('dur_' + uid);
    const audio = document.getElementById(uid);
    if (icon) { icon.classList.replace('fa-pause','fa-play'); icon.style.marginLeft = '2px'; }
    if (seek) seek.value = 0;
    if (dur && audio && isFinite(audio.duration)) dur.textContent = fmtDuration(audio.duration);
    _colorWaveform(uid, 0);
}

function fmtDuration(s) {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
}

function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    const id = String(msg.id);
    if (renderedMsgIds.has(id)) return;
    renderedMsgIds.add(id);

    const wasAtBottom = _isAtBottom();
    const grouped     = _isGrouped(msg, _lastRenderedMsg);

    // Date separator if day changed
    if (_lastRenderedMsg && _dayKey(msg.sent_at) !== _dayKey(_lastRenderedMsg.sent_at)) {
        container.insertAdjacentHTML('beforeend', buildDateSeparator(msg.sent_at));
    }

    // Remove tail from previous bubble when it becomes part of a group
    if (grouped && _lastRenderedMsg) {
        const prevEl = container.querySelector(`[data-msg-id="${String(_lastRenderedMsg.id)}"]`);
        if (prevEl) {
            prevEl.querySelector('.msg-out-bubble, .msg-in-bubble')?.classList.add('msg-grouped');
        }
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildMessageHTML(msg, grouped);
    const el = wrapper.firstElementChild;
    if (el) {
        el.classList.add('msg-animate');
        container.appendChild(el);
    }

    _lastRenderedMsg = msg;

    // Smart scroll: only auto-scroll if user was already at bottom,
    // or if the message is from the current user (optimistic / sent)
    const isOwnMessage = msg.sender_type === 'agent' && String(msg.sender_id) === String(State.user?.id);
    if (wasAtBottom || isOwnMessage || String(id).startsWith('tmp_')) {
        const c = document.getElementById('messages-container');
        if (c) c.scrollTop = c.scrollHeight;
        State.newMsgCount = 0;
        _updateNewMsgBanner();
    } else {
        State.newMsgCount++;
        _updateNewMsgBanner();
    }
}

async function sendMessage() {
    if (_mediaFile) { await sendMedia(); return; }

    const input = document.getElementById('msg-input');
    const content = input?.value.trim();
    if (!content || !State.currentConvId) return;

    input.value = '';
    input.disabled = true;

    // Afficher le message immédiatement (mise à jour optimiste)
    const tempId = 'tmp_' + Date.now();
    appendMessage({
        id:          tempId,
        sender_type: 'agent',
        sender_id:   State.user?.id,
        sender_name: State.user?.name || 'Agent',
        type:        'text',
        content,
        sent_at:     new Date().toISOString().replace('T', ' ').slice(0, 19),
        status:      'sending',
    });
    scrollToBottom();

    try {
        const saved = await API.post(`/api/conversations/${State.currentConvId}/messages`, { content });

        // Remplacer le message optimiste par la version confirmée
        const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl && saved?.id) {
            renderedMsgIds.delete(tempId);
            renderedMsgIds.add(String(saved.id)); // bloquer le doublon SSE à venir
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buildMessageHTML(saved, tempEl.querySelector('.msg-out-bubble.msg-grouped, .msg-in-bubble.msg-grouped') !== null);
            const newEl = wrapper.firstElementChild;
            if (newEl) tempEl.replaceWith(newEl);
            if (_lastRenderedMsg?.id === tempId) _lastRenderedMsg = saved;
        } else if (tempEl) {
            renderedMsgIds.delete(tempId);
            tempEl.remove();
            if (_lastRenderedMsg?.id === tempId) _lastRenderedMsg = null;
        }
    } catch (e) {
        showToast('Erreur envoi', e.message, 'error');
        input.value = content;
        const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl) { renderedMsgIds.delete(tempId); tempEl.remove(); }
    } finally {
        input.disabled = false;
        input.focus();
    }
}

// ── Media / Voice ─────────────────────────────────────────────────────────

let _mediaFile        = null;
let _previewObjectUrl = null; // tracks current blob URL for revocation
let _mediaRecorder    = null;
let _recChunks        = [];
let _recTimer         = null;
let _recSeconds       = 0;
let _isRecording      = false;

function handleFileSelect(file) {
    if (!file) return;
    _mediaFile = file;

    const preview = document.getElementById('media-preview');
    const content = document.getElementById('media-preview-content');
    if (!preview || !content) return;

    // Revoke any previous preview blob URL before creating a new one
    if (_previewObjectUrl) { URL.revokeObjectURL(_previewObjectUrl); _previewObjectUrl = null; }
    const url = URL.createObjectURL(file);
    _previewObjectUrl = url;
    const isImage = file.type.startsWith('image/');
    const isAudio = file.type.startsWith('audio/');
    const isVideo = file.type.startsWith('video/');

    if (isImage) {
        content.innerHTML = `<div class="flex items-center gap-3">
            <img src="${url}" class="w-16 h-16 rounded-xl object-cover flex-shrink-0">
            <div class="min-w-0">
                <div class="text-sm font-medium text-gray-700 truncate">${escHtml(file.name)}</div>
                <div class="text-xs text-gray-400">${(file.size/1024).toFixed(0)} Ko · Image</div>
            </div></div>`;
    } else if (isAudio) {
        content.innerHTML = `<div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center flex-shrink-0">
                <i class="fa-solid fa-music text-green-600"></i></div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-700 truncate">${escHtml(file.name)}</div>
                <audio controls class="mt-1 h-8 w-full max-w-xs" preload="metadata"><source src="${url}"></audio>
            </div></div>`;
    } else if (isVideo) {
        content.innerHTML = `<div class="flex items-center gap-3">
            <video src="${url}" class="w-16 h-16 rounded-xl object-cover flex-shrink-0" muted></video>
            <div class="min-w-0">
                <div class="text-sm font-medium text-gray-700 truncate">${escHtml(file.name)}</div>
                <div class="text-xs text-gray-400">${(file.size/1024/1024).toFixed(1)} Mo · Vidéo</div>
            </div></div>`;
    } else {
        content.innerHTML = `<div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
                <i class="fa-solid fa-file-lines text-blue-600"></i></div>
            <div>
                <div class="text-sm font-medium text-gray-700 truncate">${escHtml(file.name)}</div>
                <div class="text-xs text-gray-400">${(file.size/1024).toFixed(0)} Ko · Document</div>
            </div></div>`;
    }

    preview.classList.remove('hidden');
    document.getElementById('msg-input')?.focus();
    document.getElementById('media-file-input').value = '';
}

function cancelMedia() {
    _mediaFile = null;
    if (_previewObjectUrl) { URL.revokeObjectURL(_previewObjectUrl); _previewObjectUrl = null; }
    document.getElementById('media-preview')?.classList.add('hidden');
    const c = document.getElementById('media-preview-content');
    if (c) c.innerHTML = '';
}

async function sendMedia() {
    if (!_mediaFile || !State.currentConvId) return;

    const caption = document.getElementById('msg-input')?.value.trim() || '';
    const file    = _mediaFile;
    cancelMedia();
    if (document.getElementById('msg-input')) document.getElementById('msg-input').value = '';

    // Afficher message optimiste (preview blob pour image uniquement)
    const tempId     = 'tmp_' + Date.now();
    const isImg      = file.type.startsWith('image/');
    const isAud      = file.type.startsWith('audio/');
    const isVid      = file.type.startsWith('video/');
    const previewUrl = (isImg || isVid) ? URL.createObjectURL(file) : '';
    appendMessage({
        id:          tempId,
        sender_type: 'agent',
        sender_id:   State.user?.id,
        sender_name: State.user?.name || 'Agent',
        type:        isImg ? 'image' : (isAud ? 'audio' : (isVid ? 'video' : 'document')),
        content:     caption,
        media_url:   previewUrl,
        sent_at:     new Date().toISOString().replace('T', ' ').slice(0, 19),
        status:      'sending',
    });
    scrollToBottom();

    const progressWrap = document.getElementById('upload-progress');
    const progressBar  = document.getElementById('upload-progress-bar');
    const progressPct  = document.getElementById('upload-pct');

    function _setProgress(pct) {
        if (!progressWrap) return;
        progressWrap.classList.toggle('hidden', pct < 0);
        if (pct >= 0) {
            if (progressBar) progressBar.style.width = pct + '%';
            if (progressPct) progressPct.textContent  = pct + '%';
        }
    }
    _setProgress(0);

    try {
        const form  = new FormData();
        form.append('file', file);
        if (caption) form.append('caption', caption);

        const token = localStorage.getItem('token');
        const saved = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', API.baseURL + `/api/conversations/${State.currentConvId}/media`);
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
            xhr.upload.onprogress = e => {
                if (e.lengthComputable) _setProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch { resolve({}); }
                } else {
                    let msg = xhr.statusText;
                    try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
                    reject(new Error(msg));
                }
            };
            xhr.onerror = () => reject(new Error('Erreur réseau'));
            xhr.send(form);
        });

        const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl && saved?.id) {
            renderedMsgIds.delete(tempId);
            renderedMsgIds.add(String(saved.id));
            const wrapper = document.createElement('div');
            wrapper.innerHTML = buildMessageHTML(saved);
            const newEl = wrapper.firstElementChild;
            if (newEl) tempEl.replaceWith(newEl);
        }
    } catch (e) {
        showToast('Erreur envoi média', e.message, 'error');
        const tempEl = document.querySelector(`[data-msg-id="${tempId}"]`);
        if (tempEl) { renderedMsgIds.delete(tempId); tempEl.remove(); }
    } finally {
        _setProgress(-1);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
    }
}

async function toggleVoiceRecording() {
    if (_isRecording) {
        stopVoiceRecording();
    } else {
        await startVoiceRecording();
    }
}

async function startVoiceRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _recChunks   = [];
        _recSeconds  = 0;
        _isRecording = true;

        _mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _recChunks.push(e.data); };
        _mediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(_recChunks, { type: 'audio/webm' });
            const file = new File([blob], `vocal_${Date.now()}.webm`, { type: 'audio/webm' });
            _mediaRecorder = null;
            _isRecording   = false;
            setRecordingUI(false);
            handleFileSelect(file);
        };
        _mediaRecorder.start(200);

        setRecordingUI(true);
        _recTimer = setInterval(() => {
            _recSeconds++;
            const m = Math.floor(_recSeconds / 60);
            const s = _recSeconds % 60;
            const el = document.getElementById('rec-timer');
            if (el) el.textContent = `${m}:${s.toString().padStart(2,'0')}`;
            if (_recSeconds >= 120) stopVoiceRecording(); // max 2 min
        }, 1000);
    } catch (e) {
        showToast('Micro inaccessible', e.message, 'error');
    }
}

function stopVoiceRecording() {
    clearInterval(_recTimer);
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
}

function setRecordingUI(active) {
    const micBtn  = document.getElementById('mic-btn');
    const recBar  = document.getElementById('voice-recording-bar');
    if (micBtn) {
        micBtn.innerHTML = active
            ? '<i class="fa-solid fa-stop text-sm text-red-500"></i>'
            : '<i class="fa-solid fa-microphone text-sm"></i>';
        micBtn.classList.toggle('border-red-300', active);
        micBtn.classList.toggle('bg-red-50', active);
        micBtn.title = active ? 'Arrêter l\'enregistrement' : 'Message vocal';
    }
    if (recBar) recBar.classList.toggle('hidden', !active);
}

async function closeConversation(id) {
    const btn = document.querySelector(`[onclick="closeConversation(${id})"]`);
    if (btn && btn.dataset.confirming !== '1') {
        // First click: arm the confirmation
        btn.dataset.confirming = '1';
        const origHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>Confirmer ?';
        btn.classList.add('bg-red-500', 'text-white', '!border-red-500', 'px-2', 'py-1', 'rounded-lg');
        btn._resetTimer = setTimeout(() => {
            btn.dataset.confirming = '0';
            btn.innerHTML = origHtml;
            btn.classList.remove('bg-red-500', 'text-white', '!border-red-500');
        }, 3000);
        return;
    }
    // Second click: confirmed — proceed
    if (btn) {
        clearTimeout(btn._resetTimer);
        btn.disabled = true;
    }
    try {
        await API.post(`/api/conversations/${id}/close`, {});
        showToast('Succès', 'Conversation fermée', 'success');
        await loadConversations(State.currentFilter);
        State.currentConvId = null;
        setChatInputState('open');
        document.getElementById('chat-panel')?.classList.add('hidden');
        document.getElementById('chat-empty')?.classList.remove('hidden');
    } catch (e) {
        showToast('Erreur', e.message, 'error');
        if (btn) btn.disabled = false;
    }
}

async function assignAgent(convId, agentId) {
    if (!agentId) return;
    try {
        await API.post(`/api/conversations/${convId}/assign`, { agent_id: parseInt(agentId) });
        showToast('Succès', 'Agent assigné', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

// ── AI Suggestions ────────────────────────────────────────────────────────
async function getSuggestions() {
    if (!State.currentConvId) return;
    const panel = document.getElementById('ai-panel');
    const list  = document.getElementById('ai-suggestions');
    if (!panel || !list) return;

    panel.classList.remove('hidden');
    list.innerHTML = '<div class="text-sm text-gray-400 animate-pulse">Génération en cours...</div>';

    try {
        const data = await API.post('/api/ai/suggest', { conversation_id: State.currentConvId });
        const sugs = data.suggestions || [];

        if (!sugs.length) {
            list.innerHTML = '<div class="text-sm text-gray-400">Aucune suggestion disponible</div>';
            return;
        }

        list.innerHTML = sugs.map(s => `
            <div class="suggestion-item px-3 py-2.5 bg-gray-50 hover:bg-green-50 border border-gray-100 hover:border-green-200 rounded-xl cursor-pointer text-sm text-gray-700 transition-colors"
                 onclick="useSuggestion(${s.id}, '${escAttr(s.text)}')">
                ${escHtml(s.text)}
            </div>`).join('');
    } catch (e) { list.innerHTML = `<div class="text-sm text-red-500">${escHtml(e.message)}</div>`; }
}

function useSuggestion(id, text) {
    const input = document.getElementById('msg-input');
    if (input) { input.value = text; input.focus(); }
    document.getElementById('ai-panel')?.classList.add('hidden');
    API.put(`/api/ai/suggestions/${id}/used`, {}).catch(() => {});
}

// ── Agents ────────────────────────────────────────────────────────────────
async function loadAgents() {
    try {
        State.agents = await API.get('/api/agents');
    } catch { /* non-bloquant */ }
}

async function loadAgentsView() {
    await loadAgents();
    const container = document.getElementById('agents-container');
    if (!container) return;

    const isAdmin     = ['super_admin','admin'].includes(State.user?.role);
    const isSuperAdmin = State.user?.role === 'super_admin';

    const statusMeta = {
        available: { dot: 'bg-emerald-400', label: 'Disponible', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
        busy:      { dot: 'bg-amber-400',   label: 'Occupé',     badge: 'bg-amber-50 text-amber-700 border-amber-200'   },
        inactive:  { dot: 'bg-gray-400',    label: 'Inactif',    badge: 'bg-gray-50 text-gray-600 border-gray-200'      },
        offline:   { dot: 'bg-gray-300',    label: 'Hors ligne', badge: 'bg-gray-50 text-gray-400 border-gray-200'      },
    };

    const addBtn = isAdmin ? `
        <div class="mb-4">
            <button onclick="showAgentModal()"
                class="flex items-center gap-2 px-4 py-2 bg-[#25D366] text-white text-sm rounded-xl hover:bg-[#1DA851] transition-colors font-medium shadow-sm">
                <i class="fa-solid fa-plus"></i> Nouvel agent
            </button>
        </div>` : '';

    container.innerHTML = addBtn + State.agents.map(a => {
        const sm = statusMeta[a.status] || statusMeta.offline;
        const roleLabel = { super_admin:'Super Admin', admin:'Admin', agent:'Agent' }[a.role] || a.role;
        const isSelf = a.id === State.user?.id;
        return `
        <div class="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
            <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-3">
                    <div class="w-11 h-11 rounded-full bg-gradient-to-br from-[#25D366] to-[#128C7E] text-white flex items-center justify-center font-semibold text-base shadow-sm flex-shrink-0">
                        ${a.name[0].toUpperCase()}
                    </div>
                    <div>
                        <div class="font-semibold text-sm text-gray-800">${escHtml(a.name)}</div>
                        <div class="text-xs text-gray-400 mt-0.5">${escHtml(a.email || '')} · ${roleLabel}</div>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs px-2 py-0.5 rounded-full border font-medium ${sm.badge} flex items-center gap-1.5">
                        <span class="w-1.5 h-1.5 rounded-full ${sm.dot} inline-block"></span>${sm.label}
                    </span>
                    ${isAdmin ? `<button onclick="showAgentModal(${JSON.stringify(a).replace(/"/g,'&quot;')})"
                        class="text-gray-300 hover:text-[#25D366] transition-colors p-1" title="Modifier">
                        <i class="fa-solid fa-pen text-xs"></i></button>` : ''}
                    ${isSuperAdmin && !isSelf ? `<button onclick="deleteAgent(${a.id})"
                        class="text-gray-300 hover:text-red-500 transition-colors p-1" title="Supprimer">
                        <i class="fa-solid fa-trash text-xs"></i></button>` : ''}
                </div>
            </div>
            ${isAdmin ? `
            <div class="flex gap-1.5 flex-wrap">
                ${['available','busy','inactive','offline'].map(s => {
                    const active = a.status === s;
                    const m = statusMeta[s];
                    return '<button onclick="updateAgentStatus(' + a.id + ', \'' + s + '\')" class="text-xs px-2.5 py-1 rounded-lg border font-medium transition-colors ' + (active ? m.badge + ' border-current' : 'border-gray-200 text-gray-500 hover:bg-gray-50') + '">' + m.label + '</button>';
                }).join('')}
            </div>` : ''}
        </div>`;
    }).join('');
}

function showAgentModal(agent = null) {
    const isEdit  = agent !== null;
    const title   = isEdit ? 'Modifier l\'agent' : 'Nouvel agent';
    const isSuperAdmin = State.user?.role === 'super_admin';

    const modal = document.createElement('div');
    modal.id    = 'agent-modal';
    modal.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div class="flex items-center justify-between mb-5">
                <h3 class="font-semibold text-gray-800 text-base">${title}</h3>
                <button onclick="document.getElementById('agent-modal').remove()"
                    class="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <form onsubmit="saveAgent(event, ${isEdit ? agent.id : 'null'})" class="space-y-3">
                <div>
                    <label class="block text-xs font-medium text-gray-600 mb-1">Nom</label>
                    <input name="name" type="text" value="${escAttr(agent?.name || '')}" required maxlength="100"
                        class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                </div>
                <div>
                    <label class="block text-xs font-medium text-gray-600 mb-1">Email</label>
                    <input name="email" type="email" value="${escAttr(agent?.email || '')}" required
                        class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                </div>
                <div>
                    <label class="block text-xs font-medium text-gray-600 mb-1">
                        Mot de passe${isEdit ? ' <span class="text-gray-400 font-normal">(laisser vide pour ne pas changer)</span>' : ''}
                    </label>
                    <input name="password" type="password" ${isEdit ? '' : 'required'} minlength="6"
                        class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]"
                        placeholder="${isEdit ? '••••••••' : ''}">
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1">Rôle</label>
                        <select name="role" required
                            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                            <option value="agent"       ${agent?.role==='agent'       ?'selected':''}>Agent</option>
                            <option value="admin"       ${agent?.role==='admin'       ?'selected':''}>Admin</option>
                            ${isSuperAdmin ? `<option value="super_admin" ${agent?.role==='super_admin'?'selected':''}>Super Admin</option>` : ''}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1">Max conversations</label>
                        <input name="max_conversations" type="number" min="1" max="100"
                            value="${agent?.max_conversations ?? 10}"
                            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                    </div>
                </div>
                <div class="flex justify-end gap-2 pt-2">
                    <button type="button" onclick="document.getElementById('agent-modal').remove()"
                        class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">Annuler</button>
                    <button type="submit"
                        class="px-4 py-2 text-sm bg-[#25D366] text-white rounded-lg hover:bg-[#1DA851] font-medium">
                        ${isEdit ? 'Enregistrer' : 'Créer'}
                    </button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('input[name="name"]').focus();
}

async function saveAgent(e, agentId) {
    e.preventDefault();
    const form = e.target;
    const data = {
        name:              form.name.value.trim(),
        email:             form.email.value.trim(),
        role:              form.role.value,
        max_conversations: parseInt(form.max_conversations.value) || 10,
    };
    if (form.password.value) data.password = form.password.value;

    try {
        if (agentId) {
            await API.put(`/api/agents/${agentId}`, data);
            showToast('Succès', 'Agent mis à jour', 'success');
        } else {
            await API.post('/api/agents', data);
            showToast('Succès', 'Agent créé', 'success');
        }
        document.getElementById('agent-modal')?.remove();
        await loadAgents();
        loadAgentsView();
    } catch (err) {
        showToast('Erreur', err.message, 'error');
    }
}

async function deleteAgent(id) {
    const btn = document.querySelector(`[onclick="deleteAgent(${id})"]`);
    if (btn && btn.dataset.confirming !== '1') {
        btn.dataset.confirming = '1';
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check text-xs"></i>';
        btn.classList.add('text-red-500');
        btn._t = setTimeout(() => { btn.dataset.confirming = '0'; btn.innerHTML = orig; btn.classList.remove('text-red-500'); }, 3000);
        return;
    }
    if (btn) { clearTimeout(btn._t); btn.disabled = true; }
    try {
        await API.delete(`/api/agents/${id}`);
        showToast('Succès', 'Agent supprimé', 'success');
        await loadAgents();
        loadAgentsView();
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function updateAgentStatus(id, status) {
    try {
        await API.put(`/api/agents/${id}/status`, { status });
        await loadAgentsView();
        showToast('Succès', 'Statut mis à jour', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

// ── Contacts ──────────────────────────────────────────────────────────────
async function loadContacts(search = '', reset = true) {
    const container = document.getElementById('contacts-container');
    if (!container) return;

    if (reset) {
        State.contactPage  = 1;
        State.contactTotal = 0;
        container.innerHTML = skeletonContacts();
    }

    try {
        let path = `/api/contacts?per_page=30&page=${State.contactPage}`;
        if (search) path += `&search=${encodeURIComponent(search)}`;
        const data = await API.get(path);

        const cards = data.items.map(c => {
            const hasName  = c.custom_name || c.display_name;
            const label    = c.custom_name || c.display_name || 'Sans nom';
            const avatarBg = hasName ? 'from-[#25D366] to-[#128C7E]' : 'from-amber-400 to-amber-500';
            const avatarCh = hasName ? label[0].toUpperCase() : '?';
            return `
            <div class="bg-white rounded-xl px-4 py-3 border border-gray-100 shadow-sm flex items-center justify-between hover:shadow-md transition-shadow group">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-full bg-gradient-to-br ${avatarBg} text-white flex items-center justify-center font-semibold text-sm flex-shrink-0 shadow-sm">
                        ${avatarCh}
                    </div>
                    <div class="min-w-0">
                        <div class="font-medium text-sm ${hasName ? 'text-gray-800' : 'text-amber-600 italic'} truncate">${escHtml(label)}</div>
                        <div class="text-xs text-gray-400 mt-0.5">${escHtml(c.whatsapp_number || c.whatsapp_jid?.split('@')[0] || '')}</div>
                    </div>
                </div>
                <div class="flex items-center gap-3 flex-shrink-0">
                    <button onclick="showContactHistory(${c.id}, '${escAttr(label)}')"
                        class="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-[#25D366] hover:text-[#075E54] font-medium px-2.5 py-1 rounded-lg hover:bg-[#F0FFF4] flex items-center gap-1.5">
                        <i class="fa-solid fa-clock-rotate-left text-[10px]"></i> Historique
                    </button>
                    <div class="text-xs text-gray-400 tabular-nums">${formatTime(c.last_seen)}</div>
                </div>
            </div>`;
        }).join('');

        if (reset) {
            container.innerHTML = cards;
        } else {
            container.insertAdjacentHTML('beforeend', cards);
        }

        State.contactTotal = data.total;
        const loadMoreBtn = document.getElementById('contacts-load-more');
        if (loadMoreBtn) {
            const loaded = container.children.length;
            loadMoreBtn.classList.toggle('hidden', loaded >= State.contactTotal);
        }
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function loadMoreContacts() {
    State.contactPage++;
    const search = document.querySelector('#view-contacts input[type=text]')?.value.trim() || '';
    await loadContacts(search, false);
}

async function showContactHistory(contactId, contactName, initialTab = 'convs') {
    const existing = document.getElementById('contact-history-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'contact-history-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" onclick="document.getElementById('contact-history-modal').remove()"></div>
        <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
            <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
                <div>
                    <h3 class="font-semibold text-gray-800 text-base">${escHtml(contactName)}</h3>
                </div>
                <button onclick="document.getElementById('contact-history-modal').remove()"
                    class="w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="flex border-b border-gray-100 flex-shrink-0 px-4">
                <button id="chm-tab-convs" onclick="_chmTab('convs',${contactId})"
                    class="chm-tab px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px">
                    <i class="fa-regular fa-comments mr-1.5"></i>Conversations
                </button>
                <button id="chm-tab-notes" onclick="_chmTab('notes',${contactId})"
                    class="chm-tab px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ml-1">
                    <i class="fa-regular fa-note-sticky mr-1.5"></i>Notes
                </button>
            </div>
            <div id="contact-history-body" class="flex-1 overflow-y-auto p-4">
                <div class="flex items-center justify-center py-8 text-gray-400">
                    <i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Chargement…
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    await _chmTab(initialTab, contactId);
}

async function _chmTab(tab, contactId) {
    const btnConvs = document.getElementById('chm-tab-convs');
    const btnNotes = document.getElementById('chm-tab-notes');
    const body     = document.getElementById('contact-history-body');
    if (!body) return;

    const activeTab   = 'border-[#25D366] text-[#25D366]';
    const inactiveTab = 'border-transparent text-gray-500 hover:text-gray-700';
    if (btnConvs) btnConvs.className = 'chm-tab px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ' + (tab === 'convs' ? activeTab : inactiveTab);
    if (btnNotes) btnNotes.className = 'chm-tab px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ml-1 ' + (tab === 'notes' ? activeTab : inactiveTab);

    body.innerHTML = `<div class="flex items-center justify-center py-8 text-gray-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Chargement…</div>`;

    if (tab === 'convs') {
        await _chmRenderConvs(contactId, body);
    } else {
        await _chmRenderNotes(contactId, body);
    }
}

async function _chmRenderConvs(contactId, body) {
    try {
        const convs = await API.get(`/api/contacts/${contactId}/conversations`);
        if (!convs.length) {
            body.innerHTML = `<div class="text-center py-8 text-gray-400 text-sm">Aucune conversation trouvée</div>`;
            return;
        }
        const STATUS_LABELS = { new: 'Nouveau', assigned: 'Assigné', ongoing: 'En cours', waiting: 'En attente', closed: 'Clôturé' };
        const STATUS_COLORS = {
            new:      'bg-blue-50 text-blue-700',
            assigned: 'bg-purple-50 text-purple-700',
            ongoing:  'bg-[#F0FFF4] text-[#25D366]',
            waiting:  'bg-amber-50 text-amber-700',
            closed:   'bg-gray-100 text-gray-500',
        };
        body.innerHTML = convs.map(c => {
            const statusCls = STATUS_COLORS[c.status] || 'bg-gray-100 text-gray-500';
            const statusLbl = STATUS_LABELS[c.status] || c.status;
            const sentIcon  = c.ai_sentiment === 'positive' ? `<i class="fa-regular fa-face-smile text-green-500" title="Sentiment positif"></i>`
                            : c.ai_sentiment === 'negative' ? `<i class="fa-regular fa-face-frown text-red-500" title="Sentiment négatif"></i>`
                            : '';
            return `
            <div onclick="document.getElementById('contact-history-modal').remove(); openConversation(${c.id})"
                class="flex items-start gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer transition-colors border border-transparent hover:border-gray-100 mb-1 group">
                <div class="flex-shrink-0 mt-0.5">
                    <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusCls}">${statusLbl}</span>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-0.5">
                        <span class="text-xs text-gray-500">${formatTime(c.opened_at)}</span>
                        ${sentIcon}
                        ${c.agent_name ? `<span class="text-[10px] text-gray-400">· ${escHtml(c.agent_name)}</span>` : ''}
                    </div>
                    ${c.last_message
                        ? `<p class="text-sm text-gray-700 truncate">${escHtml(String(c.last_message).slice(0, 80))}</p>`
                        : `<p class="text-sm text-gray-400 italic">${statusLbl}</p>`}
                    ${c.ai_summary ? `<p class="text-xs text-purple-600 mt-0.5 truncate"><i class="fa-solid fa-robot text-[9px] mr-1"></i>${escHtml(c.ai_summary)}</p>` : ''}
                </div>
                <i class="fa-solid fa-chevron-right text-gray-300 text-xs flex-shrink-0 mt-1 group-hover:text-gray-400 transition-colors"></i>
            </div>`;
        }).join('');
    } catch (e) {
        body.innerHTML = `<div class="text-center py-8 text-red-500 text-sm">${escHtml(e.message)}</div>`;
    }
}

async function _chmRenderNotes(contactId, body) {
    try {
        const notes = await API.get(`/api/contacts/${contactId}/notes`);
        const myId  = State.currentUser?.id;

        body.innerHTML = `
            <div class="mb-4">
                <textarea id="chm-note-input" rows="3" placeholder="Ajouter une note interne sur ce contact…"
                    class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#25D366]/30 focus:border-[#25D366]"></textarea>
                <div class="flex justify-end mt-1.5">
                    <button onclick="_chmAddNote(${contactId})"
                        class="px-4 py-1.5 bg-[#25D366] text-white text-xs font-semibold rounded-lg hover:bg-[#128C7E] transition-colors">
                        <i class="fa-solid fa-plus mr-1"></i>Ajouter
                    </button>
                </div>
            </div>
            <div id="chm-notes-list">
                ${notes.length
                    ? notes.map(n => _chmNoteHtml(n, myId, contactId)).join('')
                    : `<div class="text-center py-6 text-gray-400 text-sm">Aucune note pour ce contact</div>`}
            </div>`;
    } catch (e) {
        body.innerHTML = `<div class="text-center py-8 text-red-500 text-sm">${escHtml(e.message)}</div>`;
    }
}

function _chmNoteHtml(note, myId, contactId) {
    const canDelete = note.agent_id == myId || State.currentUser?.role === 'admin';
    return `
    <div id="chm-note-${note.id}" class="bg-amber-50 border border-amber-100 rounded-xl p-3 mb-2">
        <div class="flex items-start justify-between gap-2">
            <p class="text-sm text-gray-800 flex-1 whitespace-pre-wrap">${escHtml(note.content)}</p>
            ${canDelete ? `<button onclick="_chmDeleteNote(${contactId}, ${note.id})"
                class="flex-shrink-0 text-gray-300 hover:text-red-400 transition-colors text-xs mt-0.5" title="Supprimer">
                <i class="fa-solid fa-trash"></i></button>` : ''}
        </div>
        <div class="mt-1.5 text-[10px] text-amber-600 flex items-center gap-1">
            <i class="fa-solid fa-user-tie text-[9px]"></i>
            <span>${escHtml(note.agent_name)}</span>
            <span class="opacity-60 ml-1">${formatTime(note.created_at)}</span>
        </div>
    </div>`;
}

async function _chmAddNote(contactId) {
    const input = document.getElementById('chm-note-input');
    const content = input?.value.trim();
    if (!content) return;

    try {
        const note = await API.post(`/api/contacts/${contactId}/notes`, { content });
        input.value = '';
        const list = document.getElementById('chm-notes-list');
        if (list) {
            const emptyMsg = list.querySelector('.text-center');
            if (emptyMsg) emptyMsg.remove();
            list.insertAdjacentHTML('afterbegin', _chmNoteHtml(note, State.currentUser?.id, contactId));
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function _chmDeleteNote(contactId, noteId) {
    try {
        await API.delete(`/api/contacts/${contactId}/notes/${noteId}`);
        document.getElementById(`chm-note-${noteId}`)?.remove();
        const list = document.getElementById('chm-notes-list');
        if (list && !list.children.length) {
            list.innerHTML = `<div class="text-center py-6 text-gray-400 text-sm">Aucune note pour ce contact</div>`;
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function loadContactConversations(contactId, name) {
    showContactHistory(contactId, name);
}

// ── Settings ──────────────────────────────────────────────────────────────
async function loadSettings() {
    initProfileForm();
    const isAdmin = ['super_admin', 'admin'].includes(State.user?.role);
    const tasks = [loadAutoResponses(), loadWhatsAppStatus(), load2FAStatus()];
    if (isAdmin) tasks.push(loadWebhooks());
    await Promise.all(tasks);
}

// ── 2FA Settings ──────────────────────────────────────────────────────────
let _2faSecret = null;

async function load2FAStatus() {
    try {
        const data = await API.get('/api/auth/2fa/status');
        _render2FAStatus(data.enabled, data.enabled_at);
    } catch { /* settings might load before login in edge cases */ }
}

function _render2FAStatus(enabled, enabledAt) {
    const desc    = document.getElementById('tfa-description');
    const actions = document.getElementById('tfa-actions');
    if (!desc || !actions) return;

    if (enabled) {
        const since = enabledAt ? ' depuis le ' + new Date(enabledAt).toLocaleDateString('fr-FR') : '';
        desc.innerHTML = `<span class="inline-flex items-center gap-1.5 text-green-600 font-medium"><i class="fa-solid fa-circle-check text-sm"></i>Active${since}</span>`;
        actions.innerHTML = `<button onclick="showDisable2FA()"
            class="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-xl hover:bg-red-50 transition-colors font-medium">
            <i class="fa-solid fa-shield-xmark mr-1.5"></i>Désactiver la 2FA
        </button>`;
    } else {
        desc.textContent = 'Protégez votre compte avec un second facteur d\'authentification.';
        actions.innerHTML = `<button onclick="startSetup2FA()"
            class="px-4 py-2 text-sm bg-[#25D366] hover:bg-[#1DA851] text-white rounded-xl transition-colors font-semibold">
            <i class="fa-solid fa-shield-halved mr-1.5"></i>Configurer la 2FA
        </button>`;
    }
    document.getElementById('tfa-setup-panel')?.classList.add('hidden');
    document.getElementById('tfa-disable-panel')?.classList.add('hidden');
}

async function startSetup2FA() {
    try {
        const data = await API.post('/api/auth/2fa/setup', {});
        _2faSecret = data.secret;
        document.getElementById('tfa-secret-text').textContent = data.secret;
        const qrEl = document.getElementById('tfa-qr-canvas');
        qrEl.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
            new QRCode(qrEl, { text: data.uri, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        } else {
            qrEl.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.uri)}" alt="QR 2FA" class="rounded-lg">`;
        }
        document.getElementById('tfa-setup-panel').classList.remove('hidden');
        document.getElementById('tfa-confirm-code').value = '';
        setTimeout(() => document.getElementById('tfa-confirm-code')?.focus(), 50);
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function confirmEnable2FA() {
    const code = document.getElementById('tfa-confirm-code')?.value.trim();
    if (!code || !_2faSecret) return;
    try {
        await API.post('/api/auth/2fa/enable', { secret: _2faSecret, code });
        _2faSecret = null;
        showToast('2FA activée', 'Votre compte est maintenant protégé.', 'success');
        _render2FAStatus(true, new Date().toISOString());
    } catch (e) {
        showToast('Code invalide', e.message, 'error');
        document.getElementById('tfa-confirm-code').value = '';
    }
}

function showDisable2FA() {
    document.getElementById('tfa-disable-panel').classList.remove('hidden');
    document.getElementById('tfa-disable-code').value = '';
    setTimeout(() => document.getElementById('tfa-disable-code')?.focus(), 50);
}

async function confirmDisable2FA() {
    const code = document.getElementById('tfa-disable-code')?.value.trim();
    if (!code) return;
    try {
        await API.post('/api/auth/2fa/disable', { code });
        showToast('2FA désactivée', 'Authentification en deux étapes supprimée.', 'info');
        _render2FAStatus(false, null);
    } catch (e) {
        showToast('Code invalide', e.message, 'error');
        document.getElementById('tfa-disable-code').value = '';
    }
}

// ── Profile & password ────────────────────────────────────────────────────
function initProfileForm() {
    const input = document.getElementById('profile-name');
    if (input && State.user?.name) input.value = State.user.name;
}

async function saveProfileName() {
    const name = document.getElementById('profile-name')?.value.trim();
    if (!name) return;
    try {
        await API.put('/api/auth/profile', { name });
        State.user.name = name;
        // Update sidebar display name
        const el = document.getElementById('user-name');
        if (el) el.textContent = name;
        showToast('Profil mis à jour', '', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function savePassword() {
    const current = document.getElementById('pwd-current')?.value;
    const next    = document.getElementById('pwd-new')?.value;
    const confirm = document.getElementById('pwd-confirm')?.value;

    if (!current || !next || !confirm) { showToast('Champs manquants', 'Remplissez tous les champs.', 'error'); return; }
    if (next.length < 8) { showToast('Trop court', 'Le nouveau mot de passe doit faire au moins 8 caractères.', 'error'); return; }
    if (next !== confirm) { showToast('Non concordant', 'Les deux mots de passe ne correspondent pas.', 'error'); return; }

    try {
        await API.put('/api/auth/password', { current_password: current, new_password: next });
        document.getElementById('pwd-current').value = '';
        document.getElementById('pwd-new').value     = '';
        document.getElementById('pwd-confirm').value = '';
        showToast('Mot de passe modifié', 'Changement enregistré avec succès.', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

// ── Webhooks ──────────────────────────────────────────────────────────────
const WH_EVENTS = [
    { key: 'conversation:new',     label: 'Conversation créée' },
    { key: 'conversation:updated', label: 'Conversation mise à jour' },
    { key: 'conversation:closed',  label: 'Conversation fermée' },
    { key: 'message:new',          label: 'Nouveau message' },
    { key: 'agent:status',         label: 'Statut agent' },
];

async function loadWebhooks() {
    const list = document.getElementById('webhooks-list');
    if (!list) return;
    try {
        const rows = await API.get('/api/webhooks');
        if (!rows.length) {
            list.innerHTML = '<p class="text-xs text-gray-400">Aucun webhook configuré.</p>';
            return;
        }
        list.innerHTML = rows.map(w => `
            <div class="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl border border-gray-100 gap-2">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full flex-shrink-0 ${w.active ? 'bg-green-400' : 'bg-gray-300'}"></span>
                        <span class="text-xs font-mono text-gray-700 truncate">${escHtml(w.url)}</span>
                    </div>
                    <div class="flex flex-wrap gap-1 mt-1 pl-4">
                        ${(w.events||[]).map(e => `<span class="text-[10px] bg-white border border-gray-200 px-1.5 py-0.5 rounded font-mono">${e}</span>`).join('')}
                    </div>
                    ${w.last_called ? `<p class="text-[10px] text-gray-400 pl-4 mt-0.5">Dernier appel : ${new Date(w.last_called).toLocaleString('fr-FR')} — HTTP ${w.last_status || '?'}</p>` : ''}
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                    <button onclick="testWebhook(${w.id})" title="Tester" class="w-6 h-6 rounded-lg hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-[#25D366] transition-colors">
                        <i class="fa-solid fa-paper-plane text-[10px]"></i>
                    </button>
                    <button onclick="toggleWebhook(${w.id}, ${w.active ? 0 : 1})" title="${w.active ? 'Désactiver' : 'Activer'}" class="w-6 h-6 rounded-lg hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-amber-500 transition-colors">
                        <i class="fa-solid ${w.active ? 'fa-pause' : 'fa-play'} text-[10px]"></i>
                    </button>
                    <button onclick="deleteWebhook(${w.id})" title="Supprimer" class="w-6 h-6 rounded-lg hover:bg-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors">
                        <i class="fa-solid fa-trash text-[10px]"></i>
                    </button>
                </div>
            </div>`).join('');
    } catch (e) {
        list.innerHTML = `<p class="text-xs text-red-400">${escHtml(e.message)}</p>`;
    }
}

function openAddWebhook() {
    document.getElementById('wh-edit-id').value = '';
    document.getElementById('wh-url').value = '';
    _renderWhEventsGrid([]);
    document.getElementById('webhook-form').classList.remove('hidden');
    document.getElementById('wh-url').focus();
}

function closeWebhookForm() {
    document.getElementById('webhook-form').classList.add('hidden');
}

function _renderWhEventsGrid(selected = []) {
    const grid = document.getElementById('wh-events-grid');
    if (!grid) return;
    grid.innerHTML = WH_EVENTS.map(e => `
        <label class="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" value="${e.key}" class="wh-event-chk accent-[#25D366]" ${selected.includes(e.key) ? 'checked' : ''}>
            ${e.label}
        </label>`).join('');
}

async function saveWebhook() {
    const id     = document.getElementById('wh-edit-id').value;
    const url    = document.getElementById('wh-url').value.trim();
    const events = [...document.querySelectorAll('.wh-event-chk:checked')].map(el => el.value);

    if (!url)         { showToast('URL requise', '', 'error'); return; }
    if (!events.length) { showToast('Sélectionnez au moins un événement', '', 'error'); return; }

    try {
        if (id) {
            await API.put(`/api/webhooks/${id}`, { url, events });
        } else {
            const data = await API.post('/api/webhooks', { url, events });
            showToast('Webhook créé', `Secret : ${data.secret}`, 'info');
        }
        closeWebhookForm();
        loadWebhooks();
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function testWebhook(id) {
    try {
        const res = await API.post(`/api/webhooks/${id}/test`, {});
        showToast('Test réussi', `HTTP ${res.status}`, 'success');
        loadWebhooks();
    } catch (e) { showToast('Test échoué', e.message, 'error'); }
}

async function toggleWebhook(id, active) {
    try {
        await API.put(`/api/webhooks/${id}`, { active });
        loadWebhooks();
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function deleteWebhook(id) {
    if (!confirm('Supprimer ce webhook ?')) return;
    try {
        await API.delete(`/api/webhooks/${id}`);
        loadWebhooks();
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function loadWhatsAppStatus() {
    const el = document.getElementById('wa-status');
    const qrEl = document.getElementById('wa-qr');
    if (!el) return;

    try {
        const s = await API.get('/api/whatsapp/status');
        el.innerHTML = s.connected
            ? `<div class="flex items-center gap-2 text-green-600 font-medium"><i class="fa-solid fa-circle-check"></i> Connecté — ${escHtml(s.phone || '')}</div>`
            : `<div class="flex items-center gap-2 text-orange-500 font-medium"><i class="fa-regular fa-clock"></i> Non connecté</div>`;

        if (!s.connected) {
            const qr = await API.get('/api/whatsapp/qr');
            if (qr.qr && qrEl) {
                qrEl.innerHTML = `<img src="${qr.qr}" class="w-48 h-48 rounded-lg border" alt="QR Code">
                    <p class="text-sm text-gray-500 mt-2">Scannez ce QR avec WhatsApp</p>`;
            }
        }
    } catch (e) {
        el.innerHTML = `<div class="text-gray-400">Bridge WhatsApp non disponible</div>`;
    }
}

async function loadAutoResponses() {
    const container = document.getElementById('auto-responses-container');
    if (!container) return;

    try {
        const rules = await API.get('/api/auto-responses');
        renderAutoResponses(rules);
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

function renderAutoResponses(rules) {
    const container = document.getElementById('auto-responses-container');
    if (!container) return;

    const isAdmin = ['super_admin','admin'].includes(State.user?.role);

    if (!rules.length) {
        container.innerHTML = '<p class="text-sm text-gray-400">Aucune règle configurée</p>';
        return;
    }

    container.innerHTML = rules.map(r => `
        <div class="bg-white rounded-lg p-4 border border-gray-200 flex items-start justify-between gap-3">
            <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                    <span class="font-medium text-sm text-gray-800">${escHtml(r.name)}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">${r.is_active ? 'Actif' : 'Inactif'}</span>
                </div>
                <div class="text-xs text-gray-500">Si le message <strong>${r.trigger_type}</strong> <em>"${escHtml(r.trigger_value)}"</em></div>
                <div class="text-sm text-gray-700 mt-1 bg-gray-50 rounded p-2">${escHtml(r.response_text)}</div>
            </div>
            ${isAdmin ? `
            <div class="flex gap-2">
                <button onclick="toggleAutoResponse(${r.id}, ${r.is_active})"
                    class="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50">
                    ${r.is_active ? 'Désactiver' : 'Activer'}
                </button>
                <button onclick="showAutoResponseModal(${JSON.stringify(r).replace(/"/g,'&quot;')})"
                    class="text-xs px-2 py-1 rounded border border-blue-200 text-blue-600 hover:bg-blue-50">
                    Modifier
                </button>
                <button onclick="deleteAutoResponse(${r.id})"
                    class="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50">
                    Supprimer
                </button>
            </div>` : ''}
        </div>`).join('');
}

async function toggleAutoResponse(id, currentState) {
    try {
        await API.put(`/api/auto-responses/${id}`, { is_active: currentState ? 0 : 1 });
        await loadAutoResponses();
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function deleteAutoResponse(id) {
    const btn = document.querySelector(`[onclick="deleteAutoResponse(${id})"]`);
    if (btn && btn.dataset.confirming !== '1') {
        btn.dataset.confirming = '1';
        const orig = btn.innerHTML;
        btn.innerHTML = 'Confirmer ?';
        btn._t = setTimeout(() => { btn.dataset.confirming = '0'; btn.innerHTML = orig; }, 3000);
        return;
    }
    if (btn) { clearTimeout(btn._t); btn.disabled = true; }
    try {
        await API.delete(`/api/auto-responses/${id}`);
        await loadAutoResponses();
        showToast('Succès', 'Règle supprimée', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

async function createAutoResponse(e) {
    e.preventDefault();
    const form = e.target;
    const data = {
        name:          form.name.value.trim(),
        trigger_type:  form.trigger_type.value,
        trigger_value: form.trigger_value.value.trim(),
        response_text: form.response_text.value.trim(),
        priority:      parseInt(form.priority?.value || 0),
    };
    try {
        await API.post('/api/auto-responses', data);
        form.reset();
        await loadAutoResponses();
        showToast('Succès', 'Règle créée', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

function showAutoResponseModal(rule) {
    const modal = document.createElement('div');
    modal.id    = 'ar-modal';
    modal.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6">
            <div class="flex items-center justify-between mb-5">
                <h3 class="font-semibold text-gray-800 text-base">Modifier la règle</h3>
                <button onclick="document.getElementById('ar-modal').remove()"
                    class="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <form onsubmit="submitAutoResponseEdit(event, ${rule.id})" class="space-y-3">
                <div>
                    <label class="block text-xs font-medium text-gray-600 mb-1">Nom</label>
                    <input name="name" type="text" value="${escAttr(rule.name)}" required maxlength="100"
                        class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1">Type de déclencheur</label>
                        <select name="trigger_type"
                            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                            <option value="contains"   ${rule.trigger_type==='contains'   ?'selected':''}>Contient</option>
                            <option value="equals"     ${rule.trigger_type==='equals'     ?'selected':''}>Égal à</option>
                            <option value="starts_with"${rule.trigger_type==='starts_with'?'selected':''}>Commence par</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1">Valeur</label>
                        <input name="trigger_value" type="text" value="${escAttr(rule.trigger_value)}" required
                            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                    </div>
                </div>
                <div>
                    <label class="block text-xs font-medium text-gray-600 mb-1">Réponse automatique</label>
                    <textarea name="response_text" required rows="3"
                        class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366] resize-none">${escHtml(rule.response_text)}</textarea>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1">Priorité</label>
                        <input name="priority" type="number" min="0" max="100" value="${rule.priority ?? 0}"
                            class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#25D366]">
                    </div>
                    <div class="flex items-end pb-1">
                        <label class="flex items-center gap-2 cursor-pointer">
                            <input name="is_active" type="checkbox" ${rule.is_active ? 'checked' : ''}
                                class="w-4 h-4 accent-[#25D366]">
                            <span class="text-sm text-gray-700">Active</span>
                        </label>
                    </div>
                </div>
                <div class="flex justify-end gap-2 pt-2">
                    <button type="button" onclick="document.getElementById('ar-modal').remove()"
                        class="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-600">Annuler</button>
                    <button type="submit"
                        class="px-4 py-2 text-sm bg-[#25D366] text-white rounded-lg hover:bg-[#1DA851] font-medium">
                        Enregistrer
                    </button>
                </div>
            </form>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('input[name="name"]').focus();
}

async function submitAutoResponseEdit(e, id) {
    e.preventDefault();
    const form = e.target;
    const data = {
        name:          form.name.value.trim(),
        trigger_type:  form.trigger_type.value,
        trigger_value: form.trigger_value.value.trim(),
        response_text: form.response_text.value.trim(),
        priority:      parseInt(form.priority.value) || 0,
        is_active:     form.is_active.checked ? 1 : 0,
    };
    try {
        await API.put(`/api/auto-responses/${id}`, data);
        document.getElementById('ar-modal')?.remove();
        await loadAutoResponses();
        showToast('Succès', 'Règle mise à jour', 'success');
    } catch (err) {
        showToast('Erreur', err.message, 'error');
    }
}

// ── Canned Responses ──────────────────────────────────────────────────────
let _cannedCache = [];

async function loadCannedResponses() {
    const list = document.getElementById('canned-list');
    if (!list) return;
    list.innerHTML = '<p class="text-sm text-gray-400 py-4">Chargement…</p>';

    // Show add button for admins only
    const addBtn = document.getElementById('canned-add-btn');
    if (addBtn && ['admin','super_admin'].includes(State.user?.role)) {
        addBtn.classList.remove('hidden');
    }

    try {
        _cannedCache = await API.get('/api/canned-responses');
        renderCannedList(_cannedCache);
    } catch (e) {
        list.innerHTML = `<p class="text-sm text-red-500 py-4">${escHtml(e.message)}</p>`;
    }
}

function renderCannedList(items) {
    const list    = document.getElementById('canned-list');
    const isAdmin = ['admin','super_admin'].includes(State.user?.role);
    if (!list) return;

    if (!items.length) {
        list.innerHTML = `<div class="text-center py-12 text-gray-400">
            <i class="fa-solid fa-reply-all text-3xl mb-3 opacity-30"></i>
            <p class="text-sm">Aucun template. <button onclick="openCannedForm()" class="text-[#25D366] hover:underline font-medium">Créer le premier</button></p>
        </div>`;
        return;
    }

    list.innerHTML = items.map(cr => `
        <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-start gap-3 group hover:border-gray-200 transition-colors">
            <div class="flex-shrink-0 w-8 h-8 rounded-lg bg-[#F0FFF4] flex items-center justify-center mt-0.5">
                <i class="fa-solid fa-reply-all text-[#25D366] text-xs"></i>
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 mb-1">
                    <code class="text-xs font-bold text-[#25D366] bg-[#F0FFF4] px-2 py-0.5 rounded-full">/${escHtml(cr.shortcut)}</code>
                    <span class="text-sm font-semibold text-gray-800">${escHtml(cr.title)}</span>
                </div>
                <p class="text-xs text-gray-500 line-clamp-2 leading-relaxed">${escHtml(cr.content)}</p>
                ${cr.creator_name ? `<p class="text-[10px] text-gray-300 mt-1">Par ${escHtml(cr.creator_name)}</p>` : ''}
            </div>
            ${isAdmin ? `<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button onclick="editCannedResponse(${cr.id})" title="Modifier"
                    class="w-7 h-7 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-500 flex items-center justify-center transition-colors">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>
                <button onclick="deleteCannedResponse(${cr.id})" title="Supprimer"
                    class="w-7 h-7 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 flex items-center justify-center transition-colors">
                    <i class="fa-solid fa-trash text-xs"></i>
                </button>
            </div>` : ''}
        </div>`).join('');
}

function openCannedForm(id = null) {
    const wrap = document.getElementById('canned-form-wrap');
    const titleEl = document.getElementById('canned-form-title');
    if (!wrap) return;
    document.getElementById('canned-edit-id').value  = id || '';
    document.getElementById('canned-shortcut').value = '';
    document.getElementById('canned-title').value    = '';
    document.getElementById('canned-content').value  = '';
    if (id) {
        const cr = _cannedCache.find(r => r.id === id);
        if (cr) {
            document.getElementById('canned-shortcut').value = cr.shortcut;
            document.getElementById('canned-title').value    = cr.title;
            document.getElementById('canned-content').value  = cr.content;
        }
        titleEl.textContent = 'Modifier le template';
    } else {
        titleEl.textContent = 'Nouveau template';
    }
    wrap.classList.remove('hidden');
    document.getElementById('canned-shortcut').focus();
}

function closeCannedForm() {
    document.getElementById('canned-form-wrap')?.classList.add('hidden');
}

function editCannedResponse(id) {
    openCannedForm(id);
    document.getElementById('canned-form-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitCannedForm(e) {
    e.preventDefault();
    const id       = document.getElementById('canned-edit-id').value;
    const payload  = {
        shortcut: document.getElementById('canned-shortcut').value.trim().replace(/^\/+/, ''),
        title:    document.getElementById('canned-title').value.trim(),
        content:  document.getElementById('canned-content').value.trim(),
    };
    try {
        if (id) {
            await API.put(`/api/canned-responses/${id}`, payload);
            showToast('Succès', 'Template mis à jour', 'success');
        } else {
            await API.post('/api/canned-responses', payload);
            showToast('Succès', 'Template créé', 'success');
        }
        closeCannedForm();
        await loadCannedResponses();
    } catch (err) {
        showToast('Erreur', err.message, 'error');
    }
}

async function deleteCannedResponse(id) {
    const btn = event.currentTarget;
    if (btn.dataset.confirming) {
        try {
            await API.delete(`/api/canned-responses/${id}`);
            showToast('Supprimé', 'Template supprimé', 'success');
            await loadCannedResponses();
        } catch (err) {
            showToast('Erreur', err.message, 'error');
        }
    } else {
        btn.dataset.confirming = '1';
        btn.innerHTML = '<i class="fa-solid fa-check text-xs"></i>';
        btn.classList.add('bg-red-50', 'text-red-500');
        setTimeout(() => { delete btn.dataset.confirming; btn.innerHTML = '<i class="fa-solid fa-trash text-xs"></i>'; btn.classList.remove('bg-red-50','text-red-500'); }, 3000);
    }
}

// ── Canned responses trigger in message input ─────────────────────────────
let _crIndex = -1;

function setupCannedTrigger() {
    const input = document.getElementById('msg-input');
    if (!input) return;

    input.addEventListener('input', _onCannedInput);
    input.addEventListener('keydown', _onCannedKey);
    document.addEventListener('click', e => {
        if (!e.target.closest('#canned-popup') && !e.target.closest('#msg-input')) {
            _closeCannedPopup();
        }
    });
}

function _onCannedInput() {
    const val = document.getElementById('msg-input')?.value || '';
    if (!val.startsWith('/')) { _closeCannedPopup(); return; }
    const q = val.slice(1).toLowerCase();
    const matches = _cannedCache.filter(cr =>
        cr.shortcut.includes(q) || cr.title.toLowerCase().includes(q)
    ).slice(0, 8);
    _renderCannedPopup(matches, q);
}

function _onCannedKey(e) {
    const popup = document.getElementById('canned-popup');
    if (!popup || popup.classList.contains('hidden')) return;
    const items = popup.querySelectorAll('[data-cr-idx]');
    if (e.key === 'ArrowDown') { e.preventDefault(); _crIndex = Math.min(_crIndex + 1, items.length - 1); _highlightCR(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _crIndex = Math.max(_crIndex - 1, 0); _highlightCR(items); }
    else if (e.key === 'Enter' && _crIndex >= 0) { e.preventDefault(); items[_crIndex]?.click(); }
    else if (e.key === 'Escape') { _closeCannedPopup(); }
    else if (e.key === 'Tab' && items.length) { e.preventDefault(); items[Math.max(0, _crIndex)]?.click(); }
}

function _highlightCR(items) {
    items.forEach((el, i) => el.classList.toggle('bg-[#F0FFF4]', i === _crIndex));
}

function _renderCannedPopup(items, q) {
    let popup = document.getElementById('canned-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'canned-popup';
        popup.className = 'absolute bottom-full left-0 right-0 mb-1 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden z-50 max-h-64 overflow-y-auto';
        document.getElementById('msg-input')?.closest('form, .relative, div')?.style && null;
        const inputWrap = document.getElementById('msg-input')?.parentElement?.parentElement;
        if (inputWrap) { inputWrap.style.position = 'relative'; inputWrap.appendChild(popup); }
    }
    _crIndex = -1;

    if (!items.length) { _closeCannedPopup(); return; }

    popup.classList.remove('hidden');
    popup.innerHTML = `
        <div class="px-3 py-1.5 border-b border-gray-50 flex items-center gap-2">
            <i class="fa-solid fa-reply-all text-[#25D366] text-xs"></i>
            <span class="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Templates — <kbd class="font-mono">Tab</kbd> ou <kbd class="font-mono">↵</kbd> pour insérer</span>
        </div>
        ${items.map((cr, i) => `
        <div data-cr-idx="${i}" onclick="insertCannedResponse('${escAttr(cr.content)}')"
            class="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-[#F0FFF4] transition-colors">
            <code class="text-[11px] font-bold text-[#25D366] bg-[#F0FFF4] px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5">/${escHtml(cr.shortcut)}</code>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-800 truncate">${escHtml(cr.title)}</div>
                <div class="text-xs text-gray-400 truncate">${escHtml(String(cr.content).slice(0, 70))}</div>
            </div>
        </div>`).join('')}`;
}

function _closeCannedPopup() {
    const p = document.getElementById('canned-popup');
    if (p) p.classList.add('hidden');
    _crIndex = -1;
}

function insertCannedResponse(text) {
    const input = document.getElementById('msg-input');
    if (input) { input.value = text; input.focus(); input.dispatchEvent(new Event('input')); }
    _closeCannedPopup();
}

// ── Analytics ─────────────────────────────────────────────────────────────
async function loadAnalytics() {
    const container = document.getElementById('analytics-container');
    if (container) container.innerHTML = skeletonAnalytics();
    try {
        const [dashRes, agentsRes] = await Promise.allSettled([
            API.get('/api/analytics/dashboard'),
            API.get('/api/analytics/agents'),
        ]);
        if (dashRes.status === 'rejected') throw dashRes.reason;
        renderAnalytics(dashRes.value, agentsRes.status === 'fulfilled' ? agentsRes.value : []);
    } catch (e) {
        if (container) container.innerHTML =
            `<div class="text-red-500 text-sm p-6">Accès réservé aux administrateurs</div>`;
    }
}

function renderAnalytics(data, agents = []) {
    const container = document.getElementById('analytics-container');
    if (!container) return;

    // last_7_days bar chart
    const days   = data.last_7_days || [];
    const maxVal = Math.max(1, ...days.map(d => d.count));
    const barChart = days.length ? `
        <div class="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm mb-6">
            <h3 class="text-sm font-semibold text-gray-700 mb-4">Conversations — 7 derniers jours</h3>
            <div class="flex items-end gap-2 h-24">
                ${days.map(d => {
                    const pct = Math.round((d.count / maxVal) * 100);
                    const label = new Date(d.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
                    return `<div class="flex flex-col items-center gap-1 flex-1">
                        <span class="text-xs text-gray-500 font-semibold">${d.count}</span>
                        <div class="w-full bg-[#25D366] rounded-t-sm" style="height:${Math.max(4, pct)}%"></div>
                        <span class="text-[10px] text-gray-400 text-center leading-tight">${escHtml(label)}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>` : '';

    // by_priority
    const priorities  = { low: 'Faible', normal: 'Normal', high: 'Élevé', urgent: 'Urgent' };
    const prioColors  = { low: 'bg-gray-300', normal: 'bg-blue-400', high: 'bg-amber-400', urgent: 'bg-red-500' };
    const prioTotal   = (data.by_priority || []).reduce((s, p) => s + parseInt(p.count), 0) || 1;
    const prioChart   = `
        <div class="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
            <h3 class="text-sm font-semibold text-gray-700 mb-3">Par priorité</h3>
            ${(data.by_priority || []).map(p => {
                const pct = Math.round((p.count / prioTotal) * 100);
                return `<div class="mb-2 last:mb-0">
                    <div class="flex justify-between text-xs text-gray-500 mb-1">
                        <span>${priorities[p.priority] || p.priority}</span>
                        <span class="font-semibold text-gray-700">${p.count} <span class="text-gray-400">(${pct}%)</span></span>
                    </div>
                    <div class="w-full bg-gray-100 rounded-full h-1.5">
                        <div class="${prioColors[p.priority] || 'bg-gray-400'} h-1.5 rounded-full" style="width:${pct}%"></div>
                    </div>
                </div>`;
            }).join('')}
        </div>`;

    // agents table
    const agentsTable = agents.length ? `
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-6">
            <div class="px-5 py-3 border-b border-gray-100">
                <h3 class="text-sm font-semibold text-gray-700">Performance des agents</h3>
            </div>
            <table class="w-full text-sm">
                <thead class="bg-gray-50">
                    <tr class="text-left text-xs text-gray-500 uppercase">
                        <th class="px-4 py-3 font-medium">Agent</th>
                        <th class="px-4 py-3 font-medium">Statut</th>
                        <th class="px-4 py-3 font-medium text-right">Traitées</th>
                        <th class="px-4 py-3 font-medium text-right">Actives</th>
                        <th class="px-4 py-3 font-medium">Charge</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                    ${agents.map(a => {
                        const chargePct = Math.min(100, a.charge_pct || 0);
                        const barColor  = chargePct >= 90 ? 'bg-red-500' : chargePct >= 60 ? 'bg-amber-400' : 'bg-[#25D366]';
                        return `<tr class="hover:bg-gray-50">
                            <td class="px-4 py-2.5 font-medium text-gray-800">${escHtml(a.name)}</td>
                            <td class="px-4 py-2.5">
                                <span class="text-xs px-2 py-0.5 rounded-full ${a.status === 'available' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}">${escHtml(a.status)}</span>
                            </td>
                            <td class="px-4 py-2.5 text-right text-gray-600">${a.conversations_traitees}</td>
                            <td class="px-4 py-2.5 text-right text-gray-600">${a.actives || 0}</td>
                            <td class="px-4 py-2.5 w-32">
                                <div class="flex items-center gap-2">
                                    <div class="flex-1 bg-gray-100 rounded-full h-1.5">
                                        <div class="${barColor} h-1.5 rounded-full" style="width:${chargePct}%"></div>
                                    </div>
                                    <span class="text-xs text-gray-400 w-8 text-right">${chargePct}%</span>
                                </div>
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>` : '';

    const sparkData  = (data.last_7_days || []).map(d => d.count);
    const convTrend  = calcTrend(data.last_7_days || []);

    container.innerHTML = `
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            ${metric("Conversations aujourd'hui", data.conversations_today ?? 0,
                '<i class="fa-solid fa-comments text-[#3B82F6] text-sm"></i>', '#3B82F6',
                sparkData, convTrend)}
            ${metric('Conversations actives', data.conversations_active ?? 0,
                '<i class="fa-solid fa-bolt text-[#25D366] text-sm"></i>', '#25D366',
                [], null)}
            ${metric('Taux de résolution', (data.resolution_rate ?? 0) + '%',
                '<i class="fa-solid fa-circle-check text-[#8B5CF6] text-sm"></i>', '#8B5CF6',
                [], null)}
            ${metric('Temps moy. réponse', (data.avg_response_minutes ?? 0) + ' min',
                '<i class="fa-solid fa-clock text-[#F97316] text-sm"></i>', '#F97316',
                [], null)}
        </div>
        ${barChart}
        ${agentsTable}
        <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
                <h3 class="text-sm font-semibold text-gray-700 mb-3">Par statut</h3>
                ${(data.by_status || []).map(s => `
                <div class="flex items-center justify-between text-sm mb-2 last:mb-0">
                    <span class="text-gray-500 capitalize">${escHtml(s.status)}</span>
                    <span class="font-semibold text-gray-800">${s.count}</span>
                </div>`).join('')}
            </div>
            ${prioChart}
        </div>
        <div class="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm mb-6">
            <h3 class="text-sm font-semibold text-gray-700 mb-1">Adoption IA</h3>
            <div class="text-4xl font-bold text-[#25D366] tracking-tight">${data.ai_adoption_rate}%</div>
            <div class="text-xs text-gray-400 mt-2">des suggestions utilisées</div>
        </div>`;
}

// ── Analytics helpers ─────────────────────────────────────────────────────
function sparkline(data, w = 64, h = 28, color = '#25D366') {
    if (!data || data.length < 2) return '';
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const step  = w / (data.length - 1);
    const pts   = data.map((v, i) => {
        const x = (i * step).toFixed(1);
        const y = (h - ((v - min) / range) * h * 0.82 - h * 0.09).toFixed(1);
        return `${x},${y}`;
    }).join(' ');
    // Area fill path
    const first = `0,${h}`;
    const last  = `${w},${h}`;
    const fill  = `${first} ${pts} ${last}`;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".2"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
        <polygon points="${fill}" fill="url(#sg)"/>
        <polyline points="${pts}" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function calcTrend(days) {
    if (!days || days.length < 4) return null;
    const half   = Math.floor(days.length / 2);
    const prev   = days.slice(0, half).reduce((s, d) => s + (d.count || 0), 0);
    const curr   = days.slice(half).reduce((s, d)  => s + (d.count || 0), 0);
    if (!prev) return null;
    const pct = Math.round(((curr - prev) / prev) * 100);
    return { dir: pct > 3 ? 'up' : pct < -3 ? 'down' : 'flat', pct: Math.abs(pct) };
}

function trendBadge(trend) {
    if (!trend) return '';
    if (trend.dir === 'up')   return `<span class="trend-up"><i class="fa-solid fa-arrow-trend-up text-[9px]"></i>+${trend.pct}%</span>`;
    if (trend.dir === 'down') return `<span class="trend-down"><i class="fa-solid fa-arrow-trend-down text-[9px]"></i>-${trend.pct}%</span>`;
    return `<span class="trend-flat">→ stable</span>`;
}

function metric(label, value, icon, iconBg, sparkData = [], trend = null) {
    const spark = sparkData.length >= 2 ? sparkline(sparkData) : '';
    return `<div class="kpi-card">
        ${spark ? `<div class="sparkline-wrap">${spark}</div>` : ''}
        <div class="kpi-icon" style="background:${iconBg}20;">${icon}</div>
        <div class="kpi-value">${value}</div>
        <div class="flex items-center justify-between mt-2 gap-2">
            <div class="kpi-label">${label}</div>
            ${trend ? trendBadge(trend) : ''}
        </div>
    </div>`;
}

// ── Auth ──────────────────────────────────────────────────────────────────
let _pendingToken = null; // set when server returns requires_2fa: true

async function login(e) {
    e.preventDefault();
    const form  = e.target;
    const email = form.email.value.trim();
    const pass  = form.password.value;
    const btn   = form.querySelector('button[type=submit]');

    btn.disabled    = true;
    btn.textContent = 'Connexion...';

    try {
        const data = await API.post('/api/auth/login', { email, password: pass });

        if (data.requires_2fa) {
            _pendingToken = data.pending_token;
            document.getElementById('login-step-1').classList.add('hidden');
            document.getElementById('login-step-2').classList.remove('hidden');
            setTimeout(() => document.getElementById('otp-input')?.focus(), 50);
            return;
        }

        _finishLogin(data);
    } catch (err) {
        showToast('Erreur', err.message, 'error');
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Se connecter';
    }
}

async function submitOtp(e) {
    e.preventDefault();
    const code = document.getElementById('otp-input')?.value.trim();
    const btn  = e.target.querySelector('button[type=submit]');
    if (!code || !_pendingToken) return;

    btn.disabled    = true;
    btn.textContent = 'Vérification...';

    try {
        const data = await API.post('/api/auth/2fa/verify', { pending_token: _pendingToken, code });
        _pendingToken = null;
        _finishLogin(data);
    } catch (err) {
        showToast('Code invalide', err.message, 'error');
        document.getElementById('otp-input').value = '';
        document.getElementById('otp-input').focus();
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Vérifier';
    }
}

function cancelOtp() {
    _pendingToken = null;
    document.getElementById('otp-input').value = '';
    document.getElementById('login-step-2').classList.add('hidden');
    document.getElementById('login-step-1').classList.remove('hidden');
}

function _finishLogin(data) {
    localStorage.setItem('token', data.token);
    State.user = data.user;
    scheduleTokenRefresh();
    initApp();
}

async function logout() {
    try { await API.post('/api/auth/logout', {}); } catch {}
    localStorage.clear();
    State.sse?.es?.close();
    location.reload();
}

// ── Utils ─────────────────────────────────────────────────────────────────
function scrollToBottom() {
    const c = document.getElementById('messages-container');
    if (c) c.scrollTop = c.scrollHeight;
    State.newMsgCount = 0;
    _updateNewMsgBanner();
}

function updateUnreadBadge() {
    const badge = document.getElementById('unread-badge');
    if (!badge) return;
    badge.textContent = State.unreadCount;
    badge.classList.toggle('hidden', State.unreadCount === 0);
    _pulseBadge(badge);
}

function formatTime(ts) {
    if (!ts) return '';
    const d   = new Date(ts.replace(' ', 'T'));
    const now  = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60)   return 'À l\'instant';
    if (diff < 3600) return Math.floor(diff / 60) + 'min';
    if (diff < 86400) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(str) {
    return String(str).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

function showToast(title, msg, type = 'info') {
    const styles = {
        info:    { bar: 'bg-blue-500',    icon: 'ℹ', bg: 'bg-white border-blue-200'    },
        success: { bar: 'bg-[#25D366]',   icon: '✓', bg: 'bg-white border-green-200'   },
        error:   { bar: 'bg-red-500',     icon: '✕', bg: 'bg-white border-red-200'      },
        warning: { bar: 'bg-amber-400',   icon: '!', bg: 'bg-white border-amber-200'    },
    };
    const s = styles[type] || styles.info;
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `pointer-events-auto flex items-start gap-3 ${s.bg} border rounded-xl shadow-xl px-4 py-3 max-w-xs`;
    el.style.cssText = 'animation:slideIn .2s ease';
    el.innerHTML = `
        <div class="w-1 self-stretch rounded-full ${s.bar} flex-shrink-0"></div>
        <div class="flex-1 min-w-0">
            <div class="font-semibold text-sm text-gray-800">${escHtml(title)}</div>
            ${msg ? `<div class="text-xs text-gray-500 mt-0.5 truncate">${escHtml(msg)}</div>` : ''}
        </div>
        <button onclick="this.parentElement.remove()" class="text-gray-300 hover:text-gray-500 flex-shrink-0 text-sm leading-none mt-0.5">✕</button>`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ── Statut connecté ───────────────────────────────────────────────────────
function toggleStatusDropdown() {
    document.getElementById('status-dropdown')?.classList.toggle('hidden');
}

function updateStatusUI(status) {
    const info      = STATUS_MAP[status] || STATUS_MAP.offline;
    const avatarDot = document.getElementById('status-dot');
    const btnDot    = document.getElementById('status-dot-btn');
    const label     = document.getElementById('status-label');
    if (avatarDot) avatarDot.className = `absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#0F172A] ${info.dot}`;
    if (btnDot)    btnDot.className    = `w-2 h-2 rounded-full flex-shrink-0 ${info.dot}`;
    if (label)     label.textContent   = info.label;
}

async function setMyStatus(status) {
    document.getElementById('status-dropdown')?.classList.add('hidden');
    if (!State.user) return;
    try {
        await API.put(`/api/agents/${State.user.id}/status`, { status });
        State.user.status = status;
        updateStatusUI(status);
        showToast('Statut', STATUS_MAP[status]?.label || status, 'success');
    } catch(e) { showToast('Erreur', e.message, 'error'); }
}

// ── Notifications ─────────────────────────────────────────────────────────
function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    badge.textContent = State.notifCount;
    badge.classList.toggle('hidden', State.notifCount === 0);
    _pulseBadge(badge);
}

async function loadNotifications() {
    State.notifCount = 0;
    updateNotifBadge();
    const container = document.getElementById('notifications-container');
    if (!container) return;
    container.innerHTML = `<div class="space-y-2 p-6">
        ${Array(5).fill(0).map(() => `
        <div class="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center gap-3">
            <div class="w-8 h-8 rounded-full skeleton flex-shrink-0"></div>
            <div class="flex-1 space-y-2">
                <div class="h-3 skeleton rounded-full w-2/3"></div>
                <div class="h-2.5 skeleton rounded-full w-1/3"></div>
            </div>
        </div>`).join('')}
    </div>`;
    try {
        const items = await API.get('/api/notifications');

        // Filter out high-volume low-signal events
        const FILTERED = new Set(['conversation:updated', 'message:status']);
        const meaningful = items.filter(n => !FILTERED.has(n.event_type));

        if (!meaningful.length) {
            container.innerHTML = `<div class="text-center text-gray-400 py-12">
                <i class="fa-regular fa-bell text-3xl mb-3 block text-gray-200"></i>
                Aucune notification
            </div>`;
            return;
        }

        // Group by calendar day
        const today     = new Date().toDateString();
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        const groups    = {};
        [...meaningful].reverse().forEach(n => {
            const d   = new Date((n.created_at || '').replace(' ', 'T'));
            const key = isNaN(d) ? 'Récent'
                      : d.toDateString() === today     ? "Aujourd'hui"
                      : d.toDateString() === yesterday ? 'Hier'
                      : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
            (groups[key] ??= []).push(n);
        });

        container.innerHTML = Object.entries(groups).map(([day, dayItems]) => `
            <div class="mb-4">
                <div class="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-2">${escHtml(day)}</div>
                <div class="space-y-1.5">
                    ${dayItems.map(n => {
                        const info    = notifInfo(n.event_type);
                        const payload = (() => { try { return JSON.parse(n.payload || '{}'); } catch { return {}; } })();
                        const detail  = payload.message || payload.display_name || payload.content || payload.name || '';
                        const d       = new Date((n.created_at || '').replace(' ', 'T'));
                        const time    = isNaN(d) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
                        return `<div class="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                            <span class="w-8 h-8 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center flex-shrink-0 text-sm">${info.emoji}</span>
                            <div class="flex-1 min-w-0">
                                <div class="font-medium text-sm text-gray-800">${info.title}</div>
                                ${detail ? `<div class="text-xs text-gray-400 mt-0.5 truncate">${escHtml(String(detail))}</div>` : ''}
                            </div>
                            <span class="text-xs text-gray-300 flex-shrink-0 tabular-nums">${time}</span>
                        </div>`;
                    }).join('')}
                </div>
            </div>`
        ).join('');
    } catch(e) { container.innerHTML = `<div class="text-sm text-red-500 text-center py-8">${escHtml(e.message)}</div>`; }
}

function notifInfo(type) {
    return {
        'conversation:new':     { emoji: '<i class="fa-solid fa-comments text-[#25D366]"></i>',        title: 'Nouvelle conversation' },
        'conversation:updated': { emoji: '<i class="fa-solid fa-arrows-rotate text-blue-500"></i>',     title: 'Conversation mise à jour' },
        'message:new':          { emoji: '<i class="fa-solid fa-envelope text-violet-500"></i>',        title: 'Nouveau message' },
        'agent:status':         { emoji: '<i class="fa-solid fa-user-circle text-gray-500"></i>',       title: 'Statut agent modifié' },
        'notification:admin':   { emoji: '<i class="fa-solid fa-triangle-exclamation text-amber-500"></i>', title: 'Alerte administrateur' },
    }[type] || { emoji: '<i class="fa-solid fa-bell text-gray-400"></i>', title: type };
}

// ── Audit Logs ─────────────────────────────────────────────────────────────
async function loadAuditLogs(actionFilter = '', dateFrom = '', userId = '') {
    const container = document.getElementById('audit-logs-container');
    if (!container) return;
    container.innerHTML = `<div class="p-6 space-y-2">
        ${Array(8).fill(0).map(() => `
        <div class="flex items-center gap-4 py-2 border-b border-gray-50">
            <div class="h-2.5 skeleton rounded-full w-20 flex-shrink-0"></div>
            <div class="h-2.5 skeleton rounded-full w-24"></div>
            <div class="h-2.5 skeleton rounded-full w-32"></div>
            <div class="h-2.5 skeleton rounded-full flex-1"></div>
        </div>`).join('')}
    </div>`;
    try {
        let path = '/api/audit-logs?per_page=50';
        if (actionFilter) path += `&action=${encodeURIComponent(actionFilter)}`;
        if (dateFrom)      path += `&date_from=${encodeURIComponent(dateFrom)}`;
        if (userId)        path += `&user_id=${encodeURIComponent(userId)}`;
        const data = await API.get(path);
        if (!data.items.length) {
            container.innerHTML = '<div class="p-6 text-center text-gray-400">Aucun log d\'audit</div>';
            return;
        }
        container.innerHTML = `<table class="w-full text-sm">
            <thead class="bg-gray-50 sticky top-0 z-10">
                <tr class="text-left text-gray-500 text-xs uppercase">
                    <th class="px-4 py-3 font-medium">Date</th>
                    <th class="px-4 py-3 font-medium">Utilisateur</th>
                    <th class="px-4 py-3 font-medium">Action</th>
                    <th class="px-4 py-3 font-medium">Entité</th>
                    <th class="px-4 py-3 font-medium">Détails</th>
                    <th class="px-4 py-3 font-medium">IP</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
                ${data.items.map(l => {
                    let detailsHtml = '—';
                    if (l.details) {
                        try {
                            const d = typeof l.details === 'string' ? JSON.parse(l.details) : l.details;
                            const entries = Object.entries(d).map(([k, v]) =>
                                `<span class="inline-block mr-1"><span class="text-gray-400">${escHtml(k)}:</span> ${escHtml(String(v))}</span>`
                            ).join('');
                            detailsHtml = `<span class="text-xs">${entries}</span>`;
                        } catch { detailsHtml = `<span class="text-xs font-mono">${escHtml(String(l.details).slice(0, 60))}</span>`; }
                    }
                    return `<tr class="hover:bg-gray-50">
                    <td class="px-4 py-2.5 text-gray-400 whitespace-nowrap text-xs">${formatTime(l.created_at)}</td>
                    <td class="px-4 py-2.5 font-medium text-gray-700">${escHtml(l.user_name || '—')}</td>
                    <td class="px-4 py-2.5"><span class="px-2 py-0.5 bg-[#E7F8EE] text-[#075E54] rounded text-xs font-mono">${escHtml(l.action)}</span></td>
                    <td class="px-4 py-2.5 text-gray-500 text-xs">${l.entity_type ? escHtml(l.entity_type + ' #' + l.entity_id) : '—'}</td>
                    <td class="px-4 py-2.5 text-gray-500 max-w-xs">${detailsHtml}</td>
                    <td class="px-4 py-2.5 text-gray-400 font-mono text-xs">${escHtml(l.ip_address || '—')}</td>
                </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    } catch(e) { container.innerHTML = `<div class="p-6 text-sm text-red-500">${escHtml(e.message)}</div>`; }
}

function filterAuditLogs(q) {
    clearTimeout(filterAuditLogs._t);
    const dateFrom = document.getElementById('audit-date-from')?.value || '';
    const userId   = document.getElementById('audit-user-id')?.value   || '';
    filterAuditLogs._t = setTimeout(() => loadAuditLogs(q.trim(), dateFrom, userId), 300);
}

function filterAuditDate() {
    const action   = document.getElementById('audit-filter')?.value     || '';
    const dateFrom = document.getElementById('audit-date-from')?.value  || '';
    const userId   = document.getElementById('audit-user-id')?.value    || '';
    loadAuditLogs(action.trim(), dateFrom, userId);
}

async function exportAuditLogsCSV() {
    const action   = document.getElementById('audit-filter')?.value    || '';
    const dateFrom = document.getElementById('audit-date-from')?.value || '';
    const userId   = document.getElementById('audit-user-id')?.value   || '';

    try {
        let path = '/api/audit-logs?per_page=1000';
        if (action.trim()) path += `&action=${encodeURIComponent(action.trim())}`;
        if (dateFrom)       path += `&date_from=${encodeURIComponent(dateFrom)}`;
        if (userId)         path += `&user_id=${encodeURIComponent(userId)}`;

        const data = await API.get(path);
        const rows = [
            ['Date', 'Utilisateur', 'Action', 'Entité', 'ID entité', 'Détails', 'IP'],
            ...data.items.map(l => [
                l.created_at || '',
                l.user_name  || '',
                l.action     || '',
                l.entity_type || '',
                l.entity_id  ?? '',
                l.details ? JSON.stringify(l.details).replace(/"/g, '""') : '',
                l.ip_address || '',
            ]),
        ];
        const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `audit_logs_${new Date().toISOString().slice(0,10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch(e) { showToast('Export échoué', e.message, 'error'); }
}

// ── Export Conversations CSV ────────────────────────────────────────────────
function openExportModal() {
    const modal = document.getElementById('export-modal');
    if (!modal) return;
    // Pre-fill default date range: last 30 days
    const to   = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 30);
    const fmt = d => d.toISOString().slice(0, 10);
    document.getElementById('export-from').value = fmt(from);
    document.getElementById('export-to').value   = fmt(to);
    // Mirror current filter tab selection
    const activeFilter = document.querySelector('.filter-btn.bg-\\[\\#25D366\\]')?.dataset.filter || 'all';
    const sel = document.getElementById('export-status');
    if (sel) sel.value = activeFilter !== 'all' ? activeFilter : 'all';
    modal.classList.remove('hidden');
}

function closeExportModal() {
    document.getElementById('export-modal')?.classList.add('hidden');
}

async function runExportCSV() {
    const status = document.getElementById('export-status')?.value || 'all';
    const from   = document.getElementById('export-from')?.value   || '';
    const to     = document.getElementById('export-to')?.value     || '';

    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (from)  params.set('from', from);
    if (to)    params.set('to',   to);

    try {
        const res = await fetch(`${API.baseURL}/api/export/conversations?${params}`, {
            headers: { Authorization: 'Bearer ' + (API.token() || '') },
        });
        if (!res.ok) { showToast('Export échoué', 'Erreur serveur', 'error'); return; }
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `conversations_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        closeExportModal();
    } catch (e) { showToast('Export échoué', e.message, 'error'); }
}

// ── AI Config ──────────────────────────────────────────────────────────────
async function loadAIConfig() {
    const container = document.getElementById('ai-config-container');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-gray-400 py-8">Chargement...</div>';
    try {
        const d = await API.get('/api/ai/config');
        container.innerHTML = `<div class="max-w-xl space-y-4">
            <div class="bg-white border border-gray-200 rounded-xl p-5">
                <h3 class="font-semibold text-gray-800 mb-4">Connexion Gemini API</h3>
                <div class="space-y-3 text-sm">
                    <div class="flex justify-between items-center py-2 border-b border-gray-100">
                        <span class="text-gray-600">Modèle</span>
                        <span class="font-mono bg-gray-100 px-2 py-0.5 rounded text-xs">${escHtml(d.model)}</span>
                    </div>
                    <div class="flex justify-between items-center py-2 border-b border-gray-100">
                        <span class="text-gray-600">Clé API</span>
                        <span class="font-mono ${d.api_key_set ? 'text-green-700' : 'text-red-500'} text-xs">${escHtml(d.api_key_hint)}</span>
                    </div>
                    <div class="flex justify-between items-center py-2">
                        <span class="text-gray-600">Max tokens</span>
                        <span class="text-gray-700">${d.max_tokens}</span>
                    </div>
                </div>
                <button onclick="testAIConnection()" id="ai-test-btn"
                    class="mt-4 px-4 py-2 bg-[#25D366] text-white text-sm rounded-lg hover:bg-[#1DA851] transition-colors">
                    Tester la connexion
                </button>
                <div id="ai-test-result" class="mt-3 text-sm"></div>
            </div>
            <div class="bg-white border border-gray-200 rounded-xl p-5">
                <h3 class="font-semibold text-gray-800 mb-4">Statistiques</h3>
                <div class="grid grid-cols-2 gap-4">
                    <div class="text-center p-3 bg-[#E7F8EE] rounded-lg">
                        <div class="text-2xl font-bold text-[#075E54]">${d.total_suggestions}</div>
                        <div class="text-xs text-gray-500 mt-1">Suggestions générées</div>
                    </div>
                    <div class="text-center p-3 bg-green-50 rounded-lg">
                        <div class="text-2xl font-bold text-green-700">${d.adoption_rate}%</div>
                        <div class="text-xs text-gray-500 mt-1">Taux d'adoption</div>
                    </div>
                </div>
            </div>
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                <strong>Configurer la clé API :</strong> ajoutez
                <code class="bg-amber-100 px-1 rounded">GEMINI_API_KEY=votre_clé</code>
                dans le fichier <code class="bg-amber-100 px-1 rounded">.env</code> à la racine du projet.
            </div>
        </div>`;
    } catch(e) { container.innerHTML = `<div class="text-sm text-red-500 py-8 text-center">${escHtml(e.message)}</div>`; }
}

async function testAIConnection() {
    const btn = document.getElementById('ai-test-btn');
    const res = document.getElementById('ai-test-result');
    if (!btn || !res) return;
    btn.disabled = true;
    btn.textContent = 'Test en cours...';
    res.textContent = '';
    try {
        const d = await API.post('/api/ai/config/test', {});
        res.innerHTML = d.ok
            ? `<span class="text-green-600">✅ ${escHtml(d.message)}</span>`
            : `<span class="text-red-600">❌ ${escHtml(d.message)}</span>`;
    } catch(e) {
        res.innerHTML = `<span class="text-red-600">❌ ${escHtml(e.message)}</span>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Tester la connexion';
    }
}

// ── Bridge Control Panel ──────────────────────────────────────────────────

let _bridgeRefreshTimer = null;

function initBridgePanel() {
    loadBridgeStatus();
    loadBridgeLogs();
    if (document.getElementById('bridge-auto-refresh')?.checked) {
        _startBridgeAutoRefresh();
    }
}

function toggleBridgeAutoRefresh(enabled) {
    if (enabled) _startBridgeAutoRefresh();
    else         _stopBridgeAutoRefresh();
}

function _startBridgeAutoRefresh() {
    _stopBridgeAutoRefresh();
    _bridgeRefreshTimer = setInterval(() => {
        loadBridgeStatus();
        loadBridgeLogs();
    }, 4000);
}

function _stopBridgeAutoRefresh() {
    if (_bridgeRefreshTimer) { clearInterval(_bridgeRefreshTimer); _bridgeRefreshTimer = null; }
}

async function loadBridgeStatus() {
    const icon = document.getElementById('bridge-refresh-icon');
    icon?.classList.add('fa-spin');
    try {
        const s = await API.get('/api/bridge/status');
        _renderBridgeStatus(s);
    } catch (e) {
        _renderBridgeStatus({ running: false, connected: false, phone: null });
    } finally {
        icon?.classList.remove('fa-spin');
    }
}

function _renderBridgeStatus(s) {
    const procDot   = document.getElementById('bridge-proc-dot');
    const procLabel = document.getElementById('bridge-proc-label');
    const connDot   = document.getElementById('bridge-conn-dot');
    const connLabel = document.getElementById('bridge-conn-label');
    const phone     = document.getElementById('bridge-phone-label');
    const btnStart  = document.getElementById('btn-bridge-start');
    const btnStop   = document.getElementById('btn-bridge-stop');
    const btnRestart= document.getElementById('btn-bridge-restart');
    const qrSection = document.getElementById('bridge-qr-section');

    if (procDot && procLabel) {
        procDot.className     = `w-3 h-3 rounded-full flex-shrink-0 ${s.running ? 'bg-emerald-400' : 'bg-gray-300'}`;
        procLabel.textContent = s.running ? `En marche (PID ${s.pid})` : 'Arrêté';
    }
    if (connDot && connLabel) {
        connDot.className     = `w-3 h-3 rounded-full flex-shrink-0 ${s.connected ? 'bg-[#25D366]' : (s.running ? 'bg-amber-400' : 'bg-gray-300')}`;
        connLabel.textContent = s.connected ? 'Connecté' : (s.running ? 'En attente…' : 'Non connecté');
    }
    if (phone) phone.textContent = s.phone || '—';

    if (btnStart)   btnStart.disabled   = s.running;
    if (btnStop)    btnStop.disabled    = !s.running;
    if (btnRestart) btnRestart.disabled = false;

    // QR code: show only when bridge is running but WhatsApp not yet paired
    if (qrSection) {
        if (s.running && !s.connected) {
            qrSection.classList.remove('hidden');
            _loadBridgeQR();
        } else {
            qrSection.classList.add('hidden');
        }
    }
}

async function _loadBridgeQR() {
    const imgEl = document.getElementById('bridge-qr-img');
    if (!imgEl) return;
    try {
        const qr = await API.get('/api/whatsapp/qr');
        if (qr.qr) {
            imgEl.innerHTML = `<img src="${qr.qr}" alt="QR Code WhatsApp" class="w-44 h-44 rounded">`;
        } else {
            imgEl.innerHTML = `<div class="text-center text-xs text-gray-400 px-3">
                <i class="fa-solid fa-clock text-2xl mb-2 block text-amber-400"></i>
                QR en cours de génération…
            </div>`;
        }
    } catch {
        imgEl.innerHTML = `<div class="text-center text-xs text-gray-400 px-3">
            <i class="fa-solid fa-triangle-exclamation text-2xl mb-2 block text-red-400"></i>
            QR indisponible
        </div>`;
    }
}

async function bridgeAction(action) {
    const spinner = document.getElementById('bridge-action-spinner');
    const msgEl   = document.getElementById('bridge-action-msg');
    const result  = document.getElementById('bridge-action-result');
    const labels  = { start: 'Démarrage…', stop: 'Arrêt…', restart: 'Redémarrage…' };

    // Désactiver tous les boutons, afficher spinner
    ['start','stop','restart'].forEach(a => {
        const b = document.getElementById(`btn-bridge-${a}`);
        if (b) b.disabled = true;
    });
    spinner?.classList.replace('hidden','flex');
    if (msgEl) msgEl.textContent = labels[action] || 'Traitement…';
    result?.classList.add('hidden');

    try {
        const data = await API.post(`/api/bridge/${action}`, {});
        result?.classList.remove('hidden');
        result.className = 'mt-3 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-700 border border-green-200';

        const confirmed = action === 'stop' ? true : (data.started || data.restarted);
        const msgs = {
            start:   confirmed ? `Bridge démarré (PID ${data.pid})` : 'Démarrage en cours…',
            stop:    `Bridge arrêté`,
            restart: confirmed ? `Bridge redémarré (PID ${data.pid})` : 'Redémarrage en cours…',
        };
        result.textContent = msgs[action] || 'OK';
        showToast('Bridge', result.textContent, 'success');

        // If not yet confirmed, poll status until it comes up (max 20s)
        if (!confirmed && (action === 'start' || action === 'restart')) {
            _pollBridgeUntilRunning(10);
        }
    } catch (e) {
        result?.classList.remove('hidden');
        result.className = 'mt-3 px-3 py-2 rounded-lg text-sm bg-red-50 text-red-700 border border-red-200';
        result.textContent = e.message;
        showToast('Erreur bridge', e.message, 'error');
    } finally {
        spinner?.classList.replace('flex','hidden');
        setTimeout(() => loadBridgeStatus(), 500);
        setTimeout(() => loadBridgeLogs(), 1500);
    }
}

async function _pollBridgeUntilRunning(maxAttempts) {
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const s = await API.get('/api/bridge/status');
            loadBridgeStatus();
            loadBridgeLogs();
            if (s.running) {
                const result = document.getElementById('bridge-action-result');
                if (result) {
                    result.className = 'mt-3 px-3 py-2 rounded-lg text-sm bg-green-50 text-green-700 border border-green-200';
                    result.textContent = `Bridge démarré (PID ${s.pid})`;
                    result.classList.remove('hidden');
                }
                showToast('Bridge', `Bridge démarré (PID ${s.pid})`, 'success');
                return;
            }
        } catch {}
    }
}

async function loadBridgeLogs() {
    try {
        const data = await API.get('/api/bridge/logs?lines=200');
        _renderBridgeLogs(data.lines || [], data.total || 0);
    } catch {
        // silencieux si la vue n'est pas visible
    }
}

function _renderBridgeLogs(lines, total) {
    const output = document.getElementById('bridge-log-output');
    const count  = document.getElementById('bridge-log-count');
    if (!output) return;

    if (count) count.textContent = total > 200 ? `(200 / ${total} lignes)` : `(${total} lignes)`;

    if (!lines.length) {
        output.innerHTML = '<span class="text-slate-500 italic">Aucun log disponible — démarrez le bridge pour voir les logs.</span>';
        return;
    }

    const html = lines.map(line => {
        const esc  = escHtml(line);
        if (/ERROR|❌|FAILED|UNCONFIRMED/i.test(line))       return `<span class="text-red-400">${esc}</span>`;
        if (/WARN|⚠|warn/i.test(line))                       return `<span class="text-amber-400">${esc}</span>`;
        if (/✅|CONFIRMED|ready|connect/i.test(line))        return `<span class="text-emerald-400">${esc}</span>`;
        if (/📤|📨|\/send|INFO/i.test(line)) return `<span class="text-sky-400">${esc}</span>`;
        if (/\[bridge\]|🌉/i.test(line))               return `<span class="text-teal-400">${esc}</span>`;
        return `<span class="text-slate-300">${esc}</span>`;
    }).join('\n');

    const wasAtBottom = output.scrollHeight - output.scrollTop <= output.clientHeight + 40;
    output.innerHTML = html;
    if (wasAtBottom) output.scrollTop = output.scrollHeight;
}

async function bridgeClearLogs() {
    if (!confirm('Effacer tous les logs du bridge ?')) return;
    try {
        await API.delete('/api/bridge/logs');
        loadBridgeLogs();
        showToast('Logs effacés', '', 'success');
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

// Arrêter l'auto-refresh quand on quitte la vue bridge
const _origShowMainView = window.showMainView;

// ══════════════════════════════════════════════════════════════════════════
// PRODUCTIVITY FEATURES — Tags · AI bar · Global search · Cmd palette · Tabs
// ══════════════════════════════════════════════════════════════════════════

// ── Tags ──────────────────────────────────────────────────────────────────
const TAG_CONFIG = {
    urgent:    { label: 'Urgent',    bg: 'bg-red-100',    text: 'text-red-700',    dot: '#EF4444' },
    paiement:  { label: 'Paiement',  bg: 'bg-green-100',  text: 'text-green-700',  dot: '#16A34A' },
    livraison: { label: 'Livraison', bg: 'bg-blue-100',   text: 'text-blue-700',   dot: '#2563EB' },
    vip:       { label: 'VIP',       bg: 'bg-purple-100', text: 'text-purple-700', dot: '#7C3AED' },
    bug:       { label: 'Bug',       bg: 'bg-orange-100', text: 'text-orange-700', dot: '#EA580C' },
};
const ALL_TAGS = Object.keys(TAG_CONFIG);

function parseTags(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val); } catch { return []; }
}

function renderTagPills(tags, small = true) {
    const list = parseTags(tags);
    if (!list.length) return '';
    return list.map(t => {
        const cfg = TAG_CONFIG[t] || { label: t, bg: 'bg-gray-100', text: 'text-gray-600' };
        return `<span class="tag-pill ${cfg.bg} ${cfg.text}">${escHtml(cfg.label)}</span>`;
    }).join('');
}

async function toggleConvTag(convId, tag) {
    const conv = State.conversations.find(c => c.id === convId);
    if (!conv) return;
    const current = parseTags(conv.tags);
    const next    = current.includes(tag)
        ? current.filter(t => t !== tag)
        : [...current, tag];
    try {
        await API.put(`/api/conversations/${convId}/tags`, { tags: next });
        conv.tags = next;
        renderConversationList();
        const cur = State.conversations.find(c => c.id === State.currentConvId);
        if (cur && cur.id === convId) renderChatHeader(cur);
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

function renderTagEditor(conv) {
    const current = parseTags(conv.tags);
    return `<div class="flex items-center gap-1 flex-wrap">
        ${ALL_TAGS.map(t => {
            const cfg = TAG_CONFIG[t];
            const active = current.includes(t);
            return `<button onclick="toggleConvTag(${conv.id}, '${t}')"
                class="tag-pill cursor-pointer border transition-all ${active ? `${cfg.bg} ${cfg.text} border-transparent` : 'bg-transparent text-[#8696A0] border-[#E9EDEF] hover:border-gray-300'}">
                ${escHtml(cfg.label)}
            </button>`;
        }).join('')}
    </div>`;
}

// ── AI Context Bar ────────────────────────────────────────────────────────
function renderAIContextBar(conv) {
    const bar = document.getElementById('ai-context-bar');
    if (!bar) return;

    const hasSentiment = conv.ai_sentiment;
    const hasIntent    = conv.ai_intent;
    const hasSummary   = conv.ai_summary;

    if (!hasSentiment && !hasIntent && !hasSummary) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');

    const sentMap = {
        positive: { icon: 'fa-face-smile',   cls: 'ai-sent-pos', label: 'Positif' },
        negative: { icon: 'fa-face-frown',   cls: 'ai-sent-neg', label: 'Négatif' },
        neutral:  { icon: 'fa-face-meh',     cls: 'ai-sent-neu', label: 'Neutre' },
        urgent:   { icon: 'fa-circle-exclamation', cls: 'ai-sent-neg', label: 'Urgent' },
    };
    const sent   = sentMap[conv.ai_sentiment] || sentMap.neutral;
    const qualPct = conv.ai_quality != null ? Math.round(conv.ai_quality * 100) + '%' : null;

    bar.innerHTML = `
        <div class="flex items-center gap-3 px-3 py-1.5 flex-wrap">
            <span class="flex items-center gap-1 text-[11px] font-semibold ${sent.cls}">
                <i class="fa-regular ${sent.icon}"></i>${sent.label}
            </span>
            ${hasIntent ? `<span class="text-[11px] text-violet-700 font-medium truncate max-w-[200px]" title="${escAttr(conv.ai_intent)}">
                <i class="fa-solid fa-lightbulb text-[9px] mr-0.5"></i>${escHtml(conv.ai_intent)}
            </span>` : ''}
            ${hasSummary ? `<span class="text-[11px] text-[#54656F] truncate flex-1 min-w-0" title="${escAttr(conv.ai_summary)}">
                ${escHtml(String(conv.ai_summary).slice(0, 90))}${conv.ai_summary.length > 90 ? '…' : ''}
            </span>` : ''}
            ${qualPct ? `<span class="text-[11px] text-[#8696A0] flex-shrink-0">${qualPct}</span>` : ''}
            <button onclick="triggerAIAnalyze(${conv.id})"
                title="Ré-analyser avec l'IA"
                class="ml-auto flex-shrink-0 text-[10px] text-violet-500 hover:text-violet-700 hover:bg-violet-100 px-2 py-0.5 rounded-full transition-colors">
                <i class="fa-solid fa-rotate text-[9px]"></i>
            </button>
        </div>`;
}

async function triggerAIAnalyze(convId) {
    try {
        showToast('IA', 'Analyse en cours…', 'info');
        const result = await API.post(`/api/ai/analyze/${convId}`, {});
        const conv   = State.conversations.find(c => c.id === convId);
        if (conv && result) {
            conv.ai_sentiment   = result.sentiment   ?? conv.ai_sentiment;
            conv.ai_intent      = result.intent      ?? conv.ai_intent;
            conv.ai_summary     = result.summary     ?? conv.ai_summary;
            conv.ai_quality     = result.quality     ?? conv.ai_quality;
            if (convId === State.currentConvId) renderAIContextBar(conv);
        }
        showToast('IA', 'Analyse terminée', 'success');
    } catch (e) { showToast('Erreur IA', e.message, 'error'); }
}

// ── Conversation Tabs ─────────────────────────────────────────────────────
function addConvTab(conv) {
    const id   = conv.id;
    const name = conv.effective_name || conv.custom_name || conv.display_name
               || conv.whatsapp_number || conv.whatsapp_jid?.split('@')[0] || '?';
    const existing = State.openTabs.findIndex(t => t.id === id);
    if (existing !== -1) {
        State.openTabs[existing].name = name;
    } else {
        State.openTabs.push({ id, name });
        if (State.openTabs.length > 7) State.openTabs.shift();
    }
    renderConvTabs();
}

function closeConvTab(e, id) {
    e.stopPropagation();
    State.openTabs = State.openTabs.filter(t => t.id !== id);
    if (State.currentConvId === id) {
        const last = State.openTabs[State.openTabs.length - 1];
        if (last) openConversation(last.id);
        else {
            State.currentConvId = null;
            document.getElementById('chat-panel')?.classList.add('hidden');
            document.getElementById('chat-empty')?.classList.remove('hidden');
        }
    }
    renderConvTabs();
}

function renderConvTabs() {
    const bar = document.getElementById('conv-tabs-bar');
    if (!bar) return;
    if (!State.openTabs.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = State.openTabs.map(t => `
        <div class="conv-tab ${t.id === State.currentConvId ? 'active' : ''}"
             onclick="openConversation(${t.id})" title="${escAttr(t.name)}">
            <span class="truncate">${escHtml(t.name)}</span>
            <span class="conv-tab-close" onclick="closeConvTab(event, ${t.id})">
                <i class="fa-solid fa-xmark text-[9px]"></i>
            </span>
        </div>`).join('');
}

// ── Global Search ─────────────────────────────────────────────────────────
let _gsQuery = '';
let _gsIndex = -1;

function openGlobalSearch() {
    const overlay = document.getElementById('global-search-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    const inp = document.getElementById('global-search-input');
    if (inp) { inp.value = ''; inp.focus(); }
    document.getElementById('global-search-results').innerHTML =
        '<p class="text-center text-[#8696A0] text-xs py-4">Tapez pour rechercher…</p>';
}

function closeGlobalSearch() {
    document.getElementById('global-search-overlay')?.classList.add('hidden');
}

function handleGlobalSearchKey(e) {
    const results = document.querySelectorAll('#global-search-results .gs-result');
    if (e.key === 'Escape') { closeGlobalSearch(); return; }
    if (e.key === 'ArrowDown') { _gsIndex = Math.min(_gsIndex + 1, results.length - 1); _highlightGS(results); e.preventDefault(); }
    if (e.key === 'ArrowUp')   { _gsIndex = Math.max(_gsIndex - 1, 0); _highlightGS(results); e.preventDefault(); }
    if (e.key === 'Enter' && _gsIndex >= 0) { results[_gsIndex]?.click(); }
}

function _highlightGS(results) {
    results.forEach((r, i) => r.classList.toggle('bg-[#F5F6F6]', i === _gsIndex));
}

const _debouncedGS = debounce(_doGlobalSearch, 280);

function runGlobalSearch(q) {
    _gsIndex = -1;
    _gsQuery = q.trim();
    if (!_gsQuery) {
        document.getElementById('global-search-results').innerHTML =
            '<p class="text-center text-[#8696A0] text-xs py-4">Tapez pour rechercher…</p>';
        return;
    }
    document.getElementById('global-search-results').innerHTML =
        '<p class="text-center text-[#8696A0] text-xs py-4"><i class="fa-solid fa-circle-notch fa-spin mr-1"></i>Recherche…</p>';
    _debouncedGS(_gsQuery);
}

function _gsExcerpt(text, q, maxLen = 110) {
    if (!text) return '';
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    let start = 0;
    if (idx > 40) { start = idx - 30; }
    let excerpt = (start > 0 ? '…' : '') + text.slice(start, start + maxLen) + (text.length > start + maxLen ? '…' : '');
    // Highlight the match
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escHtml(excerpt).replace(re, '<mark class="bg-yellow-100 text-yellow-800 rounded px-0.5 not-italic">$1</mark>');
}

async function _doGlobalSearch(q) {
    try {
        const [convData, contactData, msgData] = await Promise.all([
            API.get(`/api/conversations?search=${encodeURIComponent(q)}&per_page=6`),
            API.get(`/api/contacts?search=${encodeURIComponent(q)}&per_page=5`),
            API.get(`/api/messages/search?q=${encodeURIComponent(q)}&limit=8`),
        ]);
        const container = document.getElementById('global-search-results');
        if (!container) return;

        let html = '';

        if (convData.items?.length) {
            html += `<p class="px-4 pt-2 pb-1 text-[10px] font-semibold text-[#8696A0] uppercase tracking-wide">Conversations</p>`;
            html += convData.items.map(c => {
                const name = c.effective_name || c.custom_name || c.display_name || c.whatsapp_number || '?';
                const last = escHtml(String(c.last_message || c.status || '').slice(0, 55));
                return `<div class="gs-result" onclick="closeGlobalSearch(); openConversation(${c.id})">
                    <div class="w-8 h-8 rounded-full bg-[#DFE5E7] text-[#54656F] flex items-center justify-center text-sm font-semibold flex-shrink-0">${escHtml(name[0]?.toUpperCase() || '?')}</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-[#111B21] truncate">${escHtml(name)}</div>
                        <div class="text-xs text-[#8696A0] truncate">${last}</div>
                    </div>
                    <span class="text-[10px] text-[#8696A0] flex-shrink-0">${formatTime(c.last_message_at)}</span>
                </div>`;
            }).join('');
        }

        if (contactData.items?.length) {
            html += `<p class="px-4 pt-3 pb-1 text-[10px] font-semibold text-[#8696A0] uppercase tracking-wide">Contacts</p>`;
            html += contactData.items.map(ct => {
                const name = ct.custom_name || ct.display_name || ct.whatsapp_number || ct.whatsapp_jid || '?';
                return `<div class="gs-result" onclick="closeGlobalSearch(); loadContactConversations(${ct.id}, '${escAttr(name)}')">
                    <div class="w-8 h-8 rounded-full bg-[#DFE5E7] text-[#54656F] flex items-center justify-center text-sm font-semibold flex-shrink-0">${escHtml(name[0]?.toUpperCase() || '?')}</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-[#111B21] truncate">${escHtml(name)}</div>
                        <div class="text-xs text-[#8696A0]">${escHtml(ct.whatsapp_number || ct.whatsapp_jid || '')}</div>
                    </div>
                </div>`;
            }).join('');
        }

        if (Array.isArray(msgData) && msgData.length) {
            html += `<p class="px-4 pt-3 pb-1 text-[10px] font-semibold text-[#8696A0] uppercase tracking-wide">Messages</p>`;
            html += msgData.map(m => {
                const name    = escHtml(m.contact_name || '?');
                const excerpt = _gsExcerpt(m.content, q);
                const icon    = m.type === 'note'
                    ? `<i class="fa-solid fa-note-sticky text-amber-500 text-xs"></i>`
                    : m.sender_type === 'agent'
                    ? `<i class="fa-solid fa-headset text-[#25D366] text-xs"></i>`
                    : `<i class="fa-solid fa-user text-[#8696A0] text-xs"></i>`;
                return `<div class="gs-result" onclick="closeGlobalSearch(); openConversation(${m.conversation_id})">
                    <div class="w-8 h-8 rounded-full bg-[#F0FDF4] flex items-center justify-center flex-shrink-0">${icon}</div>
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-semibold text-[#111B21] truncate mb-0.5">${name}</div>
                        <div class="text-xs text-[#667781] leading-snug line-clamp-2">${excerpt}</div>
                    </div>
                    <span class="text-[10px] text-[#8696A0] flex-shrink-0 self-start mt-0.5">${formatTime(m.sent_at)}</span>
                </div>`;
            }).join('');
        }

        container.innerHTML = html ||
            `<p class="text-center text-[#8696A0] text-xs py-6">Aucun résultat pour "${escHtml(q)}"</p>`;
    } catch {}
}

function loadContactConversations(contactId, name) {
    document.getElementById('conv-search').value = name;
    triggerNav('conversations');
    debouncedConvSearch();
}

// ── Command Palette ────────────────────────────────────────────────────────
let _cmdIndex = -1;
let _cmdFiltered = [];

const COMMANDS = [
    { icon: 'fa-magnifying-glass',       label: 'Recherche globale',           kbd: 'Ctrl+/',  action: () => { closeCmdPalette(); openGlobalSearch(); } },
    { icon: 'fa-comments',               label: 'Aller aux conversations',      action: () => { closeCmdPalette(); triggerNav('conversations'); } },
    { icon: 'fa-users',                  label: 'Aller aux contacts',           action: () => { closeCmdPalette(); triggerNav('contacts'); } },
    { icon: 'fa-chart-bar',              label: 'Analytics',                    action: () => { closeCmdPalette(); triggerNav('analytics'); },     roles: ['admin','super_admin'] },
    { icon: 'fa-reply',                  label: 'Répondre (focus input)',        kbd: 'Alt+R',   action: () => { closeCmdPalette(); document.getElementById('msg-input')?.focus(); }, when: () => !!State.currentConvId },
    { icon: 'fa-pen-to-square',          label: 'Nouvelle note interne',        kbd: 'Alt+N',   action: () => { closeCmdPalette(); focusNoteInput(); },                               when: () => !!State.currentConvId },
    { icon: 'fa-hand-point-right',       label: 'Assigner à moi',              kbd: 'Alt+A',   action: () => { closeCmdPalette(); assignConvToMe(); },                              when: () => !!State.currentConvId },
    { icon: 'fa-circle-xmark',           label: 'Fermer la conversation',       kbd: 'Alt+C',   action: () => { closeCmdPalette(); if (State.currentConvId) closeConversation(State.currentConvId); }, when: () => !!State.currentConvId },
    { icon: 'fa-wand-magic-sparkles',    label: 'Analyser avec l\'IA',          action: () => { closeCmdPalette(); if (State.currentConvId) triggerAIAnalyze(State.currentConvId); }, when: () => !!State.currentConvId },
    { icon: 'fa-bolt',                   label: 'Suggestions IA',               action: () => { closeCmdPalette(); getSuggestions(); },                                             when: () => !!State.currentConvId },
    { icon: 'fa-eye-slash',              label: 'Mode focus',                   action: () => { closeCmdPalette(); toggleFocusMode(); } },
    { icon: 'fa-circle',                 label: 'Statut: Disponible',           action: () => { closeCmdPalette(); setMyStatus('available'); } },
    { icon: 'fa-circle',                 label: 'Statut: Occupé',               action: () => { closeCmdPalette(); setMyStatus('busy'); } },
    { icon: 'fa-circle',                 label: 'Statut: Inactif',              action: () => { closeCmdPalette(); setMyStatus('inactive'); } },
];

function openCmdPalette() {
    const overlay = document.getElementById('cmd-palette-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    const inp = document.getElementById('cmd-palette-input');
    if (inp) { inp.value = ''; inp.focus(); }
    _cmdIndex = -1;
    filterCmds('');
}

function closeCmdPalette() {
    document.getElementById('cmd-palette-overlay')?.classList.add('hidden');
}

function filterCmds(q) {
    const role = State.user?.role || '';
    const lower = q.toLowerCase();
    _cmdFiltered = COMMANDS.filter(c => {
        if (c.roles && !c.roles.includes(role)) return false;
        if (c.when && !c.when()) return false;
        return !lower || c.label.toLowerCase().includes(lower);
    });
    _cmdIndex = _cmdFiltered.length ? 0 : -1;
    _renderCmdList();
}

function _renderCmdList() {
    const list = document.getElementById('cmd-palette-list');
    if (!list) return;
    if (!_cmdFiltered.length) {
        list.innerHTML = '<p class="text-center text-[#8696A0] text-xs py-4">Aucune commande trouvée</p>';
        return;
    }
    list.innerHTML = _cmdFiltered.map((c, i) => `
        <div class="cmd-item ${i === _cmdIndex ? 'cmd-selected' : ''}" onclick="execCmd(${i})">
            <i class="fa-solid ${c.icon} text-[#8696A0] w-4 text-center text-sm flex-shrink-0"></i>
            <span>${escHtml(c.label)}</span>
            ${c.kbd ? `<kbd class="cmd-kbd">${c.kbd}</kbd>` : ''}
        </div>`).join('');
}

function execCmd(i) {
    const cmd = _cmdFiltered[i];
    if (cmd) cmd.action();
}

function handleCmdKey(e) {
    if (e.key === 'Escape') { closeCmdPalette(); return; }
    if (e.key === 'ArrowDown') { _cmdIndex = Math.min(_cmdIndex + 1, _cmdFiltered.length - 1); _renderCmdList(); e.preventDefault(); }
    if (e.key === 'ArrowUp')   { _cmdIndex = Math.max(_cmdIndex - 1, 0); _renderCmdList(); e.preventDefault(); }
    if (e.key === 'Enter' && _cmdIndex >= 0) execCmd(_cmdIndex);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
let _focusedConvIndex = -1;

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const tag     = document.activeElement?.tagName;
        const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);

        // ── Escape: close overlays in priority order ──────────────────────
        if (e.key === 'Escape') {
            if (!document.getElementById('shortcuts-overlay')?.classList.contains('hidden'))     { closeShortcutsHelp(); return; }
            if (!document.getElementById('export-modal')?.classList.contains('hidden'))          { closeExportModal();   return; }
            if (!document.getElementById('global-search-overlay')?.classList.contains('hidden')) { closeGlobalSearch();  return; }
            if (!document.getElementById('cmd-palette-overlay')?.classList.contains('hidden'))   { closeCmdPalette();    return; }
            if (State.selectedConvIds.size)                                                       { clearBulkSelection(); return; }
        }

        // ── Ctrl+K — command palette (allow in inputs too) ────────────────
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            const isOpen = !document.getElementById('cmd-palette-overlay')?.classList.contains('hidden');
            isOpen ? closeCmdPalette() : openCmdPalette();
            return;
        }

        // ── Ctrl+/ — global search ────────────────────────────────────────
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            e.preventDefault();
            const isOpen = !document.getElementById('global-search-overlay')?.classList.contains('hidden');
            isOpen ? closeGlobalSearch() : openGlobalSearch();
            return;
        }

        // ── Skip remaining shortcuts when typing ──────────────────────────
        if (inInput) return;

        // ── ? — shortcuts help ────────────────────────────────────────────
        if (e.key === '?') { e.preventDefault(); toggleShortcutsHelp(); return; }

        // ── / — focus conversation search ─────────────────────────────────
        if (e.key === '/') {
            e.preventDefault();
            const input = document.getElementById('conv-search');
            if (input) { input.focus(); input.select(); }
            return;
        }

        // ── 1-5 — switch filter tabs ──────────────────────────────────────
        const FILTER_MAP = { '1': 'all', '2': 'new', '3': 'ongoing', '4': 'waiting', '5': 'closed' };
        if (!e.altKey && !e.ctrlKey && !e.metaKey && FILTER_MAP[e.key]) {
            e.preventDefault();
            loadConversations(FILTER_MAP[e.key]);
            return;
        }

        // ── J / K — navigate conversation list ───────────────────────────
        if (e.key === 'j' || e.key === 'k') {
            e.preventDefault();
            const convs = State.conversations;
            if (!convs.length) return;
            if (e.key === 'j') _focusedConvIndex = Math.min(_focusedConvIndex + 1, convs.length - 1);
            else                _focusedConvIndex = Math.max(_focusedConvIndex - 1, 0);
            _highlightFocusedConv();
            return;
        }

        // ── Enter — open focused conversation ────────────────────────────
        if (e.key === 'Enter' && _focusedConvIndex >= 0) {
            e.preventDefault();
            const c = State.conversations[_focusedConvIndex];
            if (c) openConversation(c.id);
            return;
        }

        // ── Shortcuts requiring an open conversation ──────────────────────
        if (!State.currentConvId) return;

        if (e.altKey && e.key === 'c') { e.preventDefault(); closeConversation(State.currentConvId); }
        if (e.altKey && e.key === 'a') { e.preventDefault(); assignConvToMe(); }
        if (e.altKey && e.key === 'n') { e.preventDefault(); focusNoteInput(); }
        if (e.altKey && e.key === 'r') { e.preventDefault(); document.getElementById('msg-input')?.focus(); }
    });
}

function _highlightFocusedConv() {
    document.querySelectorAll('.wa-conv-item').forEach((el, i) => {
        el.classList.toggle('kbd-focused', i === _focusedConvIndex);
    });
    // Scroll into view
    const el = document.querySelectorAll('.wa-conv-item')[_focusedConvIndex];
    el?.scrollIntoView({ block: 'nearest' });
}

function toggleShortcutsHelp() {
    const el = document.getElementById('shortcuts-overlay');
    if (!el) return;
    el.classList.toggle('hidden');
}
function closeShortcutsHelp() {
    document.getElementById('shortcuts-overlay')?.classList.add('hidden');
}

function triggerNav(id) {
    document.querySelector(`[data-nav="${id}"]`)?.click();
}

function assignConvToMe() {
    if (!State.currentConvId) return;
    const userId = State.user?.id;
    if (!userId) return;
    assignAgent(State.currentConvId, userId);
}

// ── Typing indicators ─────────────────────────────────────────────────────
// _typingPeers[convId][agentId] = { name, timer }
const _typingPeers  = {};
let   _lastTypingSent = 0;   // timestamp of last outgoing typing signal
let   _typingStopTimer = null;

function setupTypingIndicator() {
    const input = document.getElementById('msg-input');
    if (!input) return;
    input.addEventListener('input', _onMsgTyping);
    input.addEventListener('blur',  () => _sendTypingSignal(false));
}

function _onMsgTyping() {
    if (!State.currentConvId || _noteMode) return;
    const now = Date.now();
    if (now - _lastTypingSent > 2000) {
        _sendTypingSignal(true);
        _lastTypingSent = now;
    }
    clearTimeout(_typingStopTimer);
    _typingStopTimer = setTimeout(() => {
        _sendTypingSignal(false);
        _lastTypingSent = 0;
    }, 3000);
}

async function _sendTypingSignal(isTyping) {
    const id = State.currentConvId;
    if (!id) return;
    try { await API.post(`/api/conversations/${id}/typing`, { is_typing: isTyping }); }
    catch {}
}

function _handleTypingEvent(data) {
    const { conversation_id, agent_id, agent_name, is_typing } = data;
    if (agent_id === State.user?.id) return; // ignore own events
    if (!_typingPeers[conversation_id]) _typingPeers[conversation_id] = {};
    const peers = _typingPeers[conversation_id];

    clearTimeout(peers[agent_id]?.timer);

    if (is_typing) {
        peers[agent_id] = {
            name:  agent_name,
            timer: setTimeout(() => {
                delete _typingPeers[conversation_id]?.[agent_id];
                _renderTypingIndicator(conversation_id);
            }, 4500),
        };
    } else {
        delete peers[agent_id];
    }
    _renderTypingIndicator(conversation_id);
}

function _renderTypingIndicator(convId) {
    if (convId !== State.currentConvId) return;
    const indicator = document.getElementById('typing-indicator');
    if (!indicator) return;
    const peers = Object.values(_typingPeers[convId] || {});
    if (!peers.length) {
        indicator.classList.add('hidden');
        return;
    }
    const names  = peers.map(p => p.name).join(', ');
    const verb   = peers.length > 1 ? 'rédigent' : 'rédige';
    indicator.querySelector('.typing-text').textContent = `${names} ${verb}…`;
    indicator.classList.remove('hidden');
}

// Call when switching conversations — clear stale indicators for previous conv
function _clearTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.classList.add('hidden');
}

function focusNoteInput() {
    toggleNoteMode(true);
    document.getElementById('msg-input')?.focus();
}

let _noteMode = false;
function toggleNoteMode(force) {
    const prev = _noteMode;
    _noteMode = force !== undefined ? force : !_noteMode;
    // Stop typing signal when switching to note mode
    if (!prev && _noteMode) { clearTimeout(_typingStopTimer); _sendTypingSignal(false); }
    const input  = document.getElementById('msg-input');
    const noteBtn = document.getElementById('note-mode-btn');
    if (input) {
        input.placeholder = _noteMode ? 'Note interne (visible agents seulement)…' : 'Écrire un message…';
        input.style.background = _noteMode ? '#FFFDE7' : '';
    }
    if (noteBtn) {
        noteBtn.classList.toggle('text-amber-500', _noteMode);
        noteBtn.classList.toggle('bg-amber-50', _noteMode);
        noteBtn.title = _noteMode ? 'Mode note activé (cliquer pour désactiver)' : 'Note interne';
    }
}

async function sendNoteOrMessage() {
    if (_noteMode) {
        await sendNote();
    } else {
        await sendMessage();
    }
}

async function sendNote() {
    const input   = document.getElementById('msg-input');
    const content = input?.value.trim();
    if (!content || !State.currentConvId) return;
    input.value = '';
    input.style.height = 'auto';
    toggleNoteMode(false);
    try {
        const saved = await API.post(`/api/conversations/${State.currentConvId}/notes`, { content });
        if (saved) appendMessage({ ...saved, type: 'note', sender_type: 'agent', sender_id: State.user?.id, sender_name: State.user?.name });
    } catch (e) { showToast('Erreur', e.message, 'error'); }
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', bootstrap);
