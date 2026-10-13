// =====================================================================
// js/airtime.js — Buy Airtime page logic
// Relies on the global `client` from js/supabase.js and hdhRequestPin()
// from js/pin-modal.js. Buys airtime via POST /api/place-order with
// { type: "airtime", network, phone, amount, pin }. product_id comes
// from the airtime_plans row server-side — never sent from here.
// =====================================================================

let session = null;
let allPlans = [];
let selectedPlan = null;
let selectedQuickAmount = null;
let walletBalance = 0;

const QUICK_AMOUNTS = [100, 200, 500, 1000, 2000];

function $(sel) { return document.querySelector(sel); }

function money(n) {
    return Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
    if (!s) { location.href = 'index.html'; return; }
    session = s;

    const { data: profile } = await client
        .from('users')
        .select('phone, wallet_balance')
        .eq('id', s.user.id)
        .maybeSingle();

    if (profile) {
        walletBalance = Number(profile.wallet_balance || 0);
        $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
        // NOTE: intentionally NOT auto-filling #phone-input with the
        // account's own phone — see js/data.js for why.
    }

    renderQuickAmounts();
    await loadNetworks();

    $('#amount-input').addEventListener('input', () => {
        selectedQuickAmount = null;
        document.querySelectorAll('#quick-amounts button').forEach(b => b.classList.remove('active'));
        refreshBulkSummary();
    });
}

// ===============================
// LOAD NETWORKS
// ===============================

async function loadNetworks() {
    const tabs = $('#network-tabs');
    tabs.innerHTML = '';

    try {
        const { data, error } = await client
            .from('airtime_plans')
            .select('*')
            .eq('status', 'active')
            .order('network');

        if (error) throw error;

        allPlans = data || [];

        if (allPlans.length === 0) {
            tabs.appendChild(elEmpty('Airtime purchases are not available right now.'));
            return;
        }

        allPlans.forEach((plan, i) => {
            const btn = document.createElement('button');
            btn.textContent = plan.network;
            if (i === 0) btn.classList.add('active');
            btn.addEventListener('click', () => selectNetwork(plan, btn));
            tabs.appendChild(btn);
        });

        selectNetwork(allPlans[0], tabs.querySelector('button'));

    } catch (err) {
        tabs.innerHTML = '';
        tabs.appendChild(elEmpty(err.message));
    }
}

function selectNetwork(plan, btnEl) {
    selectedPlan = plan;
    document.querySelectorAll('#network-tabs button').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    const discountBadge = $('#discount-badge-wrap');
    discountBadge.innerHTML = Number(plan.discount_percentage) > 0
        ? `<span class="discount-badge">${plan.discount_percentage}% off</span>`
        : '';

    $('#amount-hint').textContent = `Min ₦${money(plan.min_amount)} — Max ₦${money(plan.max_amount)}`;
    $('#amount-input').min = plan.min_amount;
    $('#amount-input').max = plan.max_amount;

    refreshBulkSummary();
}

// ===============================
// QUICK AMOUNTS
// ===============================

function renderQuickAmounts() {
    const wrap = $('#quick-amounts');
    wrap.innerHTML = '';
    QUICK_AMOUNTS.forEach(amt => {
        const btn = document.createElement('button');
        btn.textContent = `₦${money(amt)}`;
        btn.addEventListener('click', () => {
            selectedQuickAmount = amt;
            $('#amount-input').value = amt;
            document.querySelectorAll('#quick-amounts button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            refreshBulkSummary();
        });
        wrap.appendChild(btn);
    });
}

// ===============================
// BUY BUTTON STATE
// ===============================

function updateBuyButton() {
    const btn = $('#buy-btn');
    const amount = Number($('#amount-input').value);
    const validAmount = selectedPlan && amount >= Number(selectedPlan.min_amount) && amount <= Number(selectedPlan.max_amount);

    if (!validAmount) {
        btn.disabled = true;
        btn.textContent = selectedPlan ? 'Enter a valid amount' : 'Select a network first';
        return;
    }

    if (window.hdhBulk && hdhBulk.mode() === 'bulk') {
        const n = hdhBulk.numbers().length;
        if (n === 0) {
            btn.disabled = true;
            btn.textContent = 'Add at least one number';
            return;
        }
        btn.disabled = false;
        btn.textContent = `Buy ₦${money(amount)} ${selectedPlan.network} for ${n} number${n > 1 ? 's' : ''} — ₦${money(amount * n)}`;
        return;
    }

    btn.disabled = false;
    btn.textContent = `Buy ₦${money(amount)} ${selectedPlan.network} Airtime`;
}

function refreshBulkSummary() {
    if (!window.hdhBulk) return;
    const n = hdhBulk.numbers().length;
    const amount = Number($('#amount-input').value);
    if (n === 0) hdhBulk.setSummary(`No numbers added yet (up to ${hdhBulk.MAX}).`);
    else if (amount > 0) hdhBulk.setSummary(`${n} number${n > 1 ? 's' : ''} × ₦${money(amount)} = ₦${money(amount * n)}`);
    else hdhBulk.setSummary(`${n} number${n > 1 ? 's' : ''} added. Enter an amount to see the total.`);
    updateBuyButton();
}

// ===============================
// PURCHASE
// ===============================

function normalizeNgPhone(input) {
    let cleaned = (input || '').replace(/[\s-()]/g, '');
    if (cleaned.startsWith('+234')) cleaned = '0' + cleaned.slice(4);
    else if (cleaned.startsWith('234') && cleaned.length === 13) cleaned = '0' + cleaned.slice(3);
    else if (/^[789]\d{9}$/.test(cleaned)) cleaned = '0' + cleaned;
    return /^0[7-9][01]\d{8}$/.test(cleaned) ? cleaned : null;
}

async function refreshWallet() {
    const { data: profile } = await client
        .from('users')
        .select('wallet_balance')
        .eq('id', session.user.id)
        .maybeSingle();
    if (profile) {
        walletBalance = Number(profile.wallet_balance || 0);
        $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
    }
}

async function buyBulk() {
    if (!selectedPlan) return;
    const list = hdhBulk.numbers();
    const amount = Number($('#amount-input').value);
    if (list.length === 0) return;

    const total = amount * list.length;
    if (total > walletBalance) {
        toast(`Insufficient balance: you need ₦${money(total)} but have ₦${money(walletBalance)}`, 'err');
        return;
    }
    if (!confirm(`Buy ₦${money(amount)} ${selectedPlan.network} airtime for ${list.length} number${list.length > 1 ? 's' : ''}?\nTotal: ₦${money(total)}`)) return;

    const pin = await hdhRequestPin();
    if (!pin) return;

    const btn = $('#buy-btn');
    btn.disabled = true;

    const network = selectedPlan.network;
    const res = await hdhBulk.run({
        numbers: list,
        onProgress: (i, n) => { btn.textContent = `Processing ${i} of ${n}…`; },
        sendOne: (phone, i) => hdhBulk.submitOrder(session.access_token, {
            type: 'airtime', network, phone, amount, pin, request_ref: hdhBulk.newRef('AIR', i)
        })
    });

    hdhBulk.removeNumbers(res.done.map(d => d.phone));

    const ok = hdhBulk.allOk(res);
    showResultModal({
        ok,
        title: ok ? 'Bulk purchase complete' : 'Bulk purchase finished with issues',
        message: hdhBulk.resultHtml(res)
    });

    try { await refreshWallet(); } catch (_) { /* cosmetic */ }
    refreshBulkSummary();
}

$('#buy-btn').addEventListener('click', async () => {
    if (hdhBulk.mode() === 'bulk') return buyBulk();

    const rawPhone = $('#phone-input').value.trim();
    const phone = normalizeNgPhone(rawPhone);
    const amount = Number($('#amount-input').value);

    if (!phone) {
        toast('Enter a valid Nigerian phone number', 'err');
        return;
    }
    if (!selectedPlan) return;

    const pin = await hdhRequestPin();
    if (!pin) return;

    const btn = $('#buy-btn');
    btn.disabled = true;
    btn.textContent = 'Processing…';

    try {
        const res = await fetch('/api/place-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                type: 'airtime',
                network: selectedPlan.network,
                phone,
                amount,
                pin
            })
        });

        let body;
        try {
            body = await res.json();
        } catch (parseErr) {
            const text = await res.text().catch(() => '');
            throw new Error(
                `Server did not return a valid response (HTTP ${res.status}). ` +
                (text ? `Details: ${text.slice(0, 200)}` : '')
            );
        }

        if (!res.ok || body.success === false) {
            throw new Error((body.error && body.error.message) || `Purchase failed (HTTP ${res.status})`);
        }

        const isPending = body.data && body.data.status === 'pending';

        showResultModal({
            ok: !isPending,
            title: isPending ? 'Order submitted' : 'Purchase successful',
            message: isPending
                ? 'Your airtime is being processed. It will arrive shortly.'
                : `₦${money(amount)} ${selectedPlan.network} airtime sent to ${phone}.`
        });

        const { data: profile } = await client
            .from('users')
            .select('wallet_balance')
            .eq('id', session.user.id)
            .maybeSingle();
        if (profile) $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;

    } catch (err) {
        console.error(err);
        showResultModal({ ok: false, title: 'Purchase failed', message: err.message });
    } finally {
        updateBuyButton();
    }
});

// ===============================
// RESULT MODAL
// ===============================

function showResultModal({ ok, title, message }) {
    const content = $('#result-modal-content');
    content.innerHTML = `
        <div class="icon">${ok ? '✅' : '⚠️'}</div>
        <h3>${title}</h3>
        <div class="modal-msg">${message}</div>
        <button class="btn btn-primary" id="modal-close-btn">${ok ? 'Done' : 'Try again'}</button>
    `;
    $('#result-modal').classList.add('open');
    $('#modal-close-btn').addEventListener('click', () => {
        $('#result-modal').classList.remove('open');
    });
}

window.addEventListener('load', () => {
    hdhBulk.mount({ onChange: refreshBulkSummary });
    init();
});
