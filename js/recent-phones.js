// =====================================================================
// js/recent-phones.js — remembers the last numbers a customer bought
// for (on THIS device only, in localStorage) and offers them as
// suggestions: tappable chips that appear while typing a number. Include before the page script.
// =====================================================================

(function () {
    'use strict';

    const KEY = 'hdh_recent_phones';
    const MAX = 30;

    function get() {
        try {
            const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
            return Array.isArray(raw) ? raw.filter((n) => /^0[7-9][01]\d{8}$/.test(n)) : [];
        } catch (_) { return []; }
    }

    function save(list) {
        try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (_) { /* storage blocked — suggestions just won't persist */ }
    }

    // Most recent first, de-duplicated.
    function add(phones) {
        const incoming = (Array.isArray(phones) ? phones : [phones]).filter(Boolean);
        if (!incoming.length) return;
        const merged = [...incoming.slice().reverse(), ...get()];
        save([...new Set(merged)]);
    }

    // Suggestions appear only while the customer is typing: numbers that
    // START with what has been typed (also matching when the leading 0 is
    // left out, e.g. "9044" finds 09044…). Empty field = nothing shown.
    function matches(query) {
        const q = String(query || '').replace(/\D/g, '');
        if (!q) return [];
        return get().filter((n) => n !== q && (n.startsWith(q) || n.slice(1).startsWith(q)));
    }

    function renderChips(container, selected, onPick, query) {
        if (!container) return;
        container.innerHTML = '';
        const chosen = new Set(selected || []);
        const options = matches(query).filter((n) => !chosen.has(n)).slice(0, 8);
        if (!options.length) return;

        const label = document.createElement('div');
        label.className = 'recent-label';
        label.textContent = 'Recent numbers — tap to use';
        container.appendChild(label);

        const row = document.createElement('div');
        row.className = 'bulk-list';
        options.forEach((n) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'recent-chip';
            b.textContent = n;
            b.addEventListener('click', () => onPick(n));
            row.appendChild(b);
        });
        container.appendChild(row);
    }

    // Wires an input to a suggestion container. Returns refresh(), which
    // redraws using the input's current value (call it after the
    // selection changes). The keyboard's own autofill is switched off so
    // only our list shows.
    function bind(input, container, getSelected, onPick) {
        if (!input || !container) return function () {};
        input.setAttribute('autocomplete', 'off');
        const refresh = () => renderChips(container, getSelected ? getSelected() : [], onPick, input.value);
        input.addEventListener('input', refresh);
        return refresh;
    }

    const style = document.createElement('style');
    style.textContent = `
      .recent-label{margin-top:12px;font-size:12px;color:var(--ink-soft);}
      .recent-chip{border:1px dashed var(--indigo);background:#fff;color:var(--indigo);border-radius:999px;padding:6px 12px;font-family:var(--font-mono);font-size:13px;}
      .bulk-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}
    `;
    document.head.appendChild(style);

    window.hdhRecent = { get, add, bind, renderChips };
})();
