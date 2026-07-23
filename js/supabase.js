// =====================================
// Hadejia Data Hub
// js/supabase.js
// =====================================

// PASTE YOUR SUPABASE URL HERE
const SUPABASE_URL =
"https://xlmwkybfkwmiinovvvob.supabase.co";

// PASTE YOUR SUPABASE ANON KEY HERE
const SUPABASE_ANON_KEY =
"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhsbXdreWJma3dtaWlub3Z2dm9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MjY5ODYsImV4cCI6MjEwMDIwMjk4Nn0.iyu18AEuKcvYuIGAtvTtyeCII3124jp5ho_VvgziCWs";

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
