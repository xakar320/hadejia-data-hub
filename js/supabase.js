// =====================================
// Hadejia Data Hub
// js/supabase.js
// =====================================

// PASTE YOUR SUPABASE URL HERE
const SUPABASE_URL =
"https://xlmwkybfkwmiinovvvob.supabase.co";

// PASTE YOUR SUPABASE ANON KEY HERE
const SUPABASE_ANON_KEY =
"sb_publishable_tEGEv39lkdBjcV1hS11g4w_MTd0c9_O";

// Create Supabase Client
const client = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

// Check Connection (Optional)
async function testConnection() {

    try {

        const {
            data,
            error
        } = await client.auth.getSession();

        if (error) {

            console.error(error);

        } else {

            console.log("✅ Supabase Connected");

        }

    }

    catch (err) {

        console.error("Connection Error:", err);

    }

}

testConnection();
