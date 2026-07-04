
// ==========================
// LOGIN FUNCTION
// ==========================
const loginForm = document.getElementById("loginForm");

if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const email = document.getElementById("email").value;
        const password = document.getElementById("password").value;
        const message = document.getElementById("message");

        try {
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
            message.innerText = "Login successful... redirecting";

            setTimeout(() => {
                window.location.href = "dashboard.html";
            }, 1000);

        } catch (err) {
            message.style.color = "red";
            message.innerText = "Login failed";
        }
    });
}


// ==========================
// REGISTER FUNCTION
// ==========================
const registerForm = document.getElementById("registerForm");

if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        const fullName = document.getElementById("fullName").value;
        const email = document.getElementById("email").value;
        const phone = document.getElementById("phone").value;
        const password = document.getElementById("password").value;
        const message = document.getElementById("message");

        try {
            // 1. Create auth user
            const { data, error } = await client.auth.signUp({
                email,
                password
            });

            if (error) {
                message.style.color = "red";
                message.innerText = error.message;
                return;
            }

            // 2. Save user in database
            const user = data.user;

            const { error: dbError } = await client
                .from("users")
                .insert([
                    {
                        id: user.id,
                        full_name: fullName,
                        email: email,
                        phone: phone,
                        balance: 0,
                        is_admin: false
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

        } catch (err) {
            message.style.color = "red";
            message.innerText = "Registration failed";
        }
    });
}
