// =====================================================================
// js/fund-wallet.js — Fund Wallet page logic
// Relies on the global `client` from js/supabase.js. Calls
// POST /api/fund-wallet-init to generate a SecureWaveNG dynamic
// virtual account, then polls Supabase directly for the matching
// transaction to flip to 'success' (written by api/securewave-webhook.js
// once the transfer lands).
// =====================================================================

let session = null;
let pollTimer = null;
let countdownTimer = null;
let currentReference = null;

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
    await refreshBalance();
}

async function refreshBalance() {
    const { data: profile } = await client
        .from('users')
        .select('wallet_balance')
        .eq('id', session.user.id)
        .maybeSingle();

    $('#wallet-balance').textContent = `₦${money(profile ? profile.wallet_balance : 0)}`;
}

// ===============================
// GENERATE VIRTUAL ACCOUNT
// ===============================

$('#generate-btn').addEventListener('click', async () => {
    const amount = Number($('#amount-input').value);

    if (!amount || amount < 100) {
        toast('Enter an amount of at least ₦100', 'err');
        return;
    }

    const btn = $('#generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';

    try {
        const res = await fetch('/api/fund-wallet-init', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ amount })
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
            throw new Error((body.error && body.error.message) || `Failed to generate account (HTTP ${res.status})`);
        }

        showTransferCard(body.data);

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Transfer Account';
    }
});

// ===============================
// SHOW TRANSFER CARD + START POLLING/COUNTDOWN
// ===============================

function showTransferCard(data) {
    currentReference = data.reference;

    $('#amount-card').style.display = 'none';
    $('#transfer-card').style.display = 'block';

    $('#tr-amount').textContent = `₦${money(data.amount)}`;
    $('#tr-account-number').textContent = data.accountNumber;
    $('#tr-bank-name').textContent = data.bankName;
    $('#tr-account-name').textContent = data.accountName;

    startCountdown(data.expiresInSeconds || 900);
    startPolling(data.reference);
}

function startCountdown(seconds) {
    clearInterval(countdownTimer);
    let remaining = seconds;

    function render() {
        const m = Math.floor(remaining / 60).toString().padStart(2, '0');
        const s = (remaining % 60).toString().padStart(2, '0');
        $('#tr-countdown').textContent = `${m}:${s}`;
    }
    render();

    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearInterval(countdownTimer);
            $('#tr-status').innerHTML = '⚠️ This account has expired. Please start over.';
            stopPolling();
            return;
        }
        render();
    }, 1000);
}

function startPolling(reference) {
    clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
        try {
            const { data: txns, error } = await client
                .from('transactions')
                .select('id, status')
                .eq('user_id', session.user.id)
                .eq('type', 'wallet_funding')
                .filter('request_payload->>account_reference', 'eq', reference)
                .order('created_at', { ascending: false })
                .limit(1);

            if (error) throw error;

            const txn = txns && txns[0];
            if (txn && txn.status === 'success') {
                stopPolling();
                clearInterval(countdownTimer);
                await refreshBalance();
                showResultModal({
                    ok: true,
                    title: 'Payment received!',
                    message: 'Your wallet has been credited.'
                });
            }
        } catch (err) {
            console.error('Poll error:', err);
        }
    }, 5000);
}

function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
}

// ===============================
// COPY ACCOUNT NUMBER
// ===============================

$('#account-number-row').addEventListener('click', () => {
    const accNum = $('#tr-account-number').textContent;
    navigator.clipboard.writeText(accNum).then(() => {
        toast('Account number copied');
    }).catch(() => {
        toast('Could not copy — copy it manually', 'err');
    });
});

// ===============================
// CANCEL / START OVER
// ===============================

$('#cancel-btn').addEventListener('click', () => {
    stopPolling();
    clearInterval(countdownTimer);
    $('#transfer-card').style.display = 'none';
    $('#amount-card').style.display = 'block';
    $('#amount-input').value = '';
    currentReference = null;
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
        <button class="btn btn-primary" id="modal-close-btn">Done</button>
    `;

    $('#result-modal').classList.add('open');

    $('#modal-close-btn').addEventListener('click', () => {
        $('#result-modal').classList.remove('open');
        if (ok) {
            $('#transfer-card').style.display = 'none';
            $('#amount-card').style.display = 'block';
            $('#amount-input').value = '';
        }
    });
}

// ===============================
// START
// ===============================

window.addEventListener('load', init);
