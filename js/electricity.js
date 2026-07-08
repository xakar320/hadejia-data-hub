// ===============================
// Hadejia Data Hub
// electricity.js
// ===============================

const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

let currentUser = null;
let currentBalance = 0;

// CHECK USER
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

// BUY ELECTRICITY

async function buyElectricity() {

    const disco =
        document.getElementById("disco").value;

    const meter =
        document.getElementById("meter").value.trim();

    const meterType =
        document.getElementById("meterType").value;

    const amount =
        Number(document.getElementById("amount").value);

    const pin =
        document.getElementById("pin").value.trim();

    if (meter.length < 8) {
        alert("Enter a valid meter number");
        return;
    }

    if (amount < 500) {
        alert("Minimum amount is ₦500");
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

        const { data: user } = await client
            .from("users")
            .select("transaction_pin")
            .eq("id", currentUser.id)
            .single();

        if (user.transaction_pin !== pin) {
            alert("Incorrect PIN");
            return;
        }

        const response = await fetch("/api/place-order", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({

                serviceType: "electricity",

                disco,

                meter,

                meterType,

                amount

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
                balance: currentBalance - amount
            })
            .eq("id", currentUser.id);

        await client
            .from("transactions")
            .insert([{

                user_id: currentUser.id,

                type: "Electricity",

                details:
                    disco +
                    " Meter: " +
                    meter,

                amount,

                status: "Success"

            }]);

        alert("Electricity Purchase Successful");

        location.href = "dashboard.html";

    } catch (err) {

        console.error(err);

        alert("Network Error");

    }

}

document
.getElementById("buyElectricityBtn")
.addEventListener("click", buyElectricity);
