// ====================================
// Hadejia Data Hub
// admin.js
// ====================================

const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

let currentUser = null;

// ===============================
// CHECK ADMIN LOGIN
// ===============================

async function checkAdmin() {

    const {
        data: { session }
    } = await client.auth.getSession();

    if (!session) {

        location.href = "index.html";

        return;

    }

    currentUser = session.user;

    const { data, error } = await client

        .from("users")

        .select("is_admin")

        .eq("id", currentUser.id)

        .single();

    if (error || !data || data.is_admin !== true) {

        alert("Access Denied");

        location.href = "dashboard.html";

        return;

    }

    loadUsers();

}

// ===============================
// LOAD USERS
// ===============================

async function loadUsers() {

    const table =
        document.getElementById("usersTable");

    table.innerHTML = "Loading Users...";

    const { data, error } = await client

        .from("users")

        .select("*")

        .order("created_at", {
            ascending: false
        });

    if (error) {

        table.innerHTML =
        "Failed To Load Users";

        return;

    }

    table.innerHTML = "";

    data.forEach(user => {

        table.innerHTML += `

<tr>

<td>${user.full_name || ""}</td>

<td>${user.email}</td>

<td>

₦${Number(user.balance || 0).toLocaleString()}

</td>

<td>

<button
onclick="creditUser('${user.id}')">

Credit

</button>

<button
onclick="debitUser('${user.id}')">

Debit

</button>

</td>

</tr>

`;

    });

}

// ===============================
// CREDIT USER
// ===============================

async function creditUser(id){

    const amount =
    prompt("Enter Amount");

    if(!amount) return;

    const { data } = await client

    .from("users")

    .select("balance")

    .eq("id",id)

    .single();

    const balance =
    Number(data.balance || 0);

    await client

    .from("users")

    .update({

        balance:
        balance +
        Number(amount)

    })

    .eq("id",id);

    alert("Wallet Credited");

    loadUsers();

}

// ===============================
// DEBIT USER
// ===============================

async function debitUser(id){

    const amount =
    prompt("Enter Amount");

    if(!amount) return;

    const { data } = await client

    .from("users")

    .select("balance")

    .eq("id",id)

    .single();

    const balance =
    Number(data.balance || 0);

    await client

    .from("users")

    .update({

        balance:
        balance -
        Number(amount)

    })

    .eq("id",id);

    alert("Wallet Debited");

    loadUsers();

}

checkAdmin();
