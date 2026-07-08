// ===============================
// Hadejia Data Hub
// airtime.js
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
// BUY AIRTIME
// ===============================

async function buyAirtime() {

    const network =
        document.getElementById("network").value;

    const phone =
        document.getElementById("phone").value.trim();

    const amount =
        Number(document.getElementById("amount").value);

    const pin =
        document.getElementById("pin").value.trim();

    if (!/^0\d{10}$/.test(phone)) {

        alert("Enter valid phone number");

        return;

    }

    if (amount < 50) {

        alert("Minimum airtime is ₦50");

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

            alert("Incorrect transaction PIN");

            return;

        }

        // Send Airtime Request

        const response = await fetch("/api/place-order", {

            method: "POST",

            headers: {

                "Content-Type": "application/json"

            },

            body: JSON.stringify({

                serviceType: "airtime",

                network,

                phone,

                amount

            })

        });

        const result = await response.json();

        if (!result.status) {

            alert(result.message);

            return;

        }

        // Deduct Wallet

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

                type: "Airtime",

                details: network + " Airtime to " + phone,

                amount: amount,

                status: "Success"

            }]);

        alert("Airtime Purchase Successful");

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

.getElementById("buyAirtimeBtn")

.addEventListener("click", buyAirtime);
