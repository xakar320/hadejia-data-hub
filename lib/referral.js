'use strict';

/**
 * lib/referral.js
 * ---------------------------------------------------------------------
 * Small helper on top of the EXISTING `users.referral_code` /
 * `users.referred_by` columns. There was no generation or validation
 * logic anywhere in the codebase (confirmed by inspection — the only
 * existing reference is display-only in js/profile.js), so this file
 * adds just the minimum needed:
 *
 *   - generateUniqueReferralCode() — used once, at WhatsApp
 *     registration time, to give a brand-new customer their own code.
 *   - findUserByReferralCode()     — used to validate a code a
 *     customer enters (e.g. during WhatsApp onboarding).
 *
 * This does NOT touch or reassign any existing user's referral_code.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY env vars
 * (via lib/supabaseAdmin.js).
 * ---------------------------------------------------------------------
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabaseAdmin');

// Excludes visually ambiguous characters (0/O, 1/I) since referral
// codes are meant to be read/typed by customers.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_GENERATION_ATTEMPTS = 8;

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

/**
 * Look up the user who owns a given referral code.
 *
 * @param {string} code
 * @returns {Promise<{id: string}|null>}
 */
async function findUserByReferralCode(code) {
  if (!code || typeof code !== 'string') return null;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('referral_code', code.trim().toUpperCase())
    .maybeSingle();

  if (error) {
    throw new Error(`Referral lookup failed: ${error.message}`);
  }

  return data || null;
}

/**
 * Generate a referral code guaranteed not to collide with an existing
 * one. Retries a handful of times on the (extremely unlikely) chance
 * of a collision before giving up.
 *
 * @returns {Promise<string>}
 */
async function generateUniqueReferralCode() {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const code = randomCode(CODE_LENGTH);

    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('referral_code', code)
      .maybeSingle();

    if (error) {
      throw new Error(`Referral code uniqueness check failed: ${error.message}`);
    }

    if (!data) {
      return code;
    }
  }

  throw new Error('Could not generate a unique referral code after multiple attempts');
}

module.exports = {
  findUserByReferralCode,
  generateUniqueReferralCode
};
