// =====================================
// Hadejia Data Hub
// auth.js
// Part 1
// =====================================

// ===============================
// REGISTER USER
// ===============================

async function registerUser() {

    const name =
        document.getElementById("name").value.trim();

    const phone =
        document.getElementById("phone").value.trim();

    const email =
        document.getElementById("email").value.trim();

    const password =
        document.getElementById("password").value;

    const pin =
        document.getElementById("pin").value;

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

    if (!/^[0-9]{4}$/.test(pin)) {

        alert("PIN must be exactly 4 digits.");

        return;

    }

    try {

        // Create Auth User
        const {
            data,
            error
        } = await client.auth.signUp({

            email: email,

            password: password

        });

        if (error) throw error;

        // Save Profile
        const {
            error: insertError
        } = await client

        .from("users")

        .insert([{

            id: data.user.id,

            name: name,

            phone: phone,

            email: email,

            pin: pin,

            balance: 0,

            is_admin: false

        }]);

        if (insertError)
            throw insertError;

        alert("Account Created Successfully");

        location.href = "index.html";

    }

    catch (err) {

        console.error(err);

        alert(err.message);

    }

}

// ===============================
// LOGIN USER
// ===============================

async function loginUser() {

    const email =
        document.getElementById("email").value.trim();

    const password =
        document.getElementById("password").value;

    if (!email || !password) {

        alert("Please enter email and password.");

        return;

    }

    try {

        const {
            data,
            error
        } = await client.auth.signInWithPassword({

            email: email,

            password: password

        });

        if (error)
            throw error;

        if (!data.user) {

            alert("Login Failed");

            return;

        }

        location.href = "dashboard.html";

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
            window.location.origin + "/index.html"

        });

        if (error) throw error;

        alert("Password reset link has been sent to your email.");

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

        return session;

    }

    catch (err) {

        console.error(err);

        return null;

    }

}

// =====================================
// REQUIRE LOGIN
// Use this on protected pages
// =====================================

async function requireLogin() {

    const session = await checkSession();

    if (!session) {

        location.href = "index.html";

        return;

    }

}

// =====================================
// LOGOUT
// =====================================

async function logout() {

    try {

        await client.auth.signOut();

        location.href = "index.html";

    }

    catch (err) {

        console.error(err);

        alert("Logout Failed");

    }

}

// =====================================
// AUTO CHECK
// =====================================

window.addEventListener("load", async () => {

    const page =
        window.location.pathname
        .split("/")
        .pop();

    // Login/Register pages don't require login
    if (
        page === "index.html" ||
        page === "register.html" ||
        page === ""
    ) {
        return;
    }

    await requireLogin();

});
