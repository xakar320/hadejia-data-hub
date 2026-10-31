// =====================================================================
// js/data.js — Buy Data page logic
// Relies on the global `client` created in js/supabase.js. Buys a data
// bundle via POST /api/place-order with { type: "data", planId, phone }.
// Pricing, variation_code, and AutosyncNG's product_id all come from
// the data_plans row server-side — this page never sends or knows
// AutosyncNG catalog IDs.
// =====================================================================

let session = null;
let allPlans = [];
let selectedNetwork = null;
let selectedPlanType = null;
let selectedCategory = null;
let selectedPlan = null;
let isReseller = false;
let walletBalance = 0;
let refreshBulkRecent = null;
let phoneMode = 'single';      // 'single' | 'bulk'
let bulkNumbers = [];          // normalized, de-duplicated
const BULK_MAX = 50;

const UNCATEGORIZED = 'Other';

function $(sel) { return document.querySelector(sel); }

// The reseller price only applies when set (not null/undefined) —
// otherwise every plan without one would silently show ₦0 to resellers.
function displayPrice(plan) {
    if (isReseller && plan.reseller_price !== null && plan.reseller_price !== undefined) {
        return Number(plan.reseller_price);
    }
    return Number(plan.selling_price);
}

function money(n) {
    return Number(n || 0).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'ok' ? 'ok' : 'err'}`;
    t.textContent = msg;
    $('#toast-wrap').appendChild(t);
    setTimeout(() => t.remove(), 4200);
}

function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

    const { data: profile } = await client
        .from('users')
        .select('phone, wallet_balance, is_reseller')
        .eq('id', s.user.id)
        .maybeSingle();

    if (profile) {
        isReseller = !!profile.is_reseller;
        walletBalance = Number(profile.wallet_balance || 0);
        $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
        // NOTE: intentionally NOT auto-filling #phone-input with the
        // account's own phone. Doing so previously caused customers
        // buying for someone else (friend/family) to accidentally
        // submit with the pre-filled number still in the field,
        // sending the purchase to the wrong recipient. The HTML
        // placeholder ("0803xxxxxxx") is enough of a hint — every
        // customer now has to consciously type the real recipient
        // number every time.
    } else {
        $('#wallet-balance').textContent = '₦0.00';
    }

    await loadPlans();
}

// ===============================
// LOAD PLANS
// ===============================

async function loadPlans() {
    const list = $('#plan-list');

    try {
        const { data, error } = await client
            .from('data_plans')
            .select('*')
            .eq('status', 'active')
            .order('network')
            .order('selling_price');

        if (error) throw error;

        allPlans = data || [];

        if (allPlans.length === 0) {
            list.innerHTML = '';
            list.appendChild(elEmpty('No data plans are available right now.'));
            $('#network-tabs').innerHTML = '';
            return;
        }

        const networks = [...new Set(allPlans.map(p => p.network))];
        renderNetworkTabs(networks);
        selectedNetwork = networks[0];
        document.querySelectorAll('#network-tabs button').forEach(b => {
            b.classList.toggle('active', b.textContent === selectedNetwork);
        });
        renderPlanTypeOptions();

    } catch (err) {
        list.innerHTML = '';
        list.appendChild(elEmpty(err.message));
    }
}

// ===============================
// RENDER: NETWORK TABS
// ===============================

function renderNetworkTabs(networks) {
    const tabs = $('#network-tabs');
    tabs.innerHTML = '';

    networks.forEach(net => {
        const btn = document.createElement('button');
        btn.textContent = net;
        btn.className = net === selectedNetwork ? 'active' : '';

        btn.addEventListener('click', () => {
            selectedNetwork = net;
            selectedPlanType = null;
            selectedPlan = null;
            document.querySelectorAll('#network-tabs button').forEach(b => {
                b.classList.toggle('active', b.textContent === net);
            });
            renderPlanTypeOptions();
            updateBuyButton();
        });

        tabs.appendChild(btn);
    });
}

// ===============================
// RENDER: PLAN TYPE TABS (cascades from network — e.g. SME/Gifting/Transfer/Awoof)
// ===============================

function renderPlanTypeOptions() {
    const plansForNetwork = allPlans.filter(p => p.network === selectedNetwork);
    const types = [...new Set(plansForNetwork.map(p => p.plan_type || UNCATEGORIZED))];

    const field = $('#plan-type-field');
    const tabs = $('#plan-type-tabs');

    if (types.length <= 1) {
        // Nothing meaningful to choose between — skip straight to category/plans.
        field.style.display = 'none';
        selectedPlanType = types[0] || null;
        renderCategoryOptions();
        return;
    }

    field.style.display = 'block';
    tabs.innerHTML = '';
    selectedPlanType = types[0];

    types.forEach(type => {
        const btn = document.createElement('button');
        btn.textContent = type;
        btn.className = type === selectedPlanType ? 'active' : '';

        btn.addEventListener('click', () => {
            selectedPlanType = type;
            selectedPlan = null;
            document.querySelectorAll('#plan-type-tabs button').forEach(b => {
                b.classList.toggle('active', b.textContent === type);
            });
            renderCategoryOptions();
            updateBuyButton();
        });

        tabs.appendChild(btn);
    });

    renderCategoryOptions();
}

// ===============================
// RENDER: CATEGORY DROPDOWN (cascades from network + plan type)
// ===============================

function renderCategoryOptions() {
    const plansForType = allPlans.filter(p =>
        p.network === selectedNetwork &&
        (p.plan_type || UNCATEGORIZED) === selectedPlanType
    );
    const categories = [...new Set(plansForType.map(p => p.duration_category || UNCATEGORIZED))];

    const field = $('#category-field');
    const select = $('#category-select');

    if (categories.length <= 1) {
        // Nothing meaningful to choose between — skip straight to the plan list.
        field.style.display = 'none';
        selectedCategory = categories[0] || null;
        renderPlanList();
        return;
    }

    field.style.display = 'block';
    select.innerHTML = '';
    categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        select.appendChild(opt);
    });

    selectedCategory = categories[0];
    select.value = selectedCategory;
    renderPlanList();

    select.onchange = () => {
        selectedCategory = select.value;
        selectedPlan = null;
        renderPlanList();
        updateBuyButton();
    };
}

// ===============================
// RENDER: PLAN LIST
// ===============================

function renderPlanList() {
    const list = $('#plan-list');
    list.innerHTML = '';

    const plans = allPlans.filter(p =>
        p.network === selectedNetwork &&
        (p.plan_type || UNCATEGORIZED) === selectedPlanType &&
        (p.duration_category || UNCATEGORIZED) === selectedCategory
    );

    if (plans.length === 0) {
        list.appendChild(elEmpty(`No data plans for ${selectedNetwork} in this category right now.`));
        return;
    }

    plans.forEach(plan => {
        const row = document.createElement('div');
        row.className = 'plan-option' + (selectedPlan && selectedPlan.id === plan.id ? ' selected' : '');

        row.innerHTML = `
            <div>
                <div class="name">${plan.plan_name}</div>
                <div class="sub">${plan.data_size} · ${plan.validity}</div>
            </div>
            <div class="price mono">₦${money(displayPrice(plan))}</div>
        `;

        row.addEventListener('click', () => {
            selectedPlan = plan;
            updateBuyButton();
            renderPlanList();
            renderBulk();
        });

        list.appendChild(row);
    });
}

// ===============================
// BUY BUTTON STATE
// ===============================

function updateBuyButton() {
    const btn = $('#buy-btn');

    if (!selectedPlan) {
        btn.disabled = true;
        btn.textContent = 'Select a plan to continue';
        return;
    }

    if (phoneMode === 'bulk') {
        if (bulkNumbers.length === 0) {
            btn.disabled = true;
            btn.textContent = 'Add at least one number';
            return;
        }
        btn.disabled = false;
        btn.textContent = `Buy ${selectedPlan.plan_name} for ${bulkNumbers.length} number${bulkNumbers.length > 1 ? 's' : ''} — ₦${money(displayPrice(selectedPlan) * bulkNumbers.length)}`;
        return;
    }

    btn.disabled = false;
    btn.textContent = `Buy ${selectedPlan.plan_name} — ₦${money(displayPrice(selectedPlan))}`;
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

// Sends ONE order. Resolves with the transaction object, or throws an
// Error carrying .code (server error code) and .uncertain (true when we
// could not tell whether the order went through, e.g. network drop).
async function submitOrder({ phone, pin, requestRef }) {
    let res;
    try {
        res = await fetch('/api/place-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ type: 'data', planId: selectedPlan.id, phone, pin, request_ref: requestRef })
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

function newRequestRef(i) {
    return `DATA${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

// One purchase at a time: a second tap (or a second PIN pop-up) while an
// order is still being entered/processed must not start another order.
let hdhBuying = false;
async function buyDataBundle() {
    if (hdhBuying) return;
    hdhBuying = true;
    try { return await buyDataBundleImpl(); } finally { hdhBuying = false; }
}

async function buyDataBundleImpl() {
    if (phoneMode === 'bulk') return buyBulk();

    const rawPhone = $('#phone-input').value.trim();
    const phone = normalizeNgPhone(rawPhone);

    if (!phone) {
        toast('Enter a valid Nigerian phone number', 'err');
        return;
    }

    if (!selectedPlan) return;

    const pin = await hdhRequestPin();
    if (!pin) return; // cancelled

    const btn = $('#buy-btn');
    btn.disabled = true;
    btn.textContent = 'Processing…';

    try {
        const txn = await submitOrder({ phone, pin, requestRef: newRequestRef(0) });
        const isPending = txn && txn.status === 'pending';
        if (window.hdhRecent) hdhRecent.add(phone);

        // Bundle plan where only some parts were delivered: the server has
        // already refunded the undelivered part(s) to the wallet.
        if (txn && txn.partial) {
            showResultModal({
                ok: false,
                title: 'Partly delivered',
                message: `Part of your order was delivered. ₦${money(txn.partial.refundAmount)} was refunded to your wallet for: ${txn.partial.failedParts.map(n => esc(n)).join(', ')}.`
            });
            await refreshWallet();
            return;
        }

        showResultModal({
            ok: !isPending,
            title: isPending ? 'Order submitted' : 'Purchase successful',
            message: isPending
                ? 'Your data bundle is being processed. It will arrive shortly.'
                : `${esc(selectedPlan.data_size)} sent to ${phone}.`
        });

        await refreshWallet();

    } catch (err) {
        console.error(err);
        showResultModal({ ok: false, title: 'Purchase failed', message: esc(err.message) });
    } finally {
        updateBuyButton();
    }
}

// ===============================
// BULK PURCHASE
// ===============================

function setPhoneMode(mode) {
    phoneMode = mode;
    document.querySelectorAll('#mode-tabs button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    $('#single-box').style.display = mode === 'single' ? 'block' : 'none';
    $('#bulk-box').style.display = mode === 'bulk' ? 'block' : 'none';
    updateBuyButton();
}

function setBulkTab(tab) {
    document.querySelectorAll('#bulk-tabs button').forEach(b => b.classList.toggle('active', b.dataset.bt === tab));
    $('#bulk-manual').style.display = tab === 'manual' ? 'block' : 'none';
    $('#bulk-paste').style.display = tab === 'paste' ? 'block' : 'none';
}

// Returns 'added' | 'invalid' | 'duplicate' | 'full'
function addBulkNumber(raw) {
    const phone = normalizeNgPhone(raw);
    if (!phone) return 'invalid';
    if (bulkNumbers.includes(phone)) return 'duplicate';
    if (bulkNumbers.length >= BULK_MAX) return 'full';
    bulkNumbers.push(phone);
    return 'added';
}

function renderBulk() {
    const list = $('#bulk-list');
    list.innerHTML = '';

    bulkNumbers.forEach(num => {
        const chip = document.createElement('span');
        chip.className = 'bulk-chip';
        chip.innerHTML = `${esc(num)}<button type="button" aria-label="Remove ${esc(num)}">×</button>`;
        chip.querySelector('button').addEventListener('click', () => {
            bulkNumbers = bulkNumbers.filter(n => n !== num);
            renderBulk();
        });
        list.appendChild(chip);
    });

    const summary = $('#bulk-summary');
    if (bulkNumbers.length === 0) {
        summary.textContent = `No numbers added yet (up to ${BULK_MAX}).`;
    } else if (selectedPlan) {
        const each = displayPrice(selectedPlan);
        summary.textContent = `${bulkNumbers.length} number${bulkNumbers.length > 1 ? 's' : ''} × ₦${money(each)} = ₦${money(each * bulkNumbers.length)}`;
    } else {
        summary.textContent = `${bulkNumbers.length} number${bulkNumbers.length > 1 ? 's' : ''} added. Choose a plan to see the total.`;
    }

    if (refreshBulkRecent) refreshBulkRecent();

    updateBuyButton();
}

function onBulkAddManual() {
    const input = $('#bulk-phone-input');
    const result = addBulkNumber(input.value.trim());
    if (result === 'added') { input.value = ''; renderBulk(); input.focus(); return; }
    toast({
        invalid: 'Enter a valid Nigerian phone number',
        duplicate: 'That number is already in the list',
        full: `You can add at most ${BULK_MAX} numbers at a time`
    }[result], 'err');
}

function onBulkAddPaste() {
    const box = $('#bulk-paste-input');
    const parts = box.value.split(/[\s,;]+/).filter(Boolean);
    if (parts.length === 0) { toast('Paste at least one number', 'err'); return; }

    const counts = { added: 0, invalid: 0, duplicate: 0, full: 0 };
    parts.forEach(p => { counts[addBulkNumber(p)]++; });
    renderBulk();

    if (counts.added) box.value = '';
    const notes = [];
    if (counts.invalid) notes.push(`${counts.invalid} invalid`);
    if (counts.duplicate) notes.push(`${counts.duplicate} duplicate`);
    if (counts.full) notes.push(`${counts.full} over the ${BULK_MAX} limit`);
    toast(`${counts.added} added` + (notes.length ? ` · ${notes.join(', ')} skipped` : ''), counts.added ? 'ok' : 'err');
}

// Errors that mean "stop everything" — retrying the next number would
// just fail the same way (or, for a wrong PIN, risk locking the account).
const BULK_ABORT_CODES = ['INVALID_PIN', 'PIN_NOT_SET', 'MISSING_TOKEN', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'ACCOUNT_DELETED'];

async function buyBulk() {
    if (!selectedPlan || bulkNumbers.length === 0) return;

    const numbers = [...bulkNumbers];
    const total = displayPrice(selectedPlan) * numbers.length;

    if (total > walletBalance) {
        toast(`Insufficient balance: you need ₦${money(total)} but have ₦${money(walletBalance)}`, 'err');
        return;
    }

    if (!confirm(`Buy ${selectedPlan.plan_name} for ${numbers.length} number${numbers.length > 1 ? 's' : ''}?\nTotal: ₦${money(total)}`)) return;

    const pin = await hdhRequestPin();
    if (!pin) return;

    const btn = $('#buy-btn');
    btn.disabled = true;

    const done = [];        // { phone, pending }
    const failed = [];      // { phone, reason }
    let stoppedReason = null;
    let processed = 0;

    for (const phone of numbers) {
        btn.textContent = `Processing ${processed + 1} of ${numbers.length}…`;
        try {
            const txn = await submitOrder({ phone, pin, requestRef: newRequestRef(processed) });
            done.push({ phone, pending: !!(txn && txn.status === 'pending'), partial: (txn && txn.partial) || null });
            if (window.hdhRecent) hdhRecent.add(phone);
        } catch (err) {
            failed.push({ phone, reason: err.message });
            const insufficient = /insufficient/i.test(err.message || '');
            if (err.uncertain || insufficient || BULK_ABORT_CODES.includes(err.code)) {
                stoppedReason = err.uncertain
                    ? 'Stopped because the connection dropped — check Transactions before retrying.'
                    : `Stopped: ${err.message}`;
                processed++;
                break;
            }
        }
        processed++;
    }

    const notAttempted = numbers.slice(processed);

    // Keep only what still needs attention in the list, so a retry
    // can never double-buy the numbers that already went through.
    const finished = new Set(done.map(d => d.phone));
    bulkNumbers = bulkNumbers.filter(n => !finished.has(n));
    renderBulk();

    const okCount = done.length;
    const pendingCount = done.filter(d => d.pending).length;

    let html = `<div><b>${okCount}</b> of ${numbers.length} sent` + (pendingCount ? ` (${pendingCount} still processing)` : '') + '.</div>';
    html += '<div class="bulk-results">';
    done.forEach(d => {
        if (d.partial) html += `<div>⚠️ ${esc(d.phone)} — partly delivered, ₦${money(d.partial.refundAmount)} refunded (${esc((d.partial.failedParts || []).join(', '))})</div>`;
        else html += `<div>✅ ${esc(d.phone)}${d.pending ? ' — processing' : ''}</div>`;
    });
    failed.forEach(f => { html += `<div>❌ ${esc(f.phone)} — ${esc(f.reason)}</div>`; });
    notAttempted.forEach(n => { html += `<div>⏸️ ${esc(n)} — not attempted</div>`; });
    html += '</div>';
    if (stoppedReason) html += `<p style="margin-top:10px;">${esc(stoppedReason)}</p>`;
    if (failed.length || notAttempted.length) html += '<p style="margin-top:10px;">You were not charged for failed numbers (any debit was refunded). They are kept in your list so you can try again.</p>';

    const allGood = failed.length === 0 && notAttempted.length === 0 && !done.some(d => d.partial);
    showResultModal({
        ok: allGood,
        title: allGood ? 'Bulk purchase complete' : 'Bulk purchase finished with issues',
        message: html,
        keepSelection: true
    });

    try { await refreshWallet(); } catch (_) { /* balance refresh is cosmetic */ }
    updateBuyButton();
}

// ===============================
// RESULT MODAL
// ===============================

function showResultModal({ ok, title, message, keepSelection = false }) {
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
        if (ok && !keepSelection) {
            selectedPlan = null;
            renderPlanList();
            updateBuyButton();
        }
    });
}

// ===============================
// START
// ===============================

window.addEventListener('load', () => {
    init();
    $('#buy-btn').addEventListener('click', buyDataBundle);

    document.querySelectorAll('#mode-tabs button').forEach(b => b.addEventListener('click', () => setPhoneMode(b.dataset.mode)));
    document.querySelectorAll('#bulk-tabs button').forEach(b => b.addEventListener('click', () => setBulkTab(b.dataset.bt)));
    $('#bulk-add-btn').addEventListener('click', onBulkAddManual);
    $('#bulk-phone-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onBulkAddManual(); } });
    $('#bulk-paste-btn').addEventListener('click', onBulkAddPaste);
    if (window.hdhRecent) {
        const single = $('#phone-input');
        hdhRecent.bind(single, $('#single-recent'), () => [], (n) => {
            single.value = n;
            $('#single-recent').innerHTML = '';
        });
        const bulkInput = $('#bulk-phone-input');
        refreshBulkRecent = hdhRecent.bind(bulkInput, $('#bulk-recent'), () => bulkNumbers, (n) => {
            if (addBulkNumber(n) === 'full') toast(`You can add at most ${BULK_MAX} numbers at a time`, 'err');
            bulkInput.value = '';
            renderBulk();
        });
    }
    renderBulk();
});
