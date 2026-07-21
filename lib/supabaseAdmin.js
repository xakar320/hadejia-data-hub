'use strict';

/**
 * lib/supabaseAdmin.js
 * ---------------------------------------------------------------------
 * Server-only Supabase client using the service_role key.
 * This bypasses Row Level Security — it must NEVER be imported into
 * any client-side / browser bundle, only inside Vercel serverless
 * functions (api/*.js) and server-side modules.
 *
 * Required environment variables (set in Vercel project settings,
 * never committed to source control):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * ---------------------------------------------------------------------
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing required env vars: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY'
  );
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = { supabaseAdmin };
