// ======================================
// Hadejia Data Hub
// dynamic-account.js
// ======================================

const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

let currentUser = null;

// ===============================
// CHECK LOGIN
// ===============================

async function checkUser() {

    const {
        data: { session }
    } = await client.auth.getSession();

    if (!session) {

        location.href = "index.html";

        return;

    }

    currentUser = session.user;

    loadDynamicAccount();

}

// ===============================
// LOAD ACCOUNT
// ===============================

async function loadDynamicAccount() {

    const { data, error } = await client

        .from("users")

        .select("*")

        .eq("id", currentUser.id)

        .single();

    if (error) {

        alert("Unable to load account");

        return;

    }

    if (data.account_number) {

        document.getElementById("accountName").textContent =
            data.account_name;

        document.getElementById("bankName").textContent =
            data.bank_name;

        document.getElementById("accountNumber").textContent =
            data.account_number;

        return;

    }

    generateAccount(data);

}

// ===============================
// GENERATE ACCOUNT
// ===============================

async function generateAccount(user) {

    document.getElementById("generateBtn").disabled = true;

    document.getElementById("generateBtn").innerHTML =
        "Generating...";

    try {

        const response = await fetch("/api/create-account", {

            method: "POST",

            headers: {

                "Content-Type": "application/json"

            },

            body: JSON.stringify({

                user_id: user.id,

                name: user.full_name,

                email: user.email,

                phone: user.phone

            })

        });

        const result = await response.json();

        if (!result.status) {

            alert(result.message);

            return;

        }

        await client

            .from("users")

            .update({

                account_name:
                result.account_name,

                account_number:
                result.account_number,

                bank_name:
                result.bank_name

            })

            .eq("id", user.id);

        document.getElementById("accountName").textContent =
            result.account_name;

        document.getElementById("bankName").textContent =
            result.bank_name;

        document.getElementById("accountNumber").textContent =
            result.account_number;

        alert("Virtual Account Created Successfully");

    }

    catch (err) {

        console.error(err);

        alert("Unable to generate account");

    }

}

checkUser();
