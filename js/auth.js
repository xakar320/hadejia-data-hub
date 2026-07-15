// =====================================
// Hadejia Data Hub
// auth.js
// =====================================

// ===============================
// REGISTER
// ===============================

const registerForm = document.getElementById("registerForm");

if (registerForm) {

    registerForm.addEventListener("submit", async (e) => {

        e.preventDefault();

        const fullName =
            document.getElementById("fullName").value.trim();

        const email =
            document.getElementById("registerEmail").value.trim();

        const phone =
            document.getElementById("phone").value.trim();

        const password =
            document.getElementById("registerPassword").value;

        const confirmPassword =
            document.getElementById("confirmPassword").value;

        const pin =
            document.getElementById("transactionPin").value;

        if (password !== confirmPassword) {
            alert("Passwords do not match");
            return;
        }

        if (!/^[0-9]{4}$/.test(pin)) {
            alert("PIN must be exactly 4 digits");
            return;
        }

        const btn = document.getElementById("registerBtn");
        btn.disabled = true;
        btn.textContent = "Creating Account...";

        try {

            // Create Auth User
            const { data, error } =
                await client.auth.signUp({

                    email,
                    password

                });

            if (error) throw error;

            // Save User Profile
            const { error: profileError } =
                await client
                .from("users")
                .insert([{

                    id: data.user.id,

                    full_name: fullName,

                    email: email,

                    phone: phone,

                    transaction_pin: pin,

                    balance: 0,

                    is_admin: false

                }]);

            if (profileError) throw profileError;

            alert("Account created successfully.");

            location.href = "index.html";

        }

        catch (err) {

            console.error(err);

            alert(err.message);

        }

        btn.disabled = false;
        btn.textContent = "Create Account";

    });

}

// ===============================
// LOGIN
// ===============================

const loginForm = document.getElementById("loginForm");

if (loginForm) {

    loginForm.addEventListener("submit", async (e) => {

        e.preventDefault();

        const email =
            document.getElementById("loginEmail").value.trim();

        const password =
            document.getElementById("loginPassword").value;

        const btn =
            document.getElementById("loginBtn");

        btn.disabled = true;
        btn.textContent = "Logging In...";

        try {

            const { error } =
                await client.auth.signInWithPassword({

                    email,
                    password

                });

            if (error) throw error;

            location.href = "dashboard.html";

        }

        catch (err) {

            console.error(err);

            alert(err.message);

        }

        btn.disabled = false;
        btn.textContent = "Login";

    });

        }
