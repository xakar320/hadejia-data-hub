// ===============================
// Hadejia Data Hub
// voice.js
// ===============================

const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

let currentUser = null;
let currentBalance = 0;

// ===============================
// VOICE PLANS
// ===============================

const voicePlans = {

    MTN: [
        {
            name: "₦120 MTN Voice Bundle",
            price: 120,
            plan_id: "26117793",
            variation_code: "400_7days"
        }
    ],

    AIRTEL: [
        {
            name: "₦100 Airtel Voice Bundle",
            price: 100,
            plan_id: "26117794",
            variation_code: "TalkMore_100"
        }
    ],

    GLO: [
        {
            name: "₦100 Glo Voice Bundle",
            price: 100,
            plan_id: "GLOVOICE100",
            variation_code: "GLO_VOICE_100"
        }
    ],

    "9MOBILE": [
        {
            name: "₦100 9mobile Voice Bundle",
            price: 100,
            plan_id: "9MVOICE100",
            variation_code: "9MOBILE_VOICE_100"
        }
    ]

};

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

    loadPlans();

}

// ===============================
// LOAD PLANS
// ===============================

function loadPlans() {

    const network =
        document.getElementById("network").value;

    const select =
        document.getElementById("voicePlan");

    select.innerHTML = "";

    voicePlans[network].forEach((plan, index) => {

        select.innerHTML += `

        <option value="${index}">

        ${plan.name}

        </option>

        `;

    });

}

document

.getElementById("network")

.addEventListener("change", loadPlans);

// ===============================
// BUY VOICE
// ===============================

async function buyVoice() {

    const network =
        document.getElementById("network").value;

    const index =
        document.getElementById("voicePlan").value;

    const phone =
        document.getElementById("phone").value;

    const pin =
        document.getElementById("pin").value;

    if (!/^0\\d{10}$/.test(phone)) {

        alert("Enter valid phone number");

        return;

    }

    if (pin.length !== 4) {

        alert("Enter transaction PIN");

        return;

    }

    const plan =
        voicePlans[network][index];

    if (currentBalance < plan.price) {

        alert("Insufficient Balance");

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

                "Content-Type":
                "application/json"

            },

            body: JSON.stringify({

                serviceType: "voice",

                network,

                phone,

                variation_code:
                plan.variation_code,

                plan_id:
                plan.plan_id,

                amount:
                plan.price,

                plan_name:
                plan.name

            })

        });

        const result =
            await response.json();

        if (!result.status) {

            alert(result.message);

            return;

        }

        await client

            .from("users")

            .update({

                balance:
                currentBalance - plan.price

            })

            .eq("id", currentUser.id);

        await client

            .from("transactions")

            .insert([{

                user_id:
                currentUser.id,

                type:
                "Voice Bundle",

                details:
                network + " " + plan.name,

                amount:
                plan.price,

                status:
                "Success"

            }]);

        alert("Voice Bundle Successful");

        location.href =
        "dashboard.html";

    }

    catch (err) {

        console.error(err);

        alert("Network Error");

    }

}

// ===============================
// START
// ===============================

document

.getElementById("buyVoiceBtn")

.addEventListener("click", buyVoice);

checkUser();
