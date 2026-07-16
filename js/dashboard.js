// =====================================
// Hadejia Data Hub
// dashboard.js
// =====================================

// Global Variables
let currentUser = null;
let currentUserData = null;

// ===============================
// CHECK LOGIN
// ===============================

async function checkUser() {

    try {

        const {
            data: { session }
        } = await client.auth.getSession();

        if (!session) {

            location.href = "index.html";
            return;

        }

        currentUser = session.user;

        await loadUserProfile();

    }

    catch (err) {

        console.error(err);

        alert("Failed to verify login.");

    }

}

// ===============================
// LOAD USER PROFILE
// ===============================

async function loadUserProfile() {

    try {

        const { data, error } =
            await client
            .from("users")
            .select("*")
            .eq("id", currentUser.id)
            .single();

        if (error) throw error;

        currentUserData = data;

        document.getElementById("userName").textContent =
            data.full_name || "User";

        document.getElementById("userEmail").textContent =
            data.email;

        document.getElementById("userPhone").textContent =
            data.phone || "";

        document.getElementById("walletBalance").textContent =
            "₦" + Number(data.balance || 0).toLocaleString();

        if (data.is_admin === true) {

            document.getElementById("adminBtn").style.display =
                "inline-block";

        }

    }

    catch (err) {

        console.error(err);

        alert("Unable to load profile.");

    }

}

// ===============================
// LOGOUT
// ===============================

async function logout() {

    await client.auth.signOut();

    location.href = "index.html";

}

// ===============================
// START
// ===============================

window.addEventListener("load", () => {

    checkUser();

});
