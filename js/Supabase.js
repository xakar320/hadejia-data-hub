// =====================================
// Hadejia Data Hub
// js/supabase.js
// =====================================

// PASTE YOUR SUPABASE URL HERE
const SUPABASE_URL =
"https://zjenhfapfhuoogxorung.supabase.co";

// PASTE YOUR SUPABASE ANON KEY HERE
const SUPABASE_ANON_KEY =
"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpqZW5oZmFwZmh1b29neG9ydW5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkwNjMsImV4cCI6MjA5NjM3NTA2M30.Jymmb6ZACaR5r0Q5pYSVJzJIkqhkmera-Q7jVXvmaX0";

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
