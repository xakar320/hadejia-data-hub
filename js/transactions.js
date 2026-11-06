// =====================================================================
// js/transactions.js — Transaction History page logic
// Relies on the global `client` from js/supabase.js. RLS already
// restricts reads to the signed-in user's own rows, but we filter by
// user_id explicitly too for clarity and query efficiency.
// =====================================================================

let session = null;
let offset = 0;
const PAGE_SIZE = 15;
let filters = { type: '', status: '', search: '', from: '', to: '' };
let searchDebounceTimer = null;

function $(sel) { return document.querySelector(sel); }

function money(n) {
    return Number(n || 0).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function fmtDate(s) {
    return s ? new Date(s).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'ok' ? 'ok' : 'err'}`;
    t.textContent = msg;
    $('#toast-wrap').appendChild(t);
    setTimeout(() => t.remove(), 4200);
}

function elEmpty(msg) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = msg;
    return d;
}

// ===============================
// INIT
// ===============================

async function init() {
    const { data: { session: s } } = await client.auth.getSession();

    if (!s) {
        location.href = 'index.html';
        return;
    }

    session = s;
    loadScheduled();

    $('#filter-type').addEventListener('change', (e) => {
        filters.type = e.target.value;
        offset = 0;
        loadTransactions(true);
    });

    $('#filter-status').addEventListener('change', (e) => {
        filters.status = e.target.value;
        offset = 0;
        loadTransactions(true);
    });

    $('#search-input').addEventListener('input', (e) => {
        const term = e.target.value.trim();
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            filters.search = term;
            offset = 0;
            loadTransactions(true);
        }, 350);
    });

    // Date + time range (browser date/time picker, your local time)
    const pad = n => String(n).padStart(2, '0');
    const toLocalValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

    $('#filter-from').addEventListener('change', (e) => {
        filters.from = e.target.value;
        offset = 0;
        loadTransactions(true);
    });

    $('#filter-to').addEventListener('change', (e) => {
        filters.to = e.target.value;
        offset = 0;
        loadTransactions(true);
    });

    $('#filter-today-btn').addEventListener('click', () => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        $('#filter-from').value = toLocalValue(start);
        $('#filter-to').value = '';
        filters.from = $('#filter-from').value;
        filters.to = '';
        offset = 0;
        loadTransactions(true);
    });

    $('#filter-clear-dates-btn').addEventListener('click', () => {
        $('#filter-from').value = '';
        $('#filter-to').value = '';
        filters.from = '';
        filters.to = '';
        offset = 0;
        loadTransactions(true);
    });

    $('#load-more-btn').addEventListener('click', () => loadTransactions(false));

    await loadTransactions(true);
    startPendingWatcher();
}

// ===============================
// PENDING WATCHER
// While any order on screen is still 'pending', ask the server to check
// it with the provider (every 30s, up to ~20 min) and refresh the list
// as soon as one is resolved. Needs no webhook and no cron.
// ===============================

let pendingWatcherTimer = null;
let pendingChecks = 0;

function hasPendingOnScreen() {
    return !!document.querySelector('#tx-list .tx-badge.pending');
}

async function checkPendingOnce() {
    if (document.hidden || !hasPendingOnScreen()) return;
    try {
        const { data: { session: s } } = await client.auth.getSession();
        if (!s) return;
        const res = await fetch('/api/place-order?action=check-pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.access_token}` },
            body: '{}'
        });
        const json = await res.json().catch(() => null);
        const d = json && json.data;
        if (d && (d.success > 0 || d.failed > 0 || d.partial > 0)) {
            await loadTransactions(true);
        }
    } catch (e) { /* silent: it will retry on the next tick */ }
}

function startPendingWatcher() {
    if (pendingWatcherTimer) return;
    checkPendingOnce();
    pendingWatcherTimer = setInterval(() => {
        pendingChecks += 1;
        if (pendingChecks > 40) { clearInterval(pendingWatcherTimer); pendingWatcherTimer = null; return; }
        checkPendingOnce();
    }, 30000);
}

// ===============================
// LOAD TRANSACTIONS
// ===============================

async function loadTransactions(reset) {
    const list = $('#tx-list');
    const loadMoreBtn = $('#load-more-btn');

    if (reset) {
        offset = 0;
        list.innerHTML = '';
        list.appendChild(elEmpty('Loading…'));
    }

    try {
        let query = client
            .from('transactions')
            .select('*')
            .eq('user_id', session.user.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + PAGE_SIZE - 1);

        if (filters.type) query = query.eq('type', filters.type);
        if (filters.status) query = query.eq('status', filters.status);
        if (filters.from) {
            const d = new Date(filters.from);
            if (!isNaN(d)) query = query.gte('created_at', d.toISOString());
        }
        if (filters.to) {
            const d = new Date(filters.to);
            // include the whole minute that was picked
            if (!isNaN(d)) query = query.lte('created_at', new Date(d.getTime() + 59999).toISOString());
        }
        if (filters.search) {
            // Comma would break the .or() filter syntax below — strip it defensively.
            const term = filters.search.replace(/,/g, '');
            query = query.or(`recipient.ilike.%${term}%,provider_reference.ilike.%${term}%,request_payload->>intendedPhone.ilike.%${term}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        if (reset) list.innerHTML = '';

        if (reset && (!data || data.length === 0)) {
            list.appendChild(elEmpty('No transactions match these filters.'));
            loadMoreBtn.style.display = 'none';
            return;
        }

        data.forEach(tx => list.appendChild(renderTxItem(tx)));

        offset += data.length;
        loadMoreBtn.style.display = data.length < PAGE_SIZE ? 'none' : 'block';

    } catch (err) {
        console.error(err);
        if (reset) {
            list.innerHTML = '';
            list.appendChild(elEmpty(err.message));
        } else {
            toast(err.message, 'err');
        }
    }
}

// ===============================
// RENDER A SINGLE TRANSACTION ROW
// ===============================

function intendedOf(tx) {
    return tx && tx.request_payload && tx.request_payload.intendedPhone ? String(tx.request_payload.intendedPhone) : '';
}

function wrongTag(tx) {
    const p = intendedOf(tx);
    if (!p) return '';
    const safe = p.replace(/[^0-9+]/g, '');
    return `<div style="margin-top:4px;font-size:11px;font-weight:700;color:#b45309;">⚠ Wrong number — meant for ${safe}</div>`;
}

function renderTxItem(tx) {
    const row = document.createElement('div');
    row.className = 'tx-item';

    const subLine = [tx.network, tx.recipient].filter(Boolean).join(' · ');
    const sign = ['wallet_funding', 'airtime_to_cash'].includes(tx.type) ? '+' : '−';

    row.innerHTML = `
        <div class="tx-left">
            <div class="tx-type">${tx.type.replace('_', ' ')}</div>
            <div class="tx-sub">${subLine || '—'}</div>
            <div class="tx-date">${fmtDate(tx.created_at)}</div>
            ${wrongTag(tx)}
        </div>
        <div class="tx-right">
            <div class="tx-amount ${tx.status}">${sign}₦${money(tx.amount)}</div>
            <div class="tx-badge ${tx.status}">${tx.status}</div>
        </div>
    `;

    row.addEventListener('click', () => openDetail(tx));
    return row;
}

// ===============================
// DETAIL MODAL
// ===============================

function openDetail(tx) {
    const content = $('#detail-modal-content');

    const subLine = [tx.network, tx.recipient].filter(Boolean).join(' · ');

    content.innerHTML = `
        <button class="modal-close" id="detail-close-btn" style="float:right;background:none;border:none;font-size:18px;color:var(--ink-soft);">✕</button>
        <h3 style="margin-bottom:14px;text-transform:capitalize;">${tx.type.replace('_', ' ')}</h3>
        <div class="detail-row"><span class="label">Status</span><span class="value tx-badge ${tx.status}" style="text-align:right;">${tx.status}</span></div>
        <div class="detail-row"><span class="label">Amount</span><span class="value">₦${money(tx.amount)}</span></div>
        ${subLine ? `<div class="detail-row"><span class="label">Details</span><span class="value" style="font-family:inherit;font-weight:400;">${subLine}</span></div>` : ''}
        <div class="detail-row"><span class="label">Reference</span><span class="value" style="font-size:11px;">${tx.provider_reference || tx.id}</span></div>
        <div class="detail-row"><span class="label">Date</span><span class="value" style="font-family:inherit;font-weight:400;">${fmtDate(tx.created_at)}</span></div>
        ${intendedOf(tx) ? `<div class="detail-row"><span class="label">Meant for</span><span class="value" style="color:#b45309;">${intendedOf(tx).replace(/[^0-9+]/g, '')}</span></div>` : ''}
        <button class="btn btn-primary" id="detail-copy-btn" style="margin-top:16px;">Copy Reference</button>
        ${['data', 'voice', 'airtime'].includes(tx.type) && tx.status === 'success'
            ? `<button class="btn" id="detail-wrong-btn" style="margin-top:10px;width:100%;background:#fff;border:1px solid #cfd3dc;">${intendedOf(tx) ? 'Remove wrong-number mark' : '⚠ Sent to a wrong number?'}</button>`
            : ''}
    `;

    $('#detail-modal').classList.add('open');

    $('#detail-close-btn').addEventListener('click', () => {
        $('#detail-modal').classList.remove('open');
    });

    const wrongBtn = $('#detail-wrong-btn');
    if (wrongBtn) {
        wrongBtn.addEventListener('click', async () => {
            let intended = '';
            if (!intendedOf(tx)) {
                intended = (prompt(`This order went to ${tx.recipient}.\nType the number it was MEANT for:`) || '').trim();
                if (!intended) return;
            } else if (!confirm('Remove the wrong-number mark from this transaction?')) {
                return;
            }
            try {
                await schedApi('mark-wrong-number', { transaction_id: tx.id, intended_phone: intended });
                toast(intended ? 'Marked' : 'Mark removed');
                $('#detail-modal').classList.remove('open');
                loadTransactions(true);
            } catch (e) {
                toast(e.message, 'err');
            }
        });
    }

    $('#detail-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(tx.provider_reference || tx.id).then(() => {
            toast('Reference copied');
        }).catch(() => {});
    });
}

$('#detail-modal').addEventListener('click', (e) => {
    if (e.target.id === 'detail-modal') {
        $('#detail-modal').classList.remove('open');
    }
});

// ===============================
// START
// ===============================

window.addEventListener('load', init);


// ===============================
// SCHEDULED ORDERS
// ===============================
async function schedApi(action, payload) {
    const res = await fetch(`/api/place-order?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
        body: JSON.stringify(payload || {})
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok || body.success === false) {
        throw new Error((body.error && body.error.message) || `Request failed (HTTP ${res.status})`);
    }
    return body.data;
}

async function loadScheduled() {
    try {
        const rows = await schedApi('list-scheduled');
        const card = $('#sched-card');
        const list = $('#sched-list');
        list.textContent = '';
        if (!rows || rows.length === 0) { card.style.display = 'none'; return; }
        card.style.display = 'block';
        const labels = { scheduled: 'Waiting', running: 'Running…', done: 'Sent', failed: 'Failed', cancelled: 'Cancelled' };
        rows.forEach((r) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line);font-size:13px;';
            const left = document.createElement('div');
            const a = document.createElement('div');
            a.textContent = r.summary || r.type;
            const b = document.createElement('div');
            b.style.cssText = 'color:var(--ink-soft);font-size:12px;';
            b.textContent = `${fmtDate(r.run_at)} · ${labels[r.status] || r.status}${r.txn_status ? ' → ' + r.txn_status : ''}${r.error ? ' — ' + r.error : ''}`;
            if (r.txn_created_at) b.textContent += ` (order created ${fmtDate(r.txn_created_at)})`;
            left.append(a, b);
            row.appendChild(left);
            if (r.status === 'scheduled') {
                const c = document.createElement('button');
                c.type = 'button';
                c.textContent = 'Cancel';
                c.style.cssText = 'padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer;font-size:12px;';
                c.onclick = async () => {
                    if (!confirm('Cancel this scheduled order?')) return;
                    try { await schedApi('cancel-scheduled', { id: r.id }); toast('Cancelled'); } catch (e) { toast(e.message, 'err'); }
                    loadScheduled();
                };
                row.appendChild(c);
            }
            if (r.status === 'failed') {
                const d = document.createElement('button');
                d.type = 'button';
                d.textContent = 'Delete';
                d.style.cssText = 'padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer;font-size:12px;';
                d.onclick = async () => {
                    try { await schedApi('delete-scheduled', { id: r.id }); toast('Deleted'); } catch (e) { toast(e.message, 'err'); }
                    loadScheduled();
                };
                row.appendChild(d);
            }
            list.appendChild(row);
        });
    } catch (err) {
        console.error('scheduled list failed', err);
    }
}
