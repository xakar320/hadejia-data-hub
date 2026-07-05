
// ==========================
// LOGIN
// ==========================
const loginForm = document.getElementById("loginForm");

if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const email = document.getElementById("email").value;
        const password = document.getElementById("password").value;
        const message = document.getElementById("message");

        const { data, error } = await client.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            message.style.color = "red";
            message.innerText = error.message;
            return;
        }

        message.style.color = "green";
        message.innerText = "Login successful...";

        setTimeout(() => {
            window.location.href = "dashboard.html";
        }, 1000);
    });
}


// ==========================
// REGISTER (WITH PIN)
// ==========================
const registerForm = document.getElementById("registerForm");

if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const fullName = document.getElementById("fullName").value;
        const email = document.getElementById("email").value;
        const phone = document.getElementById("phone").value;
        const pin = document.getElementById("pin").value;
        const password = document.getElementById("password").value;
        const message = document.getElementById("message");

        // 🔐 PIN VALIDATION
        if (pin.length !== 4 || isNaN(pin)) {
            message.style.color = "red";
            message.innerText = "PIN must be 4 digits only";
            return;
        }

        // 1. CREATE AUTH USER
        const { data, error } = await client.auth.signUp({
            email,
            password
        });

        if (error) {
            message.style.color = "red";
            message.innerText = error.message;
            return;
        }

        const user = data.user;

        // 2. SAVE USER TO DATABASE
        const { error: dbError } = await client
            .from("users")
            .insert([
                {
                    id: user.id,
                    full_name: fullName,
                    email: email,
                    phone: phone,
                    balance: 0,
                    is_admin: false,
                    transaction_pin: pin
                }
            ]);

        if (dbError) {
            message.style.color = "red";
            message.innerText = dbError.message;
            return;
        }

        message.style.color = "green";
        message.innerText = "Account created successfully";

        setTimeout(() => {
            window.location.href = "index.html";
        }, 1500);
    });
}
