// =====================================================================
// js/electricity.js — Electricity page logic
// Relies on the global `client` from js/supabase.js and hdhRequestPin()
// from js/pin-modal.js. Mirrors js/cable.js's structure. provider_code
// (product_id) always comes from the database (electricity_plans) via
// lib/orderService.js#resolveElectricityOrder — never sent from here.
// =====================================================================

let session = null;
let allPlans = [];
let selectedDisco = null;
let meterType = 'prepaid';

function $(sel) { return document.querySelector(sel); }

function money(n) {
    return Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
        .select('wallet_balance')
        .eq('id', s.user.id)
        .maybeSingle();
    if (profile) $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;

    document.querySelectorAll('#meter-type-tabs button').forEach(btn => {
        btn.addEventListener('click', () => selectMeterType(btn.dataset.type, btn));
    });

    $('#meter-input').addEventListener('input', updateBuyButton);
    $('#amount-input').addEventListener('input', updateBuyButton);

    await loadDiscos();
}

function selectMeterType(type, btnEl) {
    meterType = type;
    document.querySelectorAll('#meter-type-tabs button').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
    renderDiscoTabs();
    updateBuyButton();
}

// ===============================
// LOAD DISCOS (filtered by meter type — a disco may only offer one)
// ===============================

async function loadDiscos() {
    try {
        const { data, error } = await client
            .from('electricity_plans')
            .select('*')
            .eq('status', 'active')
            .order('disco');

        if (error) throw error;
        allPlans = data || [];
        renderDiscoTabs();
    } catch (err) {
        $('#disco-tabs').innerHTML = '';
        $('#disco-tabs').appendChild(elEmpty(err.message));
    }
}

function renderDiscoTabs() {
    const tabs = $('#disco-tabs');
    tabs.innerHTML = '';
    selectedDisco = null;

    const discos = [...new Set(allPlans.filter(p => p.meter_type === meterType).map(p => p.disco))];

    if (discos.length === 0) {
        tabs.appendChild(elEmpty(`No discos available for ${meterType} yet.`));
        updateBuyButton();
        return;
    }

    discos.forEach((disco, i) => {
        const btn = document.createElement('button');
        btn.textContent = disco;
        if (i === 0) btn.classList.add('active');
        btn.addEventListener('click', () => selectDisco(disco, btn));
        tabs.appendChild(btn);
    });

    selectDisco(discos[0], tabs.querySelector('button'));
}

function selectDisco(disco, btnEl) {
    selectedDisco = disco;
    document.querySelectorAll('#disco-tabs button').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    updateBuyButton();
}

// ===============================
// BUY BUTTON STATE
// ===============================

function updateBuyButton() {
    const btn = $('#buy-btn');
    const meter = $('#meter-input').value.trim();
    const amount = Number($('#amount-input').value);

    if (!selectedDisco) {
        btn.disabled = true;
        btn.textContent = 'Select a disco first';
        return;
    }
    if (!meter) {
        btn.disabled = true;
        btn.textContent = 'Enter your meter number';
        return;
    }
    if (!amount || amount < 500) {
        btn.disabled = true;
        btn.textContent = 'Enter an amount (min ₦500)';
        return;
    }

    btn.disabled = false;
    btn.textContent = `Pay ₦${money(amount)} to ${selectedDisco}`;
}

// ===============================
// PURCHASE
// ===============================

$('#buy-btn').addEventListener('click', async () => {
    const meterNumber = $('#meter-input').value.trim();
    const amount = Number($('#amount-input').value);

    if (!meterNumber) { toast('Enter your meter number', 'err'); return; }
    if (!amount || amount < 500) { toast('Enter a valid amount', 'err'); return; }

    const pin = await hdhRequestPin();
    if (!pin) return;

    const orderBody = {
        type: 'electricity',
        disco: selectedDisco,
        meterType,
        meterNumber,
        amount,
        pin
    };

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
            body: JSON.stringify(orderBody)
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
            title: isPending ? 'Order submitted' : 'Payment successful',
            message: isPending
                ? 'Your electricity payment is being processed.'
                : `₦${money(amount)} sent to ${selectedDisco} for meter ${meterNumber}.`
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
        <p>${message}</p>
        <button class="btn btn-primary" id="modal-close-btn">${ok ? 'Done' : 'Try again'}</button>
    `;
    $('#result-modal').classList.add('open');
    $('#modal-close-btn').addEventListener('click', () => {
        $('#result-modal').classList.remove('open');
    });
}

window.addEventListener('load', init);
