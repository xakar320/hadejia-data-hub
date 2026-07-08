// ===============================
// Hadejia Data Hub
// cable.js
// ===============================

const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

let currentUser = null;
let currentBalance = 0;

// ===============================
// CHECK USER
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

    const { data } = await client
        .from("users")
        .select("balance")
        .eq("id", currentUser.id)
        .single();

    currentBalance = Number(data.balance || 0);

}

checkUser();

// ===============================
// BUY CABLE TV
// ===============================

async function buyCable() {

    const provider =
        document.getElementById("provider").value;

    const smartcard =
        document.getElementById("smartcard").value.trim();

    const packageCode =
        document.getElementById("package").value;

    const packageName =
        document.getElementById("package").options[
            document.getElementById("package").selectedIndex
        ].text;

    const amount =
        Number(document.getElementById("amount").value);

    const pin =
        document.getElementById("pin").value.trim();

    if (smartcard.length < 6) {
        alert("Enter a valid Smartcard / IUC Number");
        return;
    }

    if (amount <= 0) {
        alert("Enter a valid amount");
        return;
    }

    if (currentBalance < amount) {
        alert("Insufficient wallet balance");
        return;
    }

    if (pin.length !== 4) {
        alert("Enter your 4-digit transaction PIN");
        return;
    }

    try {

        // Verify PIN

        const { data: user } = await client
            .from("users")
            .select("transaction_pin")
            .eq("id", currentUser.id)
            .single();

        if (user.transaction_pin !== pin) {
            alert("Incorrect Transaction PIN");
            return;
        }

        // Call API

        const response = await fetch("/api/place-order", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({

                serviceType: "cable",

                provider,

                smartcard,

                package: packageCode,

                amount

            })

        });

        const result = await response.json();

        if (!result.status) {
            alert(result.message);
            return;
        }

        // Update Wallet

        await client
            .from("users")
            .update({
                balance: currentBalance - amount
            })
            .eq("id", currentUser.id);

        // Save Transaction

        await client
            .from("transactions")
            .insert([{

                user_id: currentUser.id,

                type: "Cable TV",

                details:
                    provider +
                    " - " +
                    packageName,

                amount,

                status: "Success"

            }]);

        alert("Cable Subscription Successful");

        location.href = "dashboard.html";

    }

    catch (err) {

        console.error(err);

        alert("Network Error");

    }

}

// ===============================
// BUTTON
// ===============================

document
.getElementById("buyCableBtn")
.addEventListener("click", buyCable);
