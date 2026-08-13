'use strict';

/**
 * lib/accountRegistration.js
 * ---------------------------------------------------------------------
 * Server-only helper that creates a Hadejia Data Hub account: a
 * Supabase Auth user plus its matching public.users profile row,
 * using the real existing schema (full_name, email, phone, role,
 * status, wallet_balance, referral_code, referred_by, pin_hash).
 *
 * Used by api/register.js (website registration).
 *
 * Not currently used by api/whatsapp-webhook.js, which has its own
 * inline copy of the same steps — that file was intentionally left
 * untouched by this fix. A future refactor could point both at this
 * helper to remove the duplication.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (via
 * lib/supabaseAdmin.js).
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('./supabaseAdmin');
const referral = require('./referral');

async function cleanupOrphanedAuthUser(userId) {
  if (!userId) return;
  try {
    await supabaseAdmin.auth.admin.deleteUser(userId);
  } catch (err) {
    console.error('[accountRegistration] Failed to clean up orphaned auth user:', err.message);
  }
}

/**
 * @param {Object} params
 * @param {string} params.fullName
 * @param {string} params.email
 * @param {string} params.phone        Already normalized to the existing
 *                                      local format ("08...").
 * @param {string} params.password     Plaintext — used once, here, to
 *                                      create the Supabase Auth user.
 *                                      Never stored, logged, or returned.
 * @param {string} params.pinHash      SHA-256 hex digest of the PIN —
 *                                      NEVER the plaintext PIN.
 * @param {string|null} [params.referredBy] Referring user's UUID, if any.
 * @returns {Promise<Object>} the newly created public.users row
 */
async function createAccount({ fullName, email, phone, password, pinHash, referredBy = null }) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    // Admin-created users are marked confirmed regardless of the
    // project's default email-confirmation setting, so the customer
    // can sign in immediately after registering — the same behavior
    // as the WhatsApp registration flow, for parity between both
    // channels.
    email_confirm: true
  });

  if (error) {
    throw new Error(error.message);
  }

  const authUser = data.user;

  try {
    const referralCode = await referral.generateUniqueReferralCode();

    const { data: newUser, error: insertErr } = await supabaseAdmin
      .from('users')
      .insert({
        id: authUser.id,
        full_name: fullName,
        email,
        phone,
        role: 'user',
        status: 'active',
        wallet_balance: 0,
        referral_code: referralCode,
        referred_by: referredBy,
        pin_hash: pinHash
      })
      .select()
      .single();

    if (insertErr) {
      throw new Error(insertErr.message);
    }

    return newUser;
  } catch (err) {
    // The Auth user exists but the profile row doesn't — clean up so
    // the customer isn't left with a half-registered, unusable
    // account and can safely retry registration.
    await cleanupOrphanedAuthUser(authUser.id);
    throw err;
  }
}

module.exports = { createAccount };
