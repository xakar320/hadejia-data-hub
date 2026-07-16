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
