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
