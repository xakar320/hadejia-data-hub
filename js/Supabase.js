// ==========================
// SUPABASE CONFIG
// ==========================
const SUPABASE_URL = "https://zjenhfapfhuoogxorung.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpqZW5oZmFwZmh1b29neG9ydW5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3OTkwNjMsImV4cCI6MjA5NjM3NTA2M30.Jymmb6ZACaR5Q5pYSVJzJIkqhkmera-Q7jVXvmaX0";

// Create Supabase client
const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Export for other files (optional)
window.client = client;
