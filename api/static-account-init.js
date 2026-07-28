'use strict';

/**
 * api/static-account-init.js
 * ---------------------------------------------------------------------
 * POST /api/static-account-init
 * Generates (or returns the existing) permanent SecureWaveNG static
 * virtual account for the signed-in user.
 *
 * Body: { bvn }
 *
 * PRIVACY: the BVN is sent to SecureWaveNG for verification only, over
 * this server-to-server call, and is NEVER written to our database —
 * only the resulting account_number/bank_name/account_name are stored.
 * It also never appears in any log line here.
 *
 * Idempotent: if the user already has a static account on file, this
 * returns it immediately without calling SecureWaveNG again (so BVN
 * only ever needs to be submitted once).
 * ---------------------------------------------------------------------
 */

const { requireAuth } = require('../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../lib/response');
const { validateRequiredFields, ValidationError } = require('../lib/validation');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const securewave = require('../lib/securewave');

const BVN_REGEX = /^\d{11}$/;

async function staticAccountInit(req, res) {
  const body = req.body || {};

  // Already have one? Return it — no need to touch SecureWaveNG or ask for BVN again.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from('dynamic_accounts')
    .select('account_number, bank_name, account_name')
    .eq('user_id', req.user.id)
    .eq('provider', 'securewaveng')
    .eq('account_type', 'static')
    .eq('is_active', true)
    .maybeSingle();

  if (existingErr) {
    throw new Error(`Failed to check existing static account: ${existingErr.message}`);
  }

  if (existing) {
    return sendSuccess(res, {
      accountNumber: existing.account_number,
      bankName: existing.bank_name,
      accountName: existing.account_name,
      alreadyExisted: true
    });
  }

  validateRequiredFields(body, ['bvn']);
  const bvn = String(body.bvn).trim();

  if (!BVN_REGEX.test(bvn)) {
    throw new ValidationError('BVN must be exactly 11 digits', {
      details: [{ field: 'bvn', message: 'BVN must be exactly 11 digits' }]
    });
  }

  const fullName = (req.user.fullName || 'Customer User').trim();
  const [firstName, ...rest] = fullName.split(' ');
  const lastName = rest.join(' ') || 'User';

  const accounts = await securewave.generateStaticAccount({
    email: req.user.email,
    firstName: firstName || 'Customer',
    lastName,
    phone: req.user.phone || '08000000000',
    bvn
    // bvn is used here only — not returned, not logged, not stored below.
  });

  const account = accounts[0];

  const { error: insertErr } = await supabaseAdmin.from('dynamic_accounts').insert({
    user_id: req.user.id,
    provider: 'securewaveng',
    account_type: 'static',
    bank_name: account.bankName,
    account_number: account.accountNumber,
    account_name: account.accountName,
    provider_ref: account.reference,
    is_active: true
  });

  if (insertErr) {
    throw new Error(`Failed to save static account: ${insertErr.message}`);
  }

  return sendSuccess(
    res,
    {
      accountNumber: account.accountNumber,
      bankName: account.bankName,
      accountName: account.accountName,
      alreadyExisted: false
    },
    { message: 'Permanent account number created' }
  );
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAuth(staticAccountInit)(req, res);
});
