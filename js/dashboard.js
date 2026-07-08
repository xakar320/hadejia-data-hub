// ===============================
// Hadejia Data Hub Dashboard
// dashboard.js
// ===============================

const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

let currentUser = null;
let currentUserData = null;
let currentBalance = 0;

// ===============================
// CHECK LOGIN
// ===============================

async function checkUser() {

    const {
        data: { session }
    } = await client.auth.getSession();

    if (!session) {
        window.location.href = "index.html";
        return;
    }

    currentUser = session.user;

    await loadUserProfile();

    await loadTransactions();

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

        currentBalance = Number(data.balance || 0);

        document.getElementById("userName").textContent =
            data.full_name ||
            data.account_name ||
            "User";

        document.getElementById("userEmail").textContent =
            data.email ||
            currentUser.email;

        document.getElementById("userPhone").textContent =
            data.phone ||
            "No Phone Number";

        document.getElementById("walletBalance").textContent =
            "₦" + currentBalance.toLocaleString();

        if (data.is_admin === true) {

            document
                .getElementById("adminBtn")
                .style.display = "inline-block";

        }

    }

    catch (err) {

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

            const date =
                new Date(tx.created_at)
                .toLocaleString();

            const color =
                tx.status === "Success"
                ? "#16a34a"
                : "#dc2626";

            list.innerHTML += `

            <div class="transactionItem">

                <div class="txLeft">

                    <h4>${tx.type}</h4>

                    <p>${tx.details || ""}</p>

                    <small>${date}</small>

                </div>

                <div class="txRight">

                    <span
                    style="
                    color:${color};
                    font-weight:bold;">

                    ${amount}

                    </span>

                    <br>

                    <small>

                    ${tx.status}

                    </small>

                </div>

            </div>

            `;

        });

    }

    catch (err) {

        console.error(err);

        document.getElementById("transactionList")
        .innerHTML = `

        <div class="empty">

        Failed To Load Transactions

        </div>

        `;

    }

}

// ===============================
// REFRESH BALANCE
// ===============================

async function refreshBalance() {

    const { data } = await client

        .from("users")

        .select("balance")

        .eq("id", currentUser.id)

        .single();

    if (data) {

        currentBalance =
            Number(data.balance);

        document.getElementById("walletBalance")
        .textContent =
        "₦" +
        currentBalance.toLocaleString();

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
// AUTO START
// ===============================

window.addEventListener("load", async () => {

    await checkUser();

});
