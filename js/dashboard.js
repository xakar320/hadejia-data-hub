// =====================================
// Hadejia Data Hub
// dashboard.js
// =====================================

// Global Variables
let currentUser = null;
let currentUserData = null;

// ===============================
// CHECK LOGIN
// ===============================

async function checkUser() {

    try {

        const {
            data: { session }
        } = await client.auth.getSession();

        if (!session) {
            location.href = "index.html";
            return;
        }

        currentUser = session.user;

        await loadUserProfile();

    } catch (err) {

        console.error(err);
        alert("Failed to verify login.");

    }

}

// ===============================
// LOAD USER PROFILE
// ===============================

async function loadUserProfile() {

    try {

        const { data, error } = await client
            .from("users")
            .select("*")
            .eq("id", currentUser.id)
            .single();

        if (error) throw error;

        currentUserData = data;

        // USER NAME
        document.getElementById("userName").textContent =
            data.name || "User";

        // EMAIL
        document.getElementById("userEmail").textContent =
            data.email || "";

        // PHONE
        document.getElementById("userPhone").textContent =
            data.phone || "";

        // BALANCE
        document.getElementById("walletBalance").textContent =
            "₦" + Number(data.balance || 0).toLocaleString();

        // ADMIN BUTTON
        if (data.is_admin === true) {

            document.getElementById("adminBtn").style.display =
                "inline-block";

        }

        // Load Transactions
        await loadTransactions();

    } catch (err) {

        console.error(err);
        alert("Unable to load profile.");

    }

}

// ===============================
// LOAD TRANSACTIONS
// ===============================

async function loadTransactions() {

    try {

        const { data, error } = await client
            .from("transactions")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("created_at", {
                ascending: false
            })
            .limit(20);

        if (error) throw error;

        const list =
            document.getElementById("transactionList");

        if (!list) return;

        list.innerHTML = "";

        if (!data || data.length === 0) {

            list.innerHTML = `
                <div class="empty">
                    No Transactions Yet
                </div>
            `;

            return;

        }

        data.forEach(tx => {

            const amount =
                "₦" +
                Number(tx.amount || 0)
                .toLocaleString();

            const color =
                tx.status === "Success"
                ? "green"
                : "red";

            list.innerHTML += `

            <div class="transactionItem">

                <div>

                    <h4>${tx.type}</h4>

                    <small>

                    ${tx.details || ""}

                    </small>

                </div>

                <div
                style="text-align:right;">

                    <strong
                    style="color:${color};">

                    ${amount}

                    </strong>

                    <br>

                    <small>

                    ${tx.status}

                    </small>

                </div>

            </div>

            `;

        });

    } catch (err) {

        console.log(err);

    }

}

// ===============================
// LOGOUT
// ===============================

async function logout() {

    await client.auth.signOut();

    location.href = "index.html";

}

// ===============================
// START
// ===============================

window.addEventListener("load", () => {

    checkUser();

});

// =============================
// LOGIN
// =============================

async function loginUser() {

    const email =
        document.getElementById("email").value.trim();

    const password =
        document.getElementById("password").value;

    if (!email || !password) {

        alert("Please enter your email and password.");

        return;

    }

    try {

        const { data, error } =
        await client.auth.signInWithPassword({

            email: email,

            password: password

        });

        if (error) throw error;

        // Check user session
        const user = data.user;

        if (!user) {

            alert("Login failed.");

            return;

        }

        // Check if profile exists
        const {
            data: profile,
            error: profileError
        } = await client
        .from("users")
        .select("*")
        .eq("id", user.id)
        .single();

        if (profileError) {

            alert("User profile not found.");

            return;

        }

        // Go to Dashboard
        window.location.href = "dashboard.html";

    } catch (err) {

        console.error(err);

        alert(err.message);

    }

}
