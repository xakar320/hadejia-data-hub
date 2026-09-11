// =====================================================================
// js/withdraw.js — Customer Withdrawal page logic
// Relies on the global `client` from js/supabase.js and hdhRequestPin()
// from js/pin-modal.js. Every action goes through POST /api/withdrawals
// with a body.action field (see api/withdrawals.js for the full list).
// =====================================================================

let session = null;
let verifiedAccount = null; // { accountName, accountNumber } once validated
let selectedBank = null;    // { name, bankCode } for the bank currently selected

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

async function callApi(action, extra = {}) {
    const res = await fetch('/api/withdrawals', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ action, ...extra })
    });

    let body;
    try {
        body = await res.json();
    } catch (parseErr) {
        const text = await res.text().catch(() => '');
        throw new Error(`Server did not return a valid response (HTTP ${res.status}). ${text ? text.slice(0, 200) : ''}`);
    }

    if (!res.ok || body.success === false) {
        throw new Error((body.error && body.error.message) || `Request failed (HTTP ${res.status})`);
    }

    return body.data;
}

// ===============================
// INIT
// ===============================

async function init() {
    const { data: { session: s } } = await client.auth.getSession();
    if (!s) { location.href = 'index.html'; return; }
    session = s;

    await refreshBalance();
    await loadBankInfo();

    $('#account-number-input').addEventListener('input', onBankFieldsChanged);
    $('#bank-select').addEventListener('change', onBankFieldsChanged);
    $('#amount-input').addEventListener('input', updateFeeEstimate);
}

// Mirrors the tiered fee in lib/withdrawalService.js — for display
// only. The server always recalculates the authoritative fee.
function calculateFeeEstimate(amount) {
    return amount < 10000 ? 50 : 100;
}

function updateFeeEstimate() {
    const amount = Number($('#amount-input').value || 0);
    const feeBox = $('#fee-box');

    if (amount > 0) {
        const fee = calculateFeeEstimate(amount);
        $('#fee-amount').textContent = `₦${money(fee)}`;
        $('#total-debit-amount').textContent = `₦${money(amount + fee)}`;
        feeBox.style.display = 'block';
    } else {
        feeBox.style.display = 'none';
    }
}

async function refreshBalance() {
    const { data: profile } = await client
        .from('users')
        .select('wallet_balance')
        .eq('id', session.user.id)
        .maybeSingle();
    if (profile) $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
}

async function loadBankInfo() {
    try {
        const info = await callApi('bank-info');
        if (info) {
            showBankOnFile(info);
        } else {
            await showBankForm();
        }
    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
        await showBankForm();
    }
}

function showBankOnFile(info) {
    $('#on-file-bank').textContent = info.bankName;
    $('#on-file-account').textContent = info.accountNumber;
    $('#on-file-name').textContent = info.accountName;
    $('#bank-on-file-card').style.display = 'block';
    $('#bank-form').style.display = 'none';
    $('#withdraw-card').style.display = 'block';
}

async function showBankForm() {
    $('#bank-on-file-card').style.display = 'none';
    $('#withdraw-card').style.display = 'none';
    $('#bank-form').style.display = 'block';
    $('#verified-name').textContent = '';
    $('#save-bank-btn').style.display = 'none';
    verifiedAccount = null;

    const select = $('#bank-select');
    select.innerHTML = '<option value="">Loading banks…</option>';

    try {
        const banks = await callApi('banks');
        select.innerHTML = '<option value="">Select your bank</option>' +
            banks.map(b => `<option value="${b.bankCode}" data-name="${b.name}">${b.name}</option>`).join('');
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">Failed to load banks</option>';
    }
}

$('#change-bank-btn').addEventListener('click', showBankForm);

// ===============================
// VERIFY ACCOUNT
// ===============================

function onBankFieldsChanged() {
    const bankCode = $('#bank-select').value;
    const accountNumber = $('#account-number-input').value.trim();
    const btn = $('#verify-btn');

    verifiedAccount = null;
    $('#verified-name').textContent = '';
    $('#save-bank-btn').style.display = 'none';

    if (bankCode && /^\d{10}$/.test(accountNumber)) {
        btn.disabled = false;
        btn.textContent = 'Verify Account';
    } else {
        btn.disabled = true;
        btn.textContent = 'Enter bank details to verify';
    }
}

$('#verify-btn').addEventListener('click', async () => {
    const bankSelect = $('#bank-select');
    const bankCode = bankSelect.value;
    const bankName = bankSelect.selectedOptions[0].dataset.name;
    const accountNumber = $('#account-number-input').value.trim();

    const btn = $('#verify-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';

    try {
        const result = await callApi('validate-account', { bankCode, accountNumber });
        verifiedAccount = { accountName: result.accountName, accountNumber: result.accountNumber };
        selectedBank = { name: bankName, bankCode };

        $('#verified-name').textContent = `✅ ${result.accountName}`;
        $('#save-bank-btn').style.display = 'block';
        btn.textContent = 'Verify Account';

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
        btn.textContent = 'Verify Account';
    } finally {
        btn.disabled = false;
    }
});

// ===============================
// SAVE BANK INFO
// ===============================

$('#save-bank-btn').addEventListener('click', async () => {
    if (!verifiedAccount || !selectedBank) return;

    const btn = $('#save-bank-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        await callApi('save-bank-info', {
            bankName: selectedBank.name,
            accountName: verifiedAccount.accountName,
            bankCode: selectedBank.bankCode,
            accountNumber: verifiedAccount.accountNumber
        });

        toast('Bank account saved', 'ok');
        await loadBankInfo();

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save this account';
    }
});

// ===============================
// WITHDRAW
// ===============================

$('#withdraw-btn').addEventListener('click', async () => {
    const amount = Number($('#amount-input').value || 0);

    if (!amount || amount < 100) {
        toast('Enter at least ₦100', 'err');
        return;
    }

    const pin = await hdhRequestPin();
    if (!pin) return;

    const btn = $('#withdraw-btn');
    btn.disabled = true;
    btn.textContent = 'Processing…';

    try {
        const result = await callApi('withdraw', { pin, amount });

        showResultModal({
            ok: true,
            title: 'Withdrawal Submitted',
            message: `₦${money(result.amount)} is being sent to ${result.bankName} — ${result.accountNumber} (₦${money(result.fee)} fee, ₦${money(result.totalDebited)} debited). This may take a few minutes.`
        });

        $('#amount-input').value = '';
        await refreshBalance();

    } catch (err) {
        console.error(err);
        showResultModal({ ok: false, title: 'Withdrawal Failed', message: err.message });
        await refreshBalance();
    } finally {
        btn.disabled = false;
        btn.textContent = 'Withdraw';
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
