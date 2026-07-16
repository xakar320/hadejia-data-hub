// ========================================
// auth.js
// Part 1A
// Supabase Setup + Register
// ========================================

// Make sure js/supabase.js is loaded first
// It must contain:
// const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =============================
// REGISTER
// =============================

async function registerUser() {

    const name = document.getElementById("name").value.trim();

    const phone = document.getElementById("phone").value.trim();

    const email = document.getElementById("email").value.trim();

    const password = document.getElementById("password").value;

    const pin = document.getElementById("pin").value;

    if (
        !name ||
        !phone ||
        !email ||
        !password ||
        !pin
    ) {

        alert("Please fill all fields.");

        return;

    }

    if (pin.length !== 4) {

        alert("PIN must be exactly 4 digits.");

        return;

    }

    try {

        // Create Auth User
        const { data, error } =
        await client.auth.signUp({

            email: email,

            password: password

        });

        if (error) throw error;

        const user = data.user;

        if (!user) {

            alert("Registration failed.");

            return;

        }

        // Save profile into users table
        const { error: insertError } =
        await client
        .from("users")
        .insert([{

            id: user.id,

            name: name,

            phone: phone,

            email: email,

            balance: 0,

            pin: pin,

            is_admin: false,

            created_at:
            new Date().toISOString()

        }]);

        if (insertError)
            throw insertError;

        alert("Registration Successful!");

        location.href = "index.html";

    }

    catch (err) {

        console.error(err);

        alert(err.message);

    }

            }

// =====================================
// FORGOT PASSWORD
// =====================================

async function forgotPassword() {

    const email = prompt("Enter your registered email");

    if (!email) return;

    try {

        const { error } =
        await client.auth.resetPasswordForEmail(email, {

            redirectTo:
            window.location.origin +
            "/change-password.html"

        });

        if (error) throw error;

        alert(
            "Password reset link has been sent to your email."
        );

    }

    catch (err) {

        console.error(err);

        alert(err.message);

    }

}

// =====================================
// CHECK SESSION
// =====================================

async function checkSession() {

    try {

        const {
            data: { session }
        } = await client.auth.getSession();

        if (!session) {

            location.href = "index.html";

            return;

        }

        return session.user;

    }

    catch (err) {

        console.error(err);

        location.href = "index.html";

    }

}

// =====================================
// LOGOUT
// =====================================

async function logout() {

    const yes =
    confirm("Are you sure you want to logout?");

    if (!yes) return;

    try {

        await client.auth.signOut();

        alert("Logout Successful");

        location.href = "index.html";

    }

    catch (err) {

        console.error(err);

        alert("Logout Failed");

    }

}
