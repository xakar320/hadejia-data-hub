'use strict';

/**
 * lib/withdrawalService.js
 * ---------------------------------------------------------------------
 * Customer Withdrawals: lets a user cash out their app wallet balance
 * (however it got there — Airtime-to-Cash, manual funding, etc.) to
 * their own bank account, via SecureWaveNG.
 *
 * Flow:
 *   1. listBanks()          -> bank picker for the UI
 *   2. validateAccountName() -> confirm whose account it is before saving
 *   3. saveBankInfo()       -> store the account on SecureWaveNG against
 *                              the user's email (no local copy kept)
 *   4. getBankInfo()        -> read back what's on file (or null)
 *   5. withdraw()           -> DEBITS the app wallet FIRST, then asks
 *                              SecureWaveNG to pay it out. If SecureWaveNG
 *                              rejects the request, the debit is
 *                              refunded immediately so no money is lost.
 *
 * SecureWaveNG's own example response shows a withdrawal is accepted
 * and "being processed" rather than paid out instantly — every
 * withdrawal is logged to withdrawal_requests with status
 * 'processing', not 'successful', since we don't get a synchronous
 * final result.
 * ---------------------------------------------------------------------
 */

const securewave = require('./securewave');
const wallet = require('./wallet');
const { supabaseAdmin } = require('./supabaseAdmin');
const { ValidationError, validateAmount } = require('./validation');

const MIN_WITHDRAWAL = 100;

// Tiered withdrawal fee: ₦50 below ₦10,000, ₦100 at/above ₦10,000.
// Configurable via env vars so amounts can change without a code
// redeploy — just update these in Vercel's environment settings.
const FEE_THRESHOLD = Number(process.env.WITHDRAWAL_FEE_THRESHOLD || 10000);
const FEE_LOW = Number(process.env.WITHDRAWAL_FEE_LOW || 50);
const FEE_HIGH = Number(process.env.WITHDRAWAL_FEE_HIGH || 100);

function calculateFee(amount) {
  return amount < FEE_THRESHOLD ? FEE_LOW : FEE_HIGH;
}

class WithdrawalError extends Error {
  constructor(message, { statusCode = 400, code = 'WITHDRAWAL_ERROR' } = {}) {
    super(message);
    this.name = 'WithdrawalError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function getUserEmail(userId) {
  const { data, error } = await supabaseAdmin.from('users').select('email').eq('id', userId).maybeSingle();

  if (error || !data || !data.email) {
    throw new WithdrawalError('Could not find your account email', { statusCode: 500 });
  }
  return data.email;
}

/**
 * List every bank SecureWaveNG supports, for the withdrawal form's
 * bank picker.
 */
async function listBanks() {
  return securewave.getBanks();
}

/**
 * Confirm the account name for a bank_code + account_number before
 * the user saves it as their withdrawal destination.
 */
async function validateAccount({ bankCode, accountNumber }) {
  if (!bankCode || !accountNumber) {
    throw new ValidationError('bankCode and accountNumber are required', {
      details: [{ field: 'accountNumber', message: 'bankCode and accountNumber are required' }]
    });
  }
  return securewave.validateAccountName({ bankCode, accountNumber });
}

/**
 * Save the bank account a user withdraws to. Stored on SecureWaveNG
 * against the user's email — nothing is duplicated locally.
 */
async function saveBankInfo({ userId, bankName, accountName, bankCode, accountNumber }) {
  if (!bankName || !accountName || !bankCode || !accountNumber) {
    throw new ValidationError('bankName, accountName, bankCode and accountNumber are required', {
      details: [{ field: 'accountNumber', message: 'All bank fields are required' }]
    });
  }
  const email = await getUserEmail(userId);
  return securewave.saveCustomerBankInfo({ email, bankName, accountName, bankCode, accountNumber });
}

/**
 * Read back the bank account currently on file for this user, or
 * null if none has been saved yet.
 */
async function getBankInfo(userId) {
  const email = await getUserEmail(userId);
  return securewave.getCustomerBankInfo(email);
}

/**
 * Withdraw from the app wallet to the bank account on file.
 * Debits the wallet FIRST (so a user can never withdraw more than
 * they have, and can never double-spend the same balance across two
 * concurrent withdrawal requests), then calls SecureWaveNG. On any
 * failure from SecureWaveNG, the debit is refunded before the error
 * is surfaced.
 */
async function withdraw({ userId, amount }) {
  const numericAmount = validateAmount(amount, 'amount', { min: MIN_WITHDRAWAL, max: 1000000 });
  const fee = calculateFee(numericAmount);
  const totalDebit = numericAmount + fee;

  const email = await getUserEmail(userId);

  const bankInfo = await securewave.getCustomerBankInfo(email);
  if (!bankInfo) {
    throw new WithdrawalError('No bank account on file — please add one first', {
      statusCode: 400,
      code: 'NO_BANK_INFO'
    });
  }

  // Debit amount + fee from the wallet, but only send `numericAmount`
  // to SecureWaveNG — the customer's bank receives exactly what they
  // asked for; the fee is kept as platform revenue.
  const debit = await wallet.debitWallet({
    userId,
    amount: totalDebit,
    source: 'withdrawal',
    description: `Withdrawal of ₦${numericAmount} to ${bankInfo.bankName} ${bankInfo.accountNumber} (₦${fee} fee)`
  });

  let result;
  try {
    result = await securewave.customerWithdraw({
      email,
      amount: numericAmount,
      narration: 'Hadejia Data Hub wallet withdrawal'
    });
  } catch (err) {
    // SecureWaveNG rejected the request — give the money (amount + fee) straight back.
    await wallet.refundDebit({
      userId,
      amount: totalDebit,
      originalReference: debit.reference,
      description: `Refund: withdrawal request failed (${err.message})`
    });

    await supabaseAdmin.from('withdrawal_requests').insert({
      user_id: userId,
      amount: numericAmount,
      fee,
      bank_name: bankInfo.bankName,
      account_number: bankInfo.accountNumber,
      account_name: bankInfo.accountName,
      bank_code: bankInfo.bankCode,
      wallet_debit_reference: debit.reference,
      status: 'failed',
      error_message: err.message
    });

    throw new WithdrawalError(err.message || 'Withdrawal request failed and has been refunded to your wallet', {
      statusCode: 502
    });
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from('withdrawal_requests')
    .insert({
      user_id: userId,
      amount: numericAmount,
      fee,
      bank_name: bankInfo.bankName,
      account_number: bankInfo.accountNumber,
      account_name: bankInfo.accountName,
      bank_code: bankInfo.bankCode,
      provider_reference: result.reference,
      wallet_debit_reference: debit.reference,
      status: 'processing'
    })
    .select()
    .single();

  if (insertError) {
    // The withdrawal itself already succeeded with SecureWaveNG — log
    // this but don't fail the request or touch the wallet again.
    // eslint-disable-next-line no-console
    console.error('[withdrawalService] Failed to log withdrawal_requests row:', insertError.message);
  }

  return {
    status: 'processing',
    amount: numericAmount,
    fee,
    totalDebited: totalDebit,
    bankName: bankInfo.bankName,
    accountNumber: bankInfo.accountNumber,
    accountName: bankInfo.accountName,
    newBalance: debit.balanceAfter,
    reference: (row && row.id) || result.reference
  };
}

/**
 * Reconcile a withdrawal status update from SecureWaveNG's webhook.
 * Called from api/securewave-webhook.js — that file owns signature
 * verification and payload parsing; this just applies the result.
 *
 * On success: mark the row 'successful' (money already left the
 * wallet at request time, so nothing else to do).
 * On failure/reversal: refund the ORIGINAL amount+fee that was
 * debited, so the customer isn't out of pocket for a withdrawal that
 * never actually reached their bank.
 *
 * Idempotent: only acts on a row still in 'processing' — a repeated
 * webhook delivery for the same reference is a no-op the second time.
 *
 * @param {Object} params
 * @param {string} params.reference - SecureWaveNG's reference for the withdrawal
 * @param {boolean} params.success  - whether this notification reports success
 * @param {string} [params.message]
 * @returns {Promise<{matched: boolean}>}
 */
async function handleWebhookStatus({ reference, success, message }) {
  if (!reference) return { matched: false };

  const { data: row, error } = await supabaseAdmin
    .from('withdrawal_requests')
    .select('*')
    .eq('provider_reference', reference)
    .eq('status', 'processing')
    .maybeSingle();

  if (error || !row) return { matched: false };

  if (success) {
    await supabaseAdmin
      .from('withdrawal_requests')
      .update({ status: 'successful', updated_at: new Date().toISOString() })
      .eq('id', row.id);
  } else {
    await wallet.refundDebit({
      userId: row.user_id,
      amount: Number(row.amount) + Number(row.fee || 0),
      originalReference: row.wallet_debit_reference,
      description: `Refund: withdrawal ${reference} failed at SecureWaveNG (${message || 'no reason given'})`
    });

    await supabaseAdmin
      .from('withdrawal_requests')
      .update({ status: 'failed', error_message: message || 'Failed at provider', updated_at: new Date().toISOString() })
      .eq('id', row.id);
  }

  return { matched: true };
}

module.exports = {
  WithdrawalError,
  MIN_WITHDRAWAL,
  listBanks,
  validateAccount,
  saveBankInfo,
  getBankInfo,
  withdraw,
  handleWebhookStatus
};
