// =====================================================================
// js/profile.js — Profile page logic
// Relies on the global `client` from js/supabase.js. Reads/writes the
// user's own row directly via Supabase — RLS (users_update_own_or_admin)
// allows a user to update their own full_name/phone/pin_hash, and the
// prevent_privilege_escalation trigger blocks role/wallet_balance/status
// changes on the same self-edit, so no custom backend endpoint is
// needed for this page.
//
// The PIN is never sent or stored in plain text: it's hashed with
// SHA-256 in the browser (Web Crypto API) before being written to
// users.pin_hash.
// =====================================================================

let session = null;
let currentProfile = null;

function $(sel) { return document.querySelector(sel); }

function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'ok' ? 'ok' : 'err'}`;
    t.textContent = msg;
    $('#toast-wrap').appendChild(t);
    setTimeout(() => t.remove(), 4200);
}

async function sha256Hex(text) {
    const enc = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
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
    await loadProfile();

    document.getElementById('profile-form').addEventListener('submit', saveProfile);
    document.getElementById('pin-form').addEventListener('submit', savePin);
}

async function loadProfile() {
    const { data, error } = await client
        .from('users')
        .select('full_name, email, phone, referral_code, pin_hash, is_reseller')
        .eq('id', session.user.id)
        .maybeSingle();

    if (error) {
        toast('Failed to load profile: ' + error.message, 'err');
        return;
    }

    if (!data) {
        toast('No profile found for this account.', 'err');
        return;
    }

    currentProfile = data;

    const name = data.full_name || 'User';
    $('#display-name').textContent = name;
    $('#display-email').textContent = data.email;
    $('#avatar-initial').textContent = name.trim().charAt(0).toUpperCase() || 'U';
    $('#referral-code').textContent = data.referral_code || '—';

    $('#full-name-input').value = data.full_name || '';
    $('#phone-input').value = data.phone || '';
    $('#email-display').value = data.email || '';

    // Only ask for the current PIN if one is already set.
    if (data.pin_hash) {
        $('#current-pin-field').style.display = 'block';
    }

    await loadResellerStatus(data.is_reseller);
}

// ===============================
// RESELLER PROGRAM
// ===============================

async function loadResellerStatus(isReseller) {
    const view = $('#reseller-status-view');

    if (isReseller) {
        view.innerHTML = `
            <p style="font-size:14px;color:var(--teal);font-weight:600;">✅ You're an approved Reseller</p>
            <p style="font-size:13px;color:var(--ink-soft);">Reseller pricing is applied automatically at checkout on eligible plans.</p>
        `;
        return;
    }

    const { data: apps } = await client
        .from('reseller_applications')
        .select('status, admin_note, created_at')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(1);

    const latest = apps && apps[0];

    if (latest && latest.status === 'pending') {
        view.innerHTML = `
            <p style="font-size:13px;color:var(--ink-soft);">
                ⏳ Your reseller application is under review. We'll let you know once it's decided.
            </p>
        `;
        return;
    }

    if (latest && latest.status === 'rejected') {
        view.innerHTML = `
            <p style="font-size:13px;color:var(--ink-soft);">
                Your previous application wasn't approved${latest.admin_note ? `: "${latest.admin_note}"` : '.'}
                You're welcome to apply again.
            </p>
            <textarea id="reseller-reason" rows="2" placeholder="Why would you like to become a reseller? (optional)" style="width:100%;margin:8px 0;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:13px;"></textarea>
            <button class="btn btn-primary" id="apply-reseller-btn" type="button">Apply Again</button>
        `;
    } else {
        view.innerHTML = `
            <p style="font-size:13px;color:var(--ink-soft);">
                Sell data, airtime and more to your own customers at special reseller pricing.
            </p>
            <textarea id="reseller-reason" rows="2" placeholder="Why would you like to become a reseller? (optional)" style="width:100%;margin:8px 0;padding:8px;border:1px solid var(--line);border-radius:8px;font-size:13px;"></textarea>
            <button class="btn btn-primary" id="apply-reseller-btn" type="button">Apply to Become a Reseller</button>
        `;
    }

    $('#apply-reseller-btn').addEventListener('click', applyForReseller);
}

async function applyForReseller() {
    const btn = $('#apply-reseller-btn');
    const reason = ($('#reseller-reason') && $('#reseller-reason').value.trim()) || null;

    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
        const { error } = await client.from('reseller_applications').insert({
            user_id: session.user.id,
            reason
        });

        if (error) throw error;

        toast('Application submitted!');
        await loadResellerStatus(false);
    } catch (err) {
        toast('Failed to submit application: ' + err.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Apply to Become a Reseller';
    }
}

// ===============================
// SAVE PROFILE (name/phone)
// ===============================

async function saveProfile(e) {
    e.preventDefault();

    const fullName = $('#full-name-input').value.trim();
    const phone = $('#phone-input').value.trim();

    if (!fullName) {
        toast('Full name cannot be empty', 'err');
        return;
    }

    if (phone && !/^0[7-9][01]\d{8}$/.test(phone)) {
        toast('Enter a valid Nigerian phone number', 'err');
        return;
    }

    const btn = $('#save-profile-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        const { error } = await client
            .from('users')
            .update({ full_name: fullName, phone: phone || null })
            .eq('id', session.user.id);

        if (error) throw error;

        toast('Profile updated');
        await loadProfile();

    } catch (err) {
        console.error(err);
        // Postgres unique-constraint violation on phone comes through
        // as a specific error code — surface a clearer message for it.
        if (err.code === '23505') {
            toast('That phone number is already in use by another account', 'err');
        } else {
            toast(err.message, 'err');
        }
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
    }
}

// ===============================
// SAVE PIN
// ===============================

async function savePin(e) {
    e.preventDefault();

    const currentPin = $('#current-pin-input').value.trim();
    const newPin = $('#new-pin-input').value.trim();
    const confirmPin = $('#confirm-pin-input').value.trim();

    if (!/^\d{4,6}$/.test(newPin)) {
        toast('New PIN must be 4-6 digits', 'err');
        return;
    }

    if (newPin !== confirmPin) {
        toast('New PIN and confirmation do not match', 'err');
        return;
    }

    const btn = $('#save-pin-btn');
    btn.disabled = true;
    btn.textContent = 'Updating…';

    try {
        // If a PIN is already set, verify the current one matches
        // before allowing a change.
        if (currentProfile && currentProfile.pin_hash) {
            if (!currentPin) {
                toast('Enter your current PIN', 'err');
                return;
            }
            const currentHash = await sha256Hex(currentPin);
            if (currentHash !== currentProfile.pin_hash) {
                toast('Current PIN is incorrect', 'err');
                return;
            }
        }

        const newHash = await sha256Hex(newPin);

        const { error } = await client
            .from('users')
            .update({ pin_hash: newHash })
            .eq('id', session.user.id);

        if (error) throw error;

        toast('PIN updated successfully');
        $('#pin-form').reset();
        await loadProfile();

    } catch (err) {
        console.error(err);
        toast(err.message, 'err');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Update PIN';
    }
}

// ===============================
// COPY REFERRAL CODE
// ===============================

document.getElementById('copy-referral-btn')?.addEventListener('click', () => {
    const code = $('#referral-code').textContent;
    if (!code || code === '—') return;
    navigator.clipboard.writeText(code).then(() => {
        toast('Referral code copied');
    }).catch(() => {});
});

// ===============================
// START
// ===============================

window.addEventListener('load', init);
