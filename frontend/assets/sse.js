const SSE_BASE = 'http://localhost/WhatFlow/backend/public';

class SSEClient {
    constructor(token) {
        this.handlers   = {};
        this.token      = token;
        this.lastId     = parseInt(sessionStorage.getItem('sse_lastId') || '0', 10);
        this.retryDelay = 3000;
        this.es         = null;
        this._connect();
    }

    async _connect() {
        const url = await this._buildUrl();
        this._openSource(url);
    }

    async _buildUrl() {
        try {
            const res = await fetch(SSE_BASE + '/api/sse/token', {
                method:  'POST',
                headers: { Authorization: 'Bearer ' + this.token },
            });
            const json = await res.json();
            if (!json.success || !json.data?.ticket) throw new Error('no ticket');
            return `${SSE_BASE}/api/sse?ticket=${encodeURIComponent(json.data.ticket)}&lastEventId=${this.lastId}`;
        } catch {
            // Dev fallback: pass JWT directly (acceptable on localhost only)
            return `${SSE_BASE}/api/sse?token=${encodeURIComponent(this.token)}&lastEventId=${this.lastId}`;
        }
    }

    _openSource(url) {
        this.es = new EventSource(url);

        this.es.onopen = () => {
            this.retryDelay = 3000;
        };

        this.es.onerror = () => {
            this.es.close();
            this.es = null;
            setTimeout(() => this._connect(), this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, 30000);
        };

        this.es.addEventListener('ping', () => {});

        // Register all handlers accumulated via .on() before the async connect resolved
        for (const [type, fns] of Object.entries(this.handlers)) {
            this._attachListener(type, fns);
        }
    }

    _attachListener(type, fns) {
        this.es.addEventListener(type, (e) => {
            if (e.lastEventId) {
                const id = parseInt(e.lastEventId, 10);
                if (id > this.lastId) {
                    this.lastId = id;
                    sessionStorage.setItem('sse_lastId', id);
                }
            }
            try {
                const data = JSON.parse(e.data);
                fns.forEach(fn => fn(data));
            } catch (err) {
                console.error('[SSE] parse error', err);
            }
        });
    }

    on(type, fn) {
        if (!this.handlers[type]) {
            this.handlers[type] = [];
            // If EventSource is already open (reconnect scenario), attach immediately
            if (this.es) this._attachListener(type, this.handlers[type]);
        }
        this.handlers[type].push(fn);
        return this;
    }

    off(type) {
        delete this.handlers[type];
        return this;
    }
}
