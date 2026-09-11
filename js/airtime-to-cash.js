// =====================================================================
// js/airtime-to-cash.js — Airtime to Cash page logic
// Relies on the global `client` from js/supabase.js and hdhRequestPin()
// from js/pin-modal.js.
//
// Two-step flow against the backend:
//   1. POST /api/airtime-to-cash-initiate  -> sends OTP, returns { reference }
//   2. POST /api/airtime-to-cash-complete  -> confirms OTP, credits wallet
// POST /api/airtime-to-cash-resend-otp resends the OTP for a pending reference.
//
// The rate/estimate shown here (from airtime_cash_plans) is for the
// user's benefit only — the authoritative rate is always re-applied
// server-side in lib/airtimeCashService.js before any wallet credit,
// and the ACTUAL credited amount is based on what AutosyncNG reports
// was really shared (partial completion), not this estimate.
// =====================================================================

let session = null;
let plans = [];
let currentReference = null;

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

function currentPlan() {
    const productId = $('#network-select').value;
    return plans.find(p => p.product_id === productId) || null;
}

// ===============================
// INIT
// ===============================

async function init() {
    const { data: { session: s } } = await client.auth.getSession();
    if (!s) { location.href = 'index.html'; return; }
    session = s;

    await refreshBalance();

    try {
        const { data, error } = await client
            .from('airtime_cash_plans')
            .select('*')
            .eq('status', 'active')
            .order('network', { ascending: true });
        if (error) throw error;

        plans = data || [];
        const select = $('#network-select');

        if (plans.length === 0) {
            select.innerHTML = '<option value="">Not available right now</option>';
            $('#initiate-btn').textContent = 'Airtime to Cash is not available right now';
        } else {
            select.innerHTML = '<option value="">Select network</option>' +
                plans.map(p => `<option value="${p.product_id}">${p.network}</option>`).join('');
        }
    } catch (err) {
        console.error(err);
        $('#network-select').innerHTML = '<option value="">Failed to load networks</option>';
    }

    $('#network-select').addEventListener('change', updateEstimate);
    $('#amount-input').addEventListener('input', updateEstimate);
    $('#phone-input').addEventListener('input', updateEstimate);
    $('#share-pin-input').addEventListener('input', updateEstimate);

    updateEstimate();
}

async function refreshBalance() {
    const { data: profile } = await client
        .from('users')
        .select('wallet_balance')
        .eq('id', session.user.id)
        .maybeSingle();
    if (profile) $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
}

// ===============================
// LIVE ESTIMATE
// ===============================

function updateEstimate() {
    const plan = currentPlan();
    const amount = Number($('#amount-input').value || 0);
    const phone = $('#phone-input').value.trim();
    const sharePin = $('#share-pin-input').value.trim();
    const btn = $('#initiate-btn');
    const costBox = $('#cost-box');

    if (plan) {
        const minMax = [
            plan.min_amount != null ? `Min ₦${money(plan.min_amount)}` : null,
            plan.max_amount != null ? `Max ₦${money(plan.max_amount)}` : null
        ].filter(Boolean).join(' · ');
        $('#rate-hint').textContent = `Rate: ${plan.rate_percent}% of airtime value${minMax ? ' · ' + minMax : ''}`;
    } else {
        $('#rate-hint').textContent = '';
    }

    if (plan && amount > 0) {
        const estimated = Math.round(amount * (Number(plan.rate_percent) / 100) * 100) / 100;
        $('#cost-amount').textContent = `₦${money(estimated)}`;
        costBox.style.display = 'block';
    } else {
        costBox.style.display = 'none';
    }

    if (!plan) {
        btn.disabled = true;
        return;
    }

    const amountValid = amount > 0 &&
        (plan.min_amount == null || amount >= Number(plan.min_amount)) &&
        (plan.max_amount == null || amount <= Number(plan.max_amount));

    if (plan && phone && amountValid && /^\d{4,6}$/.test(sharePin)) {
        btn.disabled = false;
        btn.textContent = 'Convert to Cash';
    } else {
        btn.disabled = true;
        btn.textContent = 'Fill in the details above';
    }
}

// ===============================
// STEP 1: INITIATE
// ===============================

$('#initiate-btn').addEventListener('click', async () => {
    const plan = currentPlan();
    const phone = $('#phone-input').value.trim();
    const amount = Number($('#amount-input').value || 0);
    const sharePin = $('#share-pin-input').value.trim();

    if (!plan || !phone || !amount || !sharePin) {
        toast('Please fill in every field', 'err');
        return;
    }

    const pin = await hdhRequestPin();
    if (!pin) return;

    const btn = $('#initiate-btn');
    btn.disabled = true;
    btn.textContent = 'Sending OTP…';

    try {
        const res = await fetch('/api/airtime-to-cash', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                step: 'initiate',
                pin,
                productId: plan.product_id,
                phone,
                amount,
                sharePin
            })
        });

        const body = await parseJsonSafely(res);

        if (!res.ok || body.success === false) {
            throw new Error((body.error && body.error.message) || `Request failed (HTTP ${res.status})`);
        }

        currentReference = body.data.reference;
        $('#request-step').style.display = 'none';
        $('#otp-step').style.display = 'block';
        toast(body.data.message || 'OTP sent', 'ok');

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
    } finally {
        updateEstimate();
    }
});

// ===============================
// STEP 2: CONFIRM OTP
// ===============================

$('#confirm-btn').addEventListener('click', async () => {
    const otp = $('#otp-input').value.trim();
    if (!otp) {
        toast('Enter the OTP', 'err');
        return;
    }
    if (!currentReference) {
        toast('Something went wrong — please start again', 'err');
        resetToRequestStep();
        return;
    }

    const btn = $('#confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Confirming…';

    try {
        const res = await fetch('/api/airtime-to-cash', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ step: 'complete', reference: currentReference, otp })
        });

        const body = await parseJsonSafely(res);

        if (!res.ok || body.success === false) {
            throw new Error((body.error && body.error.message) || `Confirmation failed (HTTP ${res.status})`);
        }

        showResultModal({
            ok: true,
            title: 'Cash received!',
            message: `₦${money(body.data.creditAmount)} has been added to your wallet.`
        });

        await refreshBalance();
        resetToRequestStep();

    } catch (err) {
        console.error(err);
        showResultModal({ ok: false, title: 'Confirmation failed', message: err.message });
    } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm';
    }
});

// ===============================
// RESEND OTP
// ===============================

$('#resend-btn').addEventListener('click', async () => {
    if (!currentReference) return;

    const btn = $('#resend-btn');
    btn.disabled = true;

    try {
        const res = await fetch('/api/airtime-to-cash', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ step: 'resend-otp', reference: currentReference })
        });

        const body = await parseJsonSafely(res);

        if (!res.ok || body.success === false) {
            throw new Error((body.error && body.error.message) || `Resend failed (HTTP ${res.status})`);
        }

        toast(body.data.message || 'OTP resent', 'ok');

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
    } finally {
        btn.disabled = false;
    }
});

// ===============================
// HELPERS
// ===============================

async function parseJsonSafely(res) {
    try {
        return await res.json();
    } catch (parseErr) {
        const text = await res.text().catch(() => '');
        throw new Error(`Server did not return a valid response (HTTP ${res.status}). ${text ? text.slice(0, 200) : ''}`);
    }
}

function resetToRequestStep() {
    currentReference = null;
    $('#otp-input').value = '';
    $('#phone-input').value = '';
    $('#amount-input').value = '';
    $('#share-pin-input').value = '';
    $('#otp-step').style.display = 'none';
    $('#request-step').style.display = 'block';
    updateEstimate();
}

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
