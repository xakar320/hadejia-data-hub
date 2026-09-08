// =====================================================================
// Hadejia Data Hub
// js/reset-password.js — reset-password page logic
// Requires the global `client` created in js/supabase.js (loaded
// before this file in reset-password.html).
//
// Flow: forgotPassword() in js/auth.js calls
// client.auth.resetPasswordForEmail(email, { redirectTo: '.../reset-password.html' }).
// Supabase emails the user a link back to this page containing a
// recovery token in the URL. supabase-js automatically detects that
// token and fires a PASSWORD_RECOVERY auth event with a temporary
// session attached, which is what lets updatePassword() below call
// client.auth.updateUser() without asking the user to log in again.
// =====================================================================

const form = document.getElementById('reset-form');
const messageBox = document.getElementById('reset-message');
const subtitle = document.getElementById('reset-subtitle');

let recoverySessionReady = false;

function showMessage(text, type) {
    messageBox.textContent = text;
    messageBox.className = type; // 'success' or 'error'
}

// ===============================
// WAIT FOR RECOVERY SESSION
// ===============================

client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
        recoverySessionReady = true;
    }
});

window.addEventListener('load', async () => {
    // Give supabase-js a moment to parse the recovery token from the
    // URL hash and establish the temporary session.
    const { data: { session } } = await client.auth.getSession();

    if (session) {
        recoverySessionReady = true;
    } else {
        // No recovery token found — this page wasn't opened from a
        // valid reset-password email link.
        form.style.display = 'none';
        subtitle.textContent = 'This link is invalid or has expired.';
        showMessage('Please request a new password reset link from the login page.', 'error');
    }
});

// ===============================
// UPDATE PASSWORD
// ===============================

async function updatePassword() {
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const btn = document.getElementById('reset-btn');

    if (!recoverySessionReady) {
        showMessage('This link is invalid or has expired. Please request a new one.', 'error');
        return;
    }

    if (!newPassword || !confirmPassword) {
        showMessage('Please fill in both password fields.', 'error');
        return;
    }

    if (newPassword.length < 6) {
        showMessage('Password must be at least 6 characters.', 'error');
        return;
    }

    if (newPassword !== confirmPassword) {
        showMessage('Passwords do not match.', 'error');
        return;
    }

    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
        const { error } = await client.auth.updateUser({ password: newPassword });

        if (error) throw error;

        form.style.display = 'none';
        subtitle.textContent = 'Password updated successfully!';
        showMessage('You can now log in with your new password.', 'success');

        setTimeout(() => {
            window.location.href = 'index.html';
        }, 2500);

    } catch (err) {
        console.error(err);
        showMessage(err.message || 'Could not update password. Please try again.', 'error');
        btn.disabled = false;
        btn.textContent = 'Update Password';
    }
}
