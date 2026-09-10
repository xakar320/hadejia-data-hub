// =====================================================================
// js/sms.js — Send SMS page logic
// Relies on the global `client` from js/supabase.js and hdhRequestPin()
// from js/pin-modal.js. Sends SMS via POST /api/place-order with
// { type: "sms", recipients, message, senderId, pin }.
//
// Pricing shown here (from sms_plans) is an ESTIMATE for the user's
// benefit only — the authoritative price is always recomputed
// server-side in lib/orderService.js#resolveSmsOrder before the
// wallet is debited, so this page can never under/over-charge by
// showing a stale number.
// =====================================================================

let session = null;
let smsPlan = null;

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

    if (profile) {
        $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;
    }

    try {
        const { data, error } = await client
            .from('sms_plans')
            .select('*')
            .eq('status', 'active')
            .maybeSingle();
        if (error) throw error;
        smsPlan = data;

        if (smsPlan && smsPlan.sender_id) {
            $('#sender-input').placeholder = `Default: ${smsPlan.sender_id}`;
        }
        if (!smsPlan) {
            $('#send-btn').textContent = 'SMS sending is not available right now';
        }
    } catch (err) {
        console.error(err);
    }

    $('#recipients-input').addEventListener('input', updateEstimate);
    $('#message-input').addEventListener('input', updateEstimate);
    updateEstimate();
}

// ===============================
// LIVE ESTIMATE
// ===============================

function parseRecipientCount() {
    const raw = $('#recipients-input').value;
    return raw.split(',').map(r => r.trim()).filter(Boolean).length;
}

function updateEstimate() {
    const message = $('#message-input').value;
    const recipientCount = parseRecipientCount();
    const segments = message.length === 0 ? 0 : Math.ceil(message.length / 160);
    const units = segments * recipientCount;

    $('#recipient-count').textContent = `${recipientCount} recipient(s)`;
    $('#char-count').textContent = `${message.length} / 1000`;
    $('#segment-count').textContent = `${segments} segment(s)`;

    const costBox = $('#cost-box');
    const btn = $('#send-btn');

    if (smsPlan && units > 0) {
        const pricePerUnit = Number(smsPlan.price_per_unit || 0);
        const estimatedCost = Math.round(units * pricePerUnit * 100) / 100;
        $('#cost-units').textContent = units;
        $('#cost-amount').textContent = `₦${money(estimatedCost)}`;
        costBox.style.display = 'block';
    } else {
        costBox.style.display = 'none';
    }

    if (!smsPlan) {
        btn.disabled = true;
        return;
    }

    if (recipientCount > 0 && message.trim().length > 0) {
        btn.disabled = false;
        btn.textContent = 'Send SMS';
    } else {
        btn.disabled = true;
        btn.textContent = 'Enter recipients and a message';
    }
}

// ===============================
// SEND
// ===============================

$('#send-btn').addEventListener('click', async () => {
    const recipients = $('#recipients-input').value.split(',').map(r => r.trim()).filter(Boolean);
    const message = $('#message-input').value.trim();
    const senderId = $('#sender-input').value.trim() || undefined;

    if (recipients.length === 0) {
        toast('Enter at least one recipient', 'err');
        return;
    }
    if (!message) {
        toast('Enter a message', 'err');
        return;
    }

    const pin = await hdhRequestPin();
    if (!pin) return;

    const btn = $('#send-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
        const res = await fetch('/api/place-order', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
                type: 'sms',
                recipients,
                message,
                senderId,
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
            throw new Error((body.error && body.error.message) || `Send failed (HTTP ${res.status})`);
        }

        const isPending = body.data && body.data.status === 'pending';

        showResultModal({
            ok: !isPending,
            title: isPending ? 'SMS submitted' : 'SMS sent',
            message: isPending
                ? 'Your message is being processed and will be delivered shortly.'
                : `Message sent to ${recipients.length} recipient(s).`
        });

        $('#recipients-input').value = '';
        $('#message-input').value = '';

        const { data: profile } = await client
            .from('users')
            .select('wallet_balance')
            .eq('id', session.user.id)
            .maybeSingle();
        if (profile) $('#wallet-balance').textContent = `₦${money(profile.wallet_balance)}`;

    } catch (err) {
        console.error(err);
        showResultModal({ ok: false, title: 'Send failed', message: err.message });
    } finally {
        updateEstimate();
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
