// js/dashboard.js

const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let userProfile = null;

// ===============================
// CHECK LOGIN
// ===============================

async function checkUser() {

    const { data:{ session } } = await client.auth.getSession();

    if(!session){
        window.location.href="index.html";
        return;
    }

    currentUser = session.user;

    await loadProfile();

}

// ===============================
// LOAD PROFILE
// ===============================

async function loadProfile(){

    const { data,error } = await client
    .from("users")
    .select("*")
    .eq("id",currentUser.id)
    .single();

    if(error){

        alert("Unable to load profile");

        return;

    }

    userProfile=data;

    showProfile();

}

// ===============================
// SHOW PROFILE
// ===============================

function showProfile(){

    document.getElementById("fullName").innerHTML =
    userProfile.full_name;

    document.getElementById("walletBalance").innerHTML =
    "₦"+Number(userProfile.balance).toLocaleString();

    if(userProfile.is_admin){

        document.getElementById("adminBtn")
        .style.display="inline-block";

    }

}

// ===============================
// LOGOUT
// ===============================

async function logout(){

    await client.auth.signOut();

    location.href="index.html";

}

checkUser();

/* ==========================
   LOAD USER PROFILE
========================== */

async function loadUserProfile() {
    try {
        const {
            data: { session }
        } = await client.auth.getSession();

        if (!session) {
            window.location.href = "index.html";
            return;
        }

        currentUser = session.user;

        const { data, error } = await client
            .from("users")
            .select("*")
            .eq("id", currentUser.id)
            .single();

        if (error) throw error;

        // User details
        document.getElementById("userName").textContent =
            data.full_name || data.account_name || "User";

        document.getElementById("userEmail").textContent =
            data.email || currentUser.email;

        document.getElementById("userPhone").textContent =
            data.phone || "No phone number";

        document.getElementById("walletBalance").textContent =
            "₦" + Number(data.balance || 0).toLocaleString();

        // Save for later use
        currentBalance = Number(data.balance || 0);
        currentUserData = data;

        // Admin button
        if (data.is_admin === true) {
            document.getElementById("adminLinkBtn").style.display = "inline-block";
        }

    } catch (err) {
        console.error(err);
        alert("Failed to load profile.");
    }
}

/* ==========================
   LOAD TRANSACTION HISTORY
========================== */

async function loadTransactions() {
    try {

        const { data, error } = await client
            .from("transactions")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("created_at", { ascending: false })
            .limit(20);

        if (error) throw error;

        const list = document.getElementById("transactionList");
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

            const amount =
                "₦" + Number(tx.amount || 0).toLocaleString();

            const date =
                new Date(tx.created_at).toLocaleString();

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

                        <small>${tx.status}</small>

                    </div>

                </div>
            `;
        });

    } catch (err) {
        console.error(err);

        document.getElementById("transactionList").innerHTML =
        `
        <div class="empty">
            Failed to load transactions.
        </div>
        `;
    }
}

window.addEventListener("load", async () => {
    await loadUserProfile();
    await loadTransactions();
});
