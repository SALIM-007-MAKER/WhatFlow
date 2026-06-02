const API = {
    baseURL: 'http://localhost/WhatFlow/backend/public',
    token: () => localStorage.getItem('token'),

    // Decode exp claim from JWT without a library
    _tokenExp() {
        const t = this.token();
        if (!t) return 0;
        try {
            const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(b64)).exp || 0;
        } catch { return 0; }
    },

    // Single in-flight refresh promise — prevents race conditions
    _refreshing: null,

    async _doRefresh() {
        if (this._refreshing) return this._refreshing;
        this._refreshing = (async () => {
            try {
                const res  = await fetch(this.baseURL + '/api/auth/refresh', {
                    method:  'POST',
                    headers: { Authorization: 'Bearer ' + this.token() },
                });
                const json = await res.json();
                if (json.success && json.data?.token) {
                    localStorage.setItem('token', json.data.token);
                    return true;
                }
                return false;
            } catch { return false; }
            finally   { this._refreshing = null; }
        })();
        return this._refreshing;
    },

    async request(method, path, body = null) {
        const doFetch = (tok) => fetch(this.baseURL + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
            },
            body: body ? JSON.stringify(body) : null,
        });

        let res = await doFetch(this.token());

        // Silent refresh on 401 (skip for auth endpoints to avoid infinite loops)
        if (res.status === 401 && path !== '/api/auth/refresh' && path !== '/api/auth/login') {
            const ok = await this._doRefresh();
            if (ok) {
                res = await doFetch(this.token()); // retry with new token
            } else {
                // Refresh failed → session truly expired
                if (typeof logout === 'function') logout();
                throw new Error('Session expirée — veuillez vous reconnecter');
            }
        }

        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Erreur serveur');
        return json.data;
    },

    get:    (path)       => API.request('GET',    path),
    post:   (path, body) => API.request('POST',   path, body),
    put:    (path, body) => API.request('PUT',    path, body),
    delete: (path)       => API.request('DELETE', path),
};
