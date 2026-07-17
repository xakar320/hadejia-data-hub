// ======================================
// Hadejia Data Hub
// buy-data.js
// Part 3C
// ======================================

let currentUser = null;
let currentUserData = null;

// ===============================
// DATA PLANS
// ===============================

const DATA_PLANS = {

    MTN: [
        { id: 1, name: "500MB SME", amount: 180 },
        { id: 2, name: "1GB SME", amount: 350 },
        { id: 3, name: "2GB SME", amount: 700 },
        { id: 4, name: "5GB SME", amount: 1750 }
    ],

    AIRTEL: [
        { id: 5, name: "500MB", amount: 200 },
        { id: 6, name: "1GB", amount: 380 },
        { id: 7, name: "2GB", amount: 760 }
    ],

    GLO: [
        { id: 8, name: "1GB", amount: 300 },
        { id: 9, name: "2GB", amount: 600 }
    ],

    "9MOBILE": [
        { id: 10, name: "1GB", amount: 320 },
        { id: 11, name: "2GB", amount: 640 }
    ]

};

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

    loadProfile();

}

// ===============================
// LOAD PROFILE
// ===============================

async function loadProfile() {

    const { data, error } = await client

        .from("users")

        .select("*")

        .eq("id", currentUser.id)

        .single();

    if (error) {

        alert(error.message);

        return;

    }

    currentUserData = data;

    document.getElementById("userName").textContent =
        data.name;

    document.getElementById("walletBalance").textContent =
        "₦" + Number(data.balance).toLocaleString();

}

// ===============================
// LOAD DATA PLANS
// ===============================

const network =
document.getElementById("network");

const plan =
document.getElementById("plan");

network.addEventListener("change", () => {

    plan.innerHTML =
    `<option value="">Select Plan</option>`;

    const plans =
    DATA_PLANS[network.value];

    if (!plans) return;

    plans.forEach(item => {

        plan.innerHTML += `

        <option
        value="${item.id}"
        data-price="${item.amount}">

        ${item.name} - ₦${item.amount}

        </option>

        `;

    });

});

// ===============================
// BUY BUTTON
// ===============================

document
.getElementById("buyBtn")
.addEventListener("click", () => {

    document.getElementById("result")
    .innerHTML =

    `
    <span class="loading">

    Ready for API Purchase...

    </span>
    `;

});

// ===============================
// START
// ===============================

checkUser();
