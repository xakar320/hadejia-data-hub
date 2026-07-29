// =====================================================================
// js/cable.js — Cable TV page logic
// Relies on the global `client` from js/supabase.js and hdhRequestPin()
// from js/pin-modal.js. Two modes:
//   - "renew": pay an outstanding bill (customer-entered amount)
//   - "change": switch to a specific package (fixed plan price)
// product_id always comes from the database — never sent from here.
// =====================================================================

let session = null;
let allPlans = [];
let mode = 'renew';
let selectedProvider = null;
let selectedPackage = null;

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

    document.querySelectorAll('#mode-tabs button').forEach(btn => {
        btn.addEventListener('click', () => switchMode(btn.dataset.mode, btn));
    });

    $('#amount-input').addEventListener('input', updateBuyButton);
    $('#iuc-input').addEventListener('input', updateBuyButton);

    await loadPlans();
}

function switchMode(newMode, btnEl) {
    mode = newMode;
    document.querySelectorAll('#mode-tabs button').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');

    $('#renew-section').style.display = mode === 'renew' ? 'block' : 'none';
    $('#change-section').style.display = mode === 'change' ? 'block' : 'none';

    selectedPackage = null;
    if (mode === 'change' && selectedProvider) renderPackageList();
    updateBuyButton();
}

// ===============================
// LOAD PROVIDERS + PACKAGES
// ===============================

async function loadPlans() {
    const tabs = $('#provider-tabs');
    tabs.innerHTML = '';

    try {
        const { data, error } = await client
            .from('cable_plans')
            .select('*')
            .eq('status', 'active')
            .order('provider')
            .order('selling_price');

        if (error) throw error;

        allPlans = data || [];

        if (allPlans.length === 0) {
            tabs.appendChild(elEmpty('Cable TV payments are not available right now.'));
            return;
        }

        const providers = [...new Set(allPlans.map(p => p.provider))];
        providers.forEach((prov, i) => {
            const btn = document.createElement('button');
            btn.textContent = prov;
            if (i === 0) btn.classList.add('active');
            btn.addEventListener('click', () => selectProvider(prov, btn));
            tabs.appendChild(btn);
        });

        selectProvider(providers[0], tabs.querySelector('button'));

    } catch (err) {
        tabs.innerHTML = '';
        tabs.appendChild(elEmpty(err.message));
    }
}

function selectProvider(provider, btnEl) {
    selectedProvider = provider;
    selectedPackage = null;
    document.querySelectorAll('#provider-tabs button').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    if (mode === 'change') renderPackageList();
    updateBuyButton();
}

function renderPackageList() {
    const list = $('#package-list');
    list.innerHTML = '';

    const packages = allPlans.filter(p => p.provider === selectedProvider);

    if (packages.length === 0) {
        list.appendChild(elEmpty(`No packages configured for ${selectedProvider} yet.`));
        return;
    }

    packages.forEach(pkg => {
        const row = document.createElement('div');
        row.className = 'plan-option' + (selectedPackage && selectedPackage.id === pkg.id ? ' selected' : '');
        row.innerHTML = `
            <div>
                <div class="name">${pkg.package_name}</div>
            </div>
            <div class="price mono">₦${money(pkg.selling_price)}</div>
        `;
        row.addEventListener('click', () => {
            selectedPackage = pkg;
            updateBuyButton();
            renderPackageList();
        });
        list.appendChild(row);
    });
}

// ===============================
// BUY BUTTON STATE
// ===============================

function updateBuyButton() {
    const btn = $('#buy-btn');
    const iuc = $('#iuc-input').value.trim();

    if (!selectedProvider || !iuc) {
        btn.disabled = true;
        btn.textContent = 'Select a provider first';
        return;
    }

    if (mode === 'renew') {
        const amount = Number($('#amount-input').value);
        if (amount >= 100) {
            btn.disabled = false;
            btn.textContent = `Pay ₦${money(amount)} to ${selectedProvider}`;
        } else {
            btn.disabled = true;
            btn.textContent = 'Enter an amount (min ₦100)';
        }
    } else {
        if (selectedPackage) {
            btn.disabled = false;
            btn.textContent = `Subscribe — ₦${money(selectedPackage.selling_price)}`;
        } else {
            btn.disabled = true;
            btn.textContent = 'Select a package';
        }
    }
}

// ===============================
// PURCHASE
// ===============================

$('#buy-btn').addEventListener('click', async () => {
    const iucNumber = $('#iuc-input').value.trim();
    if (!iucNumber) { toast('Enter your smartcard/IUC number', 'err'); return; }

    const orderBody = { type: 'cable', cableType: mode, iucNumber };

    if (mode === 'renew') {
        const amount = Number($('#amount-input').value);
        if (!amount || amount < 100) { toast('Enter a valid amount', 'err'); return; }
        orderBody.network = selectedProvider;
        orderBody.amount = amount;
    } else {
        if (!selectedPackage) { toast('Select a package', 'err'); return; }
        orderBody.planId = selectedPackage.id;
    }

    const pin = await hdhRequestPin();
    if (!pin) return;
    orderBody.pin = pin;

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
            title: isPending ? 'Order submitted' : 'Purchase successful',
            message: isPending
                ? 'Your cable subscription is being processed.'
                : `${selectedProvider} subscription updated for smartcard ${iucNumber}.`
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
