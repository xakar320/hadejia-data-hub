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
        // maybeSingle() instead of single(): single() throws an error
        // if the profile row isn't found yet (e.g. right after signup,
        // or if this account's role/status hasn't been finalized) —
        // maybeSingle() returns null instead, which we can handle with
        // a clear message rather than a generic failure.
        const { data, error } = await client
            .from("users")
            .select("*")
            .eq("id", currentUser.id)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            alert("No profile found for this account. Contact support.");
            return;
        }

        currentUserData = data;

        // NAME — column is full_name, not name
        document.getElementById("userName").textContent =
            data.full_name || "User";

        // EMAIL
        document.getElementById("userEmail").textContent =
            data.email || "";

        // PHONE
        document.getElementById("userPhone").textContent =
            data.phone || "";

        // BALANCE — column is wallet_balance, not balance
        document.getElementById("walletBalance").textContent =
            "₦" + Number(data.wallet_balance || 0).toLocaleString();

        // ADMIN BUTTON — role is 'user' | 'admin' | 'superadmin', not a boolean is_admin
        if (data.role === "admin" || data.role === "superadmin") {
            const adminBtn = document.getElementById("adminBtn");
            if (adminBtn) adminBtn.style.display = "inline-block";
        }

        await loadTransactions();

    } catch (err) {
        console.error(err);
        alert("Unable to load profile.");
    }
}

// ===============================
// LOAD RECENT TRANSACTIONS
// ===============================

async function loadTransactions() {
    try {
        const { data, error } = await client
            .from("transactions")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("created_at", { ascending: false })
            .limit(10);

        if (error) throw error;

        const list = document.getElementById("transactionList");
        if (!list) return;

        list.innerHTML = "";

        if (!data || data.length === 0) {
            list.innerHTML = `
                <div class="empty">
                    No transactions found.
                </div>
            `;
            return;
        }

        data.forEach(tx => {
            const amount = "₦" + Number(tx.amount || 0).toLocaleString();
            const date = new Date(tx.created_at).toLocaleString();

            // status is lowercase: pending | processing | success | failed | reversed
            const statusColors = {
                success: "#16a34a",
                pending: "#c08a34",
                processing: "#c08a34",
                failed: "#dc2626",
                reversed: "#dc2626"
            };
            const statusColor = statusColors[tx.status] || "#4A564E";

            // No free-text "details" column in this schema — build a
            // readable line from type/network/recipient instead.
            const detailsLine = [tx.network, tx.recipient]
                .filter(Boolean)
                .join(" · ");

            list.innerHTML += `
            <div class="transactionItem">
                <div class="txLeft">
                    <h4>${tx.type}</h4>
                    <p>${detailsLine}</p>
                    <small>${date}</small>
                </div>
                <div class="txRight">
                    <strong style="color:${statusColor}">
                        ${amount}
                    </strong>
                    <br>
                    <small>${tx.status}</small>
                </div>
            </div>
            `;
        });

    } catch (err) {
        console.error(err);
        const list = document.getElementById("transactionList");
        if (list) {
            list.innerHTML = `
                <div class="empty">
                    Failed to load transactions.
                </div>
            `;
        }
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
