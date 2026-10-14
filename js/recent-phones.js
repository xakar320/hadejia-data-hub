// =====================================================================
// js/recent-phones.js — remembers the last numbers a customer bought
// for (on THIS device only, in localStorage) and offers them as
// suggestions: a <datalist> on the phone inputs, plus tappable
// "Recent numbers" chips in bulk mode. Include before the page script.
// =====================================================================

(function () {
    'use strict';

    const KEY = 'hdh_recent_phones';
    const MAX = 30;
    const LIST_ID = 'hdh-recent-list';

    function get() {
        try {
            const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
            return Array.isArray(raw) ? raw.filter((n) => /^0[7-9][01]\d{8}$/.test(n)) : [];
        } catch (_) { return []; }
    }

    function save(list) {
        try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (_) { /* storage blocked — suggestions just won't persist */ }
    }

    function refreshDatalist() {
        const dl = document.getElementById(LIST_ID);
        if (!dl) return;
        dl.innerHTML = '';
        get().forEach((n) => {
            const o = document.createElement('option');
            o.value = n;
            dl.appendChild(o);
        });
    }

    // Most recent first, de-duplicated.
    function add(phones) {
        const incoming = (Array.isArray(phones) ? phones : [phones]).filter(Boolean);
        if (!incoming.length) return;
        const merged = [...incoming.slice().reverse(), ...get()];
        save([...new Set(merged)]);
        refreshDatalist();
    }

    function attachDatalist(input) {
        if (!input) return;
        if (!document.getElementById(LIST_ID)) {
            const dl = document.createElement('datalist');
            dl.id = LIST_ID;
            document.body.appendChild(dl);
        }
        input.setAttribute('list', LIST_ID);
        input.setAttribute('autocomplete', 'off'); // use OUR list, not the keyboard's
        refreshDatalist();
    }

    // Draws up to 8 recent numbers (not already selected) as tappable chips.
    function renderChips(container, selected, onPick) {
        if (!container) return;
        container.innerHTML = '';
        const chosen = new Set(selected || []);
        const options = get().filter((n) => !chosen.has(n)).slice(0, 8);
        if (!options.length) return;

        const label = document.createElement('div');
        label.className = 'recent-label';
        label.textContent = 'Recent numbers — tap to add';
        container.appendChild(label);

        const row = document.createElement('div');
        row.className = 'bulk-list';
        options.forEach((n) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'recent-chip';
            b.textContent = '+ ' + n;
            b.addEventListener('click', () => onPick(n));
            row.appendChild(b);
        });
        container.appendChild(row);
    }

    const style = document.createElement('style');
    style.textContent = `
      .recent-label{margin-top:12px;font-size:12px;color:var(--ink-soft);}
      .recent-chip{border:1px dashed var(--indigo);background:#fff;color:var(--indigo);border-radius:999px;padding:6px 12px;font-family:var(--font-mono);font-size:13px;}
      .bulk-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
    `;
    document.head.appendChild(style);

    window.hdhRecent = { get, add, attachDatalist, renderChips };
})();
