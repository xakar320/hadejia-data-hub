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
// IF ALREADY LOGGED IN, SKIP LOGIN
// ===============================

window.addEventListener('load', async () => {
    const { data: { session } } = await client.auth.getSession();
    if (session) {
        window.location.href = 'dashboard.html';
    }
});
