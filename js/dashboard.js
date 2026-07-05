// ==========================
// CHECK USER SESSION
// ==========================
let currentUser = null;

window.addEventListener("load", async () => {
    const { data: { session } } = await client.auth.getSession();

    if (!session) {
        window.location.href = "index.html";
        return;
    }

    currentUser = session.user;

    await loadProfile();
    await loadTransactions();
});

// ==========================
// LOAD PROFILE
// ==========================
async function loadProfile() {

    const { data, error } = await client
        .from("users")
        .select("*")
        .eq("id", currentUser.id)
        .single();

    if (error) {
        console.log(error);
        return;
    }

    document.getElementById("welcomeName").innerText =
        data.full_name || "User";

    document.getElementById("welcomeEmail").innerText =
        data.email;

    document.getElementById("walletBalance").innerText =
        "₦" + Number(data.balance || 0).toLocaleString();

    // Show Admin Button
    if (data.is_admin === true) {
        document.getElementById("adminBtn").style.display = "inline-block";
    }
}

// ==========================
// LOAD TRANSACTIONS
// ==========================
async function loadTransactions() {

    const box = document.getElementById("transactionList");

    const { data, error } = await client
        .from("transactions")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(10);

    if (error) {
        box.innerHTML = "Failed to load transactions";
        return;
    }

    if (!data.length) {
        box.innerHTML = "<p>No transaction yet.</p>";
        return;
    }

    box.innerHTML = "";

    data.forEach(tx => {

        box.innerHTML += `
        <div class="transaction-item">
            <div>
                <strong>${tx.type}</strong><br>
                ${tx.details}
            </div>

            <div>
                ₦${Number(tx.amount).toLocaleString()}
            </div>
        </div>
        `;
    });

}

// ==========================
// LOGOUT
// ==========================
async function logout() {
    await client.auth.signOut();
    window.location.href = "index.html";
}
