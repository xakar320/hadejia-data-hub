// =====================================================================
// js/fund-wallet.js — Fund Wallet page logic
//
// SecureWave's dynamic account API is blocked pending BVN
// verification (see api/fund-wallet-init.js). Per decision, this page
// currently shows a Manual OPay transfer flow instead: the customer
// sees a static OPay account (from GET /api/manual-funding), uploads
// a receipt to Supabase Storage, then submits it via
// POST /api/manual-funding for admin review. The original SecureWave
// JS is preserved at the bottom of this file inside a comment for
// easy restoration once BVN is sorted.
// =====================================================================

let session = null;

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
    await loadOpayAccount();
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
// LOAD OPAY ACCOUNT DETAILS (public endpoint, no auth needed)
// ===============================

async function loadOpayAccount() {
    try {
        const res = await fetch('/api/manual-funding');
        const body = await res.json().catch(() => ({}));

        if (!res.ok || body.success === false || !body.data) {
            throw new Error((body.error && body.error.message) || 'Could not load account details');
        }

        const { accountNumber, bankName, accountName } = body.data;

        $('#opay-account-number').textContent = accountNumber || 'Not set up yet — contact support';
        $('#opay-bank-name').textContent = bankName || 'OPay';
        $('#opay-account-name').textContent = accountName || '—';
    } catch (err) {
        console.error(err);
        $('#opay-account-number').textContent = 'Could not load — please refresh';
    }
}

// ===============================
// COPY ACCOUNT NUMBER
// ===============================

$('#opay-account-number-row').addEventListener('click', () => {
    const accNum = $('#opay-account-number').textContent;
    navigator.clipboard.writeText(accNum).then(() => {
        toast('Account number copied');
    }).catch(() => {
        toast('Could not copy — copy it manually', 'err');
    });
});

// ===============================
// SUBMIT RECEIPT FOR REVIEW
// ===============================

$('#opay-submit-btn').addEventListener('click', async () => {
    const amount = Number($('#opay-amount-input').value) || undefined;
    const file = $('#opay-receipt-input').files[0];
    const note = $('#opay-note-input').value.trim();

    if (!file && !note) {
        toast('Please upload a receipt photo or type a note', 'err');
        return;
    }

    const btn = $('#opay-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
        let receiptPath;

        if (file) {
            const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
            const path = `${session.user.id}/${Date.now()}.${ext}`;

            const { error: uploadErr } = await client.storage.from('receipts').upload(path, file, {
                contentType: file.type || 'image/jpeg',
                upsert: false
            });

            if (uploadErr) throw new Error(`Could not upload receipt: ${uploadErr.message}`);
            receiptPath = path;
        }

        const res = await fetch('/api/manual-funding', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                amount_claimed: amount,
                receipt_path: receiptPath,
                receipt_note: note || undefined
            })
        });

        const body = await res.json().catch(() => ({}));

        if (!res.ok || body.success === false) {
            throw new Error((body.error && body.error.message) || `Failed to submit (HTTP ${res.status})`);
        }

        $('#opay-form-card').style.display = 'none';
        $('#opay-pending-notice').style.display = 'block';
        toast('Receipt submitted for review');

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Submit for Review';
    }
});

// ===============================
// START
// ===============================

window.addEventListener('load', init);

/* =====================================================================
   ORIGINAL SecureWave dynamic-account flow — kept for easy
   restoration once BVN verification is resolved. Not currently wired
   up (the elements it references — #amount-card, #generate-btn,
   #transfer-card, etc. — are commented out in fund-wallet.html too).

let pollTimer = null;
let countdownTimer = null;
let currentReference = null;

// Must match SECUREWAVE_FLAT_FEE on the server (api/securewave-webhook.js).
// This is only used to SHOW the customer what they'll actually receive —
// the real deduction happens server-side in the webhook, not here.
const FUNDING_FEE = 50;

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

function showTransferCard(data) {
    currentReference = data.reference;

    $('#amount-card').style.display = 'none';
    $('#transfer-card').style.display = 'block';

    $('#tr-amount').textContent = `₦${money(data.amount)}`;
    $('#tr-account-number').textContent = data.accountNumber;
    $('#tr-bank-name').textContent = data.bankName;
    $('#tr-account-name').textContent = data.accountName;

    const netAmount = Math.max(0, data.amount - FUNDING_FEE);
    $('#tr-fee-note').textContent =
        `A ₦${money(FUNDING_FEE)} service fee applies — ₦${money(netAmount)} will be credited to your wallet.`;

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

$('#account-number-row').addEventListener('click', () => {
    const accNum = $('#tr-account-number').textContent;
    navigator.clipboard.writeText(accNum).then(() => {
        toast('Account number copied');
    }).catch(() => {
        toast('Could not copy — copy it manually', 'err');
    });
});

$('#cancel-btn').addEventListener('click', () => {
    stopPolling();
    clearInterval(countdownTimer);
    $('#transfer-card').style.display = 'none';
    $('#amount-card').style.display = 'block';
    $('#amount-input').value = '';
    currentReference = null;
});

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
===================================================================== */
