// =====================================================================
// js/transactions.js — Transaction History page logic
// Relies on the global `client` from js/supabase.js. RLS already
// restricts reads to the signed-in user's own rows, but we filter by
// user_id explicitly too for clarity and query efficiency.
// =====================================================================

let session = null;
let offset = 0;
const PAGE_SIZE = 15;
let filters = { type: '', status: '' };

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

    $('#load-more-btn').addEventListener('click', () => loadTransactions(false));

    await loadTransactions(true);
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

function renderTxItem(tx) {
    const row = document.createElement('div');
    row.className = 'tx-item';

    const subLine = [tx.network, tx.recipient].filter(Boolean).join(' · ');
    const sign = tx.type === 'wallet_funding' ? '+' : '−';

    row.innerHTML = `
        <div class="tx-left">
            <div class="tx-type">${tx.type.replace('_', ' ')}</div>
            <div class="tx-sub">${subLine || '—'}</div>
            <div class="tx-date">${fmtDate(tx.created_at)}</div>
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
        <button class="btn btn-primary" id="detail-copy-btn" style="margin-top:16px;">Copy Reference</button>
    `;

    $('#detail-modal').classList.add('open');

    $('#detail-close-btn').addEventListener('click', () => {
        $('#detail-modal').classList.remove('open');
    });

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
