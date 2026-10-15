// =====================================================================
// js/bulk-phones.js — shared Single / Bulk phone-number block
// Used by airtime.html and voice.html (data.html has its own inline
// copy of the same logic in js/data.js). Include AFTER pin-modal.js and
// BEFORE the page script. The page needs an empty
//   <div class="field" id="phone-block"></div>
// where the phone input(s) should appear. The single-number input keeps
// the id #phone-input so existing page code keeps working.
//
// Bulk purchases are plain sequential calls to /api/place-order (one
// per number, one PIN entry, a unique request_ref each), so no new
// server endpoint is needed.
// =====================================================================

(function () {
    'use strict';

    const BULK_MAX = 50;

    // Errors that mean "stop everything" — the next number would fail the
    // same way (or, for a wrong PIN, risk locking the account).
    const ABORT_CODES = ['INVALID_PIN', 'PIN_NOT_SET', 'MISSING_TOKEN', 'INVALID_TOKEN',
        'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'ACCOUNT_DELETED'];

    const CSS = `
      .field textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;font-family:var(--font-mono);font-size:14px;background:#fff;color:var(--ink);resize:vertical;}
      .bulk-add-btn{width:100%;margin-top:10px;padding:11px;border:1.5px solid var(--indigo);background:#fff;color:var(--indigo);border-radius:8px;font-weight:600;font-size:14px;}
      .bulk-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
      .bulk-chip{display:inline-flex;align-items:center;gap:8px;background:var(--paper-dim);border:1px solid var(--line);border-radius:999px;padding:6px 8px 6px 12px;font-family:var(--font-mono);font-size:13px;}
      .bulk-chip button{border:none;background:var(--rust-soft);color:var(--rust);width:22px;height:22px;border-radius:50%;line-height:1;font-size:14px;padding:0;}
      .bulk-summary{margin-top:10px;font-size:13px;color:var(--ink-soft);}
      .bulk-results{text-align:left;font-size:13px;max-height:260px;overflow:auto;margin-top:10px;}
      .bulk-results div{padding:3px 0;word-break:break-word;}
      .modal-msg{color:var(--ink-soft);font-size:14px;margin:0 0 18px;}
    `;

    const MARKUP = `
      <label>Phone Number(s)</label>
      <div class="network-tabs" id="mode-tabs">
        <button type="button" class="active" data-mode="single">Single</button>
        <button type="button" data-mode="bulk">Bulk</button>
      </div>
      <div id="single-box">
        <input type="tel" id="phone-input" placeholder="e.g. 08012345678" maxlength="14">
        <div id="single-recent"></div>
      </div>
      <div id="bulk-box" style="display:none;">
        <div class="network-tabs" id="bulk-tabs">
          <button type="button" class="active" data-bt="manual">Manual</button>
          <button type="button" data-bt="paste">Paste List</button>
        </div>
        <div id="bulk-manual">
          <input type="tel" id="bulk-phone-input" placeholder="e.g. 08012345678" maxlength="14">
          <div id="bulk-recent"></div>
          <button type="button" class="bulk-add-btn" id="bulk-add-btn">+ Add Number</button>
        </div>
        <div id="bulk-paste" style="display:none;">
          <textarea id="bulk-paste-input" rows="5" placeholder="One number per line, or separated by commas / spaces"></textarea>
          <button type="button" class="bulk-add-btn" id="bulk-paste-btn">+ Add numbers from list</button>
        </div>
        <div id="bulk-list" class="bulk-list"></div>
        <div id="bulk-summary" class="bulk-summary"></div>
      </div>
    `;

    let mode = 'single';
    let numbers = [];
    let onChange = function () {};

    const $ = (sel) => document.querySelector(sel);

    function esc(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function toast(msg, type) {
        if (typeof window.toast === 'function') window.toast(msg, type || 'ok');
    }

    function normalizeNgPhone(input) {
        let cleaned = (input || '').replace(/[\s-()]/g, '');
        if (cleaned.startsWith('+234')) cleaned = '0' + cleaned.slice(4);
        else if (cleaned.startsWith('234') && cleaned.length === 13) cleaned = '0' + cleaned.slice(3);
        else if (/^[789]\d{9}$/.test(cleaned)) cleaned = '0' + cleaned;
        return /^0[7-9][01]\d{8}$/.test(cleaned) ? cleaned : null;
    }

    // 'added' | 'invalid' | 'duplicate' | 'full'
    function addNumber(raw) {
        const phone = normalizeNgPhone(raw);
        if (!phone) return 'invalid';
        if (numbers.includes(phone)) return 'duplicate';
        if (numbers.length >= BULK_MAX) return 'full';
        numbers.push(phone);
        return 'added';
    }

    function renderChips() {
        const list = $('#bulk-list');
        list.innerHTML = '';
        numbers.forEach((num) => {
            const chip = document.createElement('span');
            chip.className = 'bulk-chip';
            chip.innerHTML = `${esc(num)}<button type="button" aria-label="Remove ${esc(num)}">×</button>`;
            chip.querySelector('button').addEventListener('click', () => {
                numbers = numbers.filter((n) => n !== num);
                changed();
            });
            list.appendChild(chip);
        });
    }

    let refreshBulkRecent = null;

    function changed() {
        renderChips();
        if (refreshBulkRecent) refreshBulkRecent();
        onChange();
    }

    function setMode(m) {
        mode = m;
        document.querySelectorAll('#mode-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
        $('#single-box').style.display = m === 'single' ? 'block' : 'none';
        $('#bulk-box').style.display = m === 'bulk' ? 'block' : 'none';
        changed();
    }

    function setBulkTab(tab) {
        document.querySelectorAll('#bulk-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.bt === tab));
        $('#bulk-manual').style.display = tab === 'manual' ? 'block' : 'none';
        $('#bulk-paste').style.display = tab === 'paste' ? 'block' : 'none';
    }

    function onAddManual() {
        const input = $('#bulk-phone-input');
        const result = addNumber(input.value.trim());
        if (result === 'added') { input.value = ''; changed(); input.focus(); return; }
        toast({
            invalid: 'Enter a valid Nigerian phone number',
            duplicate: 'That number is already in the list',
            full: `You can add at most ${BULK_MAX} numbers at a time`
        }[result], 'err');
    }

    function onAddPaste() {
        const box = $('#bulk-paste-input');
        const parts = box.value.split(/[\s,;]+/).filter(Boolean);
        if (parts.length === 0) { toast('Paste at least one number', 'err'); return; }

        const counts = { added: 0, invalid: 0, duplicate: 0, full: 0 };
        parts.forEach((p) => { counts[addNumber(p)]++; });
        changed();

        if (counts.added) box.value = '';
        const notes = [];
        if (counts.invalid) notes.push(`${counts.invalid} invalid`);
        if (counts.duplicate) notes.push(`${counts.duplicate} duplicate`);
        if (counts.full) notes.push(`${counts.full} over the ${BULK_MAX} limit`);
        toast(`${counts.added} added` + (notes.length ? ` · ${notes.join(', ')} skipped` : ''), counts.added ? 'ok' : 'err');
    }

    // ---- public API --------------------------------------------------

    function mount(opts) {
        onChange = (opts && opts.onChange) || function () {};

        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const block = $('#phone-block');
        block.innerHTML = MARKUP;

        document.querySelectorAll('#mode-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
        document.querySelectorAll('#bulk-tabs button').forEach((b) => b.addEventListener('click', () => setBulkTab(b.dataset.bt)));
        $('#bulk-add-btn').addEventListener('click', onAddManual);
        $('#bulk-phone-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddManual(); } });
        $('#bulk-paste-btn').addEventListener('click', onAddPaste);
        if (window.hdhRecent) {
            const single = $('#phone-input');
            hdhRecent.bind(single, $('#single-recent'), () => [], (n) => {
                single.value = n;
                $('#single-recent').innerHTML = '';
                single.dispatchEvent(new Event('input'));
            });
            const bulkInput = $('#bulk-phone-input');
            refreshBulkRecent = hdhRecent.bind(bulkInput, $('#bulk-recent'), () => numbers, (n) => {
                if (addNumber(n) === 'full') toast(`You can add at most ${BULK_MAX} numbers at a time`, 'err');
                bulkInput.value = '';
                changed();
            });
        }
        changed();
    }

    function setSummary(text) {
        const el = $('#bulk-summary');
        if (el) el.textContent = text;
    }

    function removeNumbers(list) {
        const gone = new Set(list);
        numbers = numbers.filter((n) => !gone.has(n));
        changed();
    }

    function newRef(prefix, i) {
        return `${prefix}${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    }

    // Sends ONE order to /api/place-order. Resolves with the transaction;
    // throws an Error with .code and .uncertain (true = unknown outcome).
    async function submitOrder(accessToken, payload) {
        let res;
        try {
            res = await fetch('/api/place-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
                body: JSON.stringify(payload)
            });
        } catch (netErr) {
            const e = new Error('Network problem — please check Transactions to see if this one went through.');
            e.uncertain = true;
            throw e;
        }

        let body;
        try {
            body = await res.json();
        } catch (parseErr) {
            const e = new Error(`Server did not return a valid response (HTTP ${res.status}). Check Transactions before retrying.`);
            e.uncertain = res.status >= 500;
            throw e;
        }

        if (!res.ok || body.success === false) {
            const e = new Error((body.error && body.error.message) || `Purchase failed (HTTP ${res.status})`);
            e.code = body.error && body.error.code;
            throw e;
        }
        return body.data;
    }

    // Runs sendOne(phone, index) for each number in order. Stops early on
    // errors that would repeat (see ABORT_CODES), insufficient balance, or
    // an unknown outcome.
    async function run({ numbers: list, sendOne, onProgress }) {
        const done = [];
        const failed = [];
        let stoppedReason = null;
        let uncertain = false;
        let processed = 0;

        for (const phone of list) {
            if (onProgress) onProgress(processed + 1, list.length);
            try {
                const txn = await sendOne(phone, processed);
                done.push({ phone, pending: !!(txn && txn.status === 'pending'), partial: (txn && txn.partial) || null });
                if (window.hdhRecent) hdhRecent.add(phone);
            } catch (err) {
                failed.push({ phone, reason: err.message });
                const insufficient = /insufficient/i.test(err.message || '');
                if (err.uncertain || insufficient || ABORT_CODES.includes(err.code)) {
                    uncertain = !!err.uncertain;
                    stoppedReason = err.uncertain
                        ? 'Stopped because the connection dropped — check Transactions before retrying.'
                        : `Stopped: ${err.message}`;
                    processed++;
                    break;
                }
            }
            processed++;
        }

        return { done, failed, notAttempted: list.slice(processed), stoppedReason, uncertain, total: list.length };
    }

    function allOk(res) {
        return res.failed.length === 0 && res.notAttempted.length === 0 && !res.done.some((d) => d.partial);
    }

    function resultHtml(res) {
        const pendingCount = res.done.filter((d) => d.pending).length;
        let html = `<div><b>${res.done.length}</b> of ${res.total} sent` + (pendingCount ? ` (${pendingCount} still processing)` : '') + '.</div>';
        html += '<div class="bulk-results">';
        res.done.forEach((d) => {
            if (d.partial) html += `<div>⚠️ ${esc(d.phone)} — partly delivered, N${esc(d.partial.refundAmount)} refunded (${esc((d.partial.failedParts || []).join(', '))})</div>`;
            else html += `<div>✅ ${esc(d.phone)}${d.pending ? ' — processing' : ''}</div>`;
        });
        res.failed.forEach((f) => { html += `<div>❌ ${esc(f.phone)} — ${esc(f.reason)}</div>`; });
        res.notAttempted.forEach((n) => { html += `<div>⏸️ ${esc(n)} — not attempted</div>`; });
        html += '</div>';
        if (res.stoppedReason) html += `<p style="margin-top:10px;">${esc(res.stoppedReason)}</p>`;
        if (!allOk(res) && !res.uncertain) html += '<p style="margin-top:10px;">You were not charged for failed numbers (any debit was refunded). They are kept in your list so you can try again.</p>';
        return html;
    }

    window.hdhBulk = {
        mount,
        mode: () => mode,
        numbers: () => [...numbers],
        setSummary,
        removeNumbers,
        newRef,
        submitOrder,
        run,
        allOk,
        resultHtml,
        normalizeNgPhone,
        esc,
        MAX: BULK_MAX
    };
})();
