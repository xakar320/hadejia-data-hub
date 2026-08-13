// =====================================================================
// Hadejia Data Hub
// js/auth.js — login page logic
// Requires the global `client` created in js/supabase.js (loaded
// before this file in index.html).
// =====================================================================

// ===============================
// LOGIN
// ===============================

async function loginUser() {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
        alert('Please enter your email and password.');
        return;
    }

    try {
        const { data, error } = await client.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) throw error;

        const user = data.user;

        if (!user) {
            alert('Login failed.');
            return;
        }

        // Check the profile exists and the account isn't suspended/banned.
        const { data: profile, error: profileError } = await client
            .from('users')
            .select('status')
            .eq('id', user.id)
            .maybeSingle();

        if (profileError) {
            alert('Unable to verify account: ' + profileError.message);
            return;
        }

        if (!profile) {
            alert('No profile found for this account. Contact support.');
            return;
        }

        if (profile.status === 'suspended') {
            alert('Your account has been suspended. Contact support.');
            await client.auth.signOut();
            return;
        }

        if (profile.status === 'banned') {
            alert('Your account has been banned.');
            await client.auth.signOut();
            return;
        }

        // Go to Dashboard
        window.location.href = 'dashboard.html';

    } catch (err) {
        console.error(err);
        alert(err.message);
    }
}

// ===============================
// FORGOT PASSWORD
// ===============================

async function forgotPassword() {
    const email = document.getElementById('email').value.trim();

    if (!email) {
        alert('Enter your email address above first, then tap "Forgot Password?" again.');
        return;
    }

    try {
        const { error } = await client.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + '/reset-password.html'
        });

        if (error) throw error;

        alert('Password reset link sent to ' + email + '. Please check your inbox.');

    } catch (err) {
        console.error(err);
        alert(err.message);
    }
}

// ===============================
// REGISTER
// ===============================
//
// Root cause of the dead "Create Account" button: register.html has
// always called registerUser(), but this file never defined it (only
// loginUser/forgotPassword existed). js/auth2.js does define a
// registerUser(), but it's not loaded by register.html, writes to a
// different/incompatible set of columns (name, pin in plaintext,
// balance), and is not part of the current architecture — so it was
// intentionally left alone rather than wired in.
//
// This implementation creates the account via a new server-side
// endpoint (api/register.js), which uses the existing Supabase Auth +
// public.users architecture (the same schema/hashing approach as the
// WhatsApp registration flow and js/profile.js's PIN update). A
// server-side endpoint is required here — rather than calling
// client.auth.signUp() directly from the browser — because RLS only
// confirms an authenticated user can UPDATE their own existing
// public.users row (see js/profile.js's header comment); there's no
// confirmed INSERT policy, and pre-signup email/phone uniqueness
// checks aren't reliable under RLS for an unauthenticated caller.
// The server endpoint uses the service-role Supabase client
// (lib/supabaseAdmin.js) for exactly those two things, and nothing
// else ever touches the service-role key from the browser.

async function registerUser() {
    const nameInput = document.getElementById('name');
    const phoneInput = document.getElementById('phone');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const pinInput = document.getElementById('pin');
    const btn = document.getElementById('create-account-btn');

    const full_name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const pin = pinInput.value.trim();

    if (!full_name || !phone || !email || !password || !pin) {
        alert('Please fill in all fields.');
        return;
    }

    if (!/^\d{4}$/.test(pin)) {
        alert('PIN must be exactly 4 digits.');
        return;
    }

    if (password.length < 6) {
        alert('Password must be at least 6 characters.');
        return;
    }

    // Prevent double-click / duplicate submissions while the request
    // is in flight.
    if (btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Creating Account...';
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full_name, phone, email, password, pin })
        });

        let body;
        try {
            body = await res.json();
        } catch (e) {
            throw new Error(`Server error (HTTP ${res.status}). Please try again shortly.`);
        }

        if (!res.ok || body.success === false) {
            throw new Error((body.error && body.error.message) || 'Could not create your account. Please try again.');
        }

        // The account was created server-side via the Supabase Auth
        // admin API, so the browser doesn't have a session yet. Sign
        // in now so the rest of the app (dashboard.html etc.) sees a
        // normal logged-in session, exactly as if the customer had
        // just logged in through index.html.
        const { error: signInError } = await client.auth.signInWithPassword({ email, password });

        if (signInError) {
            console.error(signInError);
            alert('Account created successfully! 🎉 Please log in to continue.');
            window.location.href = 'index.html';
            return;
        }

        alert('Account created successfully! 🎉');
        window.location.href = 'dashboard.html';

    } catch (err) {
        console.error(err);
        alert(err.message || 'Could not create your account. Please try again.');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Create Account';
        }
    }
}

// ===============================
// IF ALREADY LOGGED IN, SKIP LOGIN
// ===============================

window.addEventListener('load', async () => {
    const { data: { session } } = await client.auth.getSession();
    if (session) {
        window.location.href = 'dashboard.html';
    }
});
