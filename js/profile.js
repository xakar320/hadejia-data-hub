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
        .select('full_name, email, phone, referral_code, pin_hash')
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
