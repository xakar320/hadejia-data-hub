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

async function buyDataBundle() {
    const phone = $('#phone-input').value.trim();

    if (!/^0[7-9][01]\d{8}$/.test(phone)) {
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
            body: JSON.stringify({ type: 'data', planId: selectedPlan.id, phone, pin })
        });

        let body;
        try {
            body = await res.json();
        } catch (parseErr) {
            const text = await res.text().catch(() => '');
            throw new Error(
                `Server did not return a valid response (HTTP ${res.status}). ` +
                `This usually means an environment variable is missing on Vercel. ` +
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
                ? 'Your data bundle is being processed. It will arrive shortly.'
                : `${selectedPlan.data_size} sent to ${phone}.`
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
    $('#buy-btn').addEventListener('click', buyDataBundle);
});
