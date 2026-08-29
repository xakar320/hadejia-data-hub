// =====================================================================
// js/voice.js — Buy Voice Bundle page logic
// Relies on the global `client` created in js/supabase.js (loaded
// before this file). Buys a voice bundle via POST /api/place-order
// with { type: "voice", planId, phone }. Pricing, variation_code, and
// AutosyncNG's product_id all come from the voice_plans row server-
// side — this page never sends or knows AutosyncNG catalog IDs.
// =====================================================================

let session = null;
let allPlans = [];
let selectedNetwork = null;
let selectedCategory = null;
let selectedPlan = null;

const UNCATEGORIZED = 'Other';

function $(sel) { return document.querySelector(sel); }

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

    // Prefill phone with the account's own number, and show wallet balance.
    const { data: profile } = await client
        .from('users')
        .select('phone, wallet_balance')
        .eq('id', s.user.id)
        .maybeSingle();

    if (profile) {
        $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
        if (profile.phone) $('#phone-input').value = profile.phone;
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
            .from('voice_plans')
            .select('*')
            .eq('status', 'active')
            .order('network')
            .order('selling_price');

        if (error) throw error;

        allPlans = data || [];

        if (allPlans.length === 0) {
            list.innerHTML = '';
            list.appendChild(elEmpty('No voice bundles are available right now.'));
            $('#network-tabs').innerHTML = '';
            return;
        }

        const networks = [...new Set(allPlans.map(p => p.network))];
        renderNetworkTabs(networks);
        selectedNetwork = networks[0];
        document.querySelectorAll('#network-tabs button').forEach(b => {
            b.classList.toggle('active', b.textContent === selectedNetwork);
        });
        renderCategoryOptions();

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
            selectedPlan = null;

            document.querySelectorAll('#network-tabs button').forEach(b => {
                b.classList.toggle('active', b.textContent === net);
            });

            renderCategoryOptions();
            updateBuyButton();
        });

        tabs.appendChild(btn);
    });
}

// ===============================
// RENDER: CATEGORY DROPDOWN (cascades from network)
// ===============================

function renderCategoryOptions() {
    const plansForNetwork = allPlans.filter(p => p.network === selectedNetwork);
    const categories = [...new Set(plansForNetwork.map(p => p.duration_category || UNCATEGORIZED))];

    const field = $('#category-field');
    const select = $('#category-select');

    if (categories.length <= 1) {
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
        (p.duration_category || UNCATEGORIZED) === selectedCategory
    );

    if (plans.length === 0) {
        list.appendChild(elEmpty(`No voice bundles for ${selectedNetwork} in this category right now.`));
        return;
    }

    plans.forEach(plan => {
        const row = document.createElement('div');
        row.className = 'plan-option' + (selectedPlan && selectedPlan.id === plan.id ? ' selected' : '');

        row.innerHTML = `
            <div>
                <div class="name">${plan.plan_name}</div>
                <div class="sub">${plan.minutes} minutes · ${plan.validity}</div>
            </div>
            <div class="price mono">₦${money(plan.selling_price)}</div>
        `;

        row.addEventListener('click', () => {
            selectedPlan = plan;
            updateBuyButton();
            renderPlanList();
        });

        list.appendChild(row);
    });
}

// ===============================
// BUY BUTTON STATE
// ===============================

function updateBuyButton() {
    const btn = $('#buy-btn');

    if (selectedPlan) {
        btn.disabled = false;
        btn.textContent = `Buy ${selectedPlan.plan_name} — ₦${money(selectedPlan.selling_price)}`;
    } else {
        btn.disabled = true;
        btn.textContent = 'Select a plan to continue';
    }
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

async function buyVoiceBundle() {
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
        const res = await fetch('/api/place-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                type: 'voice',
                planId: selectedPlan.id,
                phone: phone,
                pin: pin
            })
        });

        let body;
        let rawText = null;

        try {
            body = await res.json();
        } catch (parseErr) {
            // The server didn't return JSON at all — most commonly this
            // means the serverless function crashed before it could run
            // (e.g. a required environment variable like AUTOSYNC_API_KEY
            // or SUPABASE_SERVICE_ROLE_KEY is missing on Vercel), so
            // Vercel served its own generic error page instead of our
            // JSON error format. Surface that clearly instead of a bare
            // "Purchase failed".
            rawText = await res.text().catch(() => '');
            throw new Error(
                `Server did not return a valid response (HTTP ${res.status}). ` +
                `This usually means an environment variable is missing on Vercel. ` +
                (rawText ? `Details: ${rawText.slice(0, 200)}` : '')
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
                ? 'Your voice bundle is being processed. It will arrive shortly.'
                : `${selectedPlan.minutes} minutes sent to ${phone}.`
        });

        // Refresh balance after a successful/pending debit.
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
}

// ===============================
// RESULT MODAL
// ===============================

function showResultModal({ ok, title, message }) {
    const content = $('#result-modal-content');

    content.innerHTML = `
        <div class="icon">${ok ? '✅' : '⚠️'}</div>
        <h3>${title}</h3>
        <p>${message}</p>
        <button class="btn btn-primary" id="modal-close-btn">${ok ? 'Done' : 'Try again'}</button>
    `;

    $('#result-modal').classList.add('open');

    $('#modal-close-btn').addEventListener('click', () => {
        $('#result-modal').classList.remove('open');
        if (ok) {
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
    $('#buy-btn').addEventListener('click', buyVoiceBundle);
});
