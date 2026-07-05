// ==========================
// CHECK LOGIN
// ==========================
let currentUser = null;

window.addEventListener("load", async () => {

    const { data: { session } } = await client.auth.getSession();

    if (!session) {
        window.location.href = "index.html";
        return;
    }

    currentUser = session.user;

    loadUser();
    loadTransactions();
});

// ==========================
// LOAD USER
// ==========================
async function loadUser() {

    const { data, error } = await client
        .from("users")
        .select("*")
        .eq("id", currentUser.id)
        .single();

    if (error || !data) {
        alert("Unable to load profile");
        return;
    }

    document.getElementById("fullName").innerText = data.full_name || "-";
    document.getElementById("email").innerText = data.email || "-";
    document.getElementById("phone").innerText = data.phone || "-";
    document.getElementById("balance").innerText =
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

    const box = document.getElementById("transactions");

    const { data, error } = await client
        .from("transactions")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("created_at", { ascending: false })
        .limit(10);

    if (error) {
        box.innerHTML = "Unable to load transactions";
        return;
    }

    if (!data.length) {
        box.innerHTML = "No transactions yet.";
        return;
    }

    box.innerHTML = "";

    data.forEach(tx => {

        box.innerHTML += `
            <div class="transactionItem">
                <div>
                    <b>${tx.type}</b><br>
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
// ADMIN PAGE
// ==========================
function goAdmin() {
    window.location.href = "admin.html";
}

// ==========================
// LOGOUT
// ==========================
async function logout() {

    await client.auth.signOut();

    window.location.href = "index.html";

}
