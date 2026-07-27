'use strict';

/**
 * api/fund-wallet-init.js
 * ---------------------------------------------------------------------
 * POST /api/fund-wallet-init
 * Generates a SecureWaveNG Dynamic Virtual Account for the signed-in
 * user to transfer a specific amount into, and records a pending
 * 'wallet_funding' transaction for the webhook to resolve once the
 * transfer lands.
 *
 * Body: { amount }
 *
 * Response data: { accountNumber, bankName, accountName, amount,
 *                   expiresInSeconds, reference }
 * ---------------------------------------------------------------------
 */

const { requireAuth } = require('../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../lib/response');
const { validateRequiredFields, validateAmount } = require('../lib/validation');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const transactions = require('../lib/transactions');
const securewave = require('../lib/securewave');

async function initFundWallet(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['amount']);
  const amount = validateAmount(body.amount, 'amount', { min: 100, max: 500000 });

  const fullName = (req.user.fullName || 'Customer User').trim();
  const [firstName, ...rest] = fullName.split(' ');
  const lastName = rest.join(' ') || 'User';

  const account = await securewave.generateDynamicAccount({
    email: req.user.email,
    firstName: firstName || 'Customer',
    lastName,
    phone: req.user.phone || '08000000000',
    amount
  });

  // Record the funding intent. type 'wallet_funding' means
  // createPendingTransaction does NOT debit the wallet — the webhook
  // credits it once SecureWaveNG confirms the transfer landed.
  await transactions.createPendingTransaction({
    userId: req.user.id,
    type: 'wallet_funding',
    amount: account.amountToPay,
    idempotencyKey: account.reference,
    requestPayload: {
      provider: 'securewaveng',
      account_reference: account.reference,
      account_number: account.accountNumber
    }
  });

  // Audit row for the virtual account itself, and what the webhook
  // matches against (by account_number) to find this user.
  const { error: dbError } = await supabaseAdmin.from('dynamic_accounts').insert({
    user_id: req.user.id,
    provider: 'securewaveng',
    bank_name: account.bankName,
    account_number: account.accountNumber,
    account_name: account.accountName,
    provider_ref: account.reference,
    is_active: true
  });

  if (dbError) {
    // eslint-disable-next-line no-console
    console.error('[fund-wallet-init] Failed to record dynamic_accounts row:', dbError.message);
  }

  return sendSuccess(
    res,
    {
      accountNumber: account.accountNumber,
      bankName: account.bankName,
      accountName: account.accountName,
      amount: account.amountToPay,
      expiresInSeconds: account.expiresInSeconds,
      reference: account.reference
    },
    { message: 'Virtual account generated' }
  );
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAuth(initFundWallet)(req, res);
});
