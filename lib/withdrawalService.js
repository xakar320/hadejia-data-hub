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
/**
 * Reads the same admin_settings row the Admin panel's "Withdraw
 * feature" toggle writes to (setting_key = 'withdraw_enabled').
 * No row yet = treated as enabled (fail open), matching the default
 * behaviour before this toggle existed.
 */
async function isWithdrawEnabled() {
  const { data } = await supabaseAdmin
    .from('admin_settings')
    .select('setting_value')
    .eq('setting_key', 'withdraw_enabled')
    .maybeSingle();

  if (!data) return true;
  return data.setting_value && data.setting_value.enabled !== false;
}

async function withdraw({ userId, amount }) {
  if (!(await isWithdrawEnabled())) {
    throw new WithdrawalError('Withdrawals are temporarily unavailable — please try again later', {
      statusCode: 503,
      code: 'FEATURE_DISABLED'
    });
  }

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

  // MANUAL REVIEW FLOW: SecureWaveNG's automated customer-withdrawal
  // disbursement is not currently available for this merchant account
  // (confirmed with their support), so this no longer calls
  // securewave.customerWithdraw() at all. Instead: debit the wallet
  // now (so the balance is locked immediately and can't be
  // double-spent), log a 'pending' request, and an admin manually
  // pays the customer's bank account from the Admin -> Wallet ->
  // "Pending Withdrawals" panel, then clicks Approve (or Reject to
  // refund). If/when SecureWaveNG enables automated withdrawals,
  // restore the securewave.customerWithdraw() call here.
  const debit = await wallet.debitWallet({
    userId,
    amount: totalDebit,
    source: 'withdrawal',
    description: `Withdrawal of ₦${numericAmount} to ${bankInfo.bankName} ${bankInfo.accountNumber} (₦${fee} fee)`
  });

  // Log to the shared transactions table too, so this shows up in the
  // customer/admin transaction history view (which reads `transactions`,
  // not `wallet_history` or `withdrawal_requests`).
  const { data: txRow, error: txError } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id: userId,
      type: 'withdrawal',
      network: bankInfo.bankName,
      recipient: `${bankInfo.accountName} — ${bankInfo.accountNumber}`,
      amount: numericAmount,
      status: 'pending',
      wallet_history_id: debit.walletHistoryId,
      request_payload: { fee, totalDebit }
    })
    .select()
    .single();

  if (txError) {
    // Couldn't log it — refund immediately rather than leave the
    // customer debited with no record an admin can act on.
    await wallet.refundDebit({
      userId,
      amount: totalDebit,
      originalReference: debit.reference,
      description: `Refund: failed to record withdrawal request (${txError.message})`
    });
    throw new WithdrawalError(`Failed to record withdrawal request: ${txError.message}`, { statusCode: 500 });
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
      transaction_id: txRow.id,
      wallet_debit_reference: debit.reference,
      status: 'pending'
    })
    .select()
    .single();

  if (insertError) {
    // eslint-disable-next-line no-console
    console.error('[withdrawalService] Failed to log withdrawal_requests row:', insertError.message);
  }

  return {
    status: 'pending',
    amount: numericAmount,
    fee,
    totalDebited: totalDebit,
    bankName: bankInfo.bankName,
    accountNumber: bankInfo.accountNumber,
    accountName: bankInfo.accountName,
    newBalance: debit.balanceAfter,
    reference: (row && row.id) || txRow.id
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
  isWithdrawEnabled,
  listBanks,
  validateAccount,
  saveBankInfo,
  getBankInfo,
  withdraw,
  handleWebhookStatus
};
