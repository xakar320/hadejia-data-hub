'use strict';

/**
 * lib/airtimeCashService.js
 * ---------------------------------------------------------------------
 * Airtime-to-Cash: lets a user convert airtime on their own phone into
 * app wallet cash, at a discount configured in airtime_cash_plans.
 *
 * Unlike the "place an order" pipeline in orderService.js (which
 * DEBITS the wallet immediately and calls the provider once), this is
 * a two-step, CREDIT-producing flow:
 *
 *   1. initiateRequest() -> autosync.initiateAirtimeToCash() sends an
 *      OTP to the phone number provided. No money moves yet. A row is
 *      logged in airtime_cash_requests with status 'otp_pending'.
 *   2. completeRequest() -> autosync.completeAirtimeToCash() confirms
 *      the OTP, which actually pulls the airtime. Only on a
 *      'successful' result here do we credit the user's wallet
 *      (amount ACTUALLY shared x rate_percent — partial completion
 *      can mean less airtime moved than requested, per AutosyncNG's
 *      splitting behaviour).
 *
 * resendOtp() re-sends the OTP for a still-pending request.
 *
 * Every step re-checks that the request row belongs to the calling
 * user before touching it or the provider, so one user can never
 * complete/resend another user's pending request.
 *
 * Required tables (see accompanying SQL):
 *   airtime_cash_plans    - admin-managed rate config per network
 *   airtime_cash_requests - tracks each two-step request
 * ---------------------------------------------------------------------
 */

const autosync = require('./autosync');
const wallet = require('./wallet');
const { supabaseAdmin } = require('./supabaseAdmin');
const { ValidationError, validatePhone, validateAmount, validateProductId } = require('./validation');

class AirtimeCashError extends Error {
  constructor(message, { statusCode = 400, code = 'AIRTIME_CASH_ERROR' } = {}) {
    super(message);
    this.name = 'AirtimeCashError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validateSharePin(sharePin) {
  const value = String(sharePin || '').trim();
  if (!/^\d{4,6}$/.test(value)) {
    throw new ValidationError('sharePin must be 4-6 digits', {
      details: [{ field: 'sharePin', message: 'sharePin must be 4-6 digits' }]
    });
  }
  return value;
}

/**
 * Fetch the active pricing/config row for a network's airtime-to-cash
 * product. Requires exactly one active row per product_id.
 */
async function getActivePlan(productId) {
  const { data, error } = await supabaseAdmin
    .from('airtime_cash_plans')
    .select('*')
    .eq('product_id', productId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    throw new AirtimeCashError(`Failed to load airtime-to-cash plan: ${error.message}`, { statusCode: 500 });
  }
  if (!data) {
    throw new AirtimeCashError('Airtime-to-cash is not available for this network right now', { statusCode: 404 });
  }
  return data;
}

/**
 * Step 1: initiate a request. Sends an OTP to the phone provided via
 * AutosyncNG and logs a tracking row. No wallet movement here.
 */
async function initiateRequest({ userId, productId, phone, amount, sharePin }) {
  validateProductId(productId);
  const normalizedPhone = validatePhone(phone);
  const numericAmount = validateAmount(amount, 'amount', { min: 1, max: 1000000 });
  const pin = validateSharePin(sharePin);

  const plan = await getActivePlan(productId);

  if (plan.min_amount != null && numericAmount < Number(plan.min_amount)) {
    throw new ValidationError(`amount must be at least ₦${plan.min_amount}`, {
      details: [{ field: 'amount', message: `amount must be at least ₦${plan.min_amount}` }]
    });
  }
  if (plan.max_amount != null && numericAmount > Number(plan.max_amount)) {
    throw new ValidationError(`amount must not exceed ₦${plan.max_amount}`, {
      details: [{ field: 'amount', message: `amount must not exceed ₦${plan.max_amount}` }]
    });
  }

  const result = await autosync.initiateAirtimeToCash({
    phone: normalizedPhone,
    productId,
    amount: numericAmount,
    sharePin: pin
  });

  // A 'pending' status here is the EXPECTED outcome (OTP sent, awaiting
  // confirmation) — only an explicit provider error, or a missing
  // reference to track, counts as a failure at this stage.
  if (result.status === 'error' || !result.reference) {
    throw new AirtimeCashError(result.message || 'Failed to initiate airtime-to-cash request', { statusCode: 502 });
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from('airtime_cash_requests')
    .insert({
      user_id: userId,
      reference: result.reference,
      request_ref: result.requestRef,
      product_id: productId,
      network: plan.network || productId,
      phone: normalizedPhone,
      amount: numericAmount,
      rate_percent: plan.rate_percent,
      status: 'otp_pending'
    })
    .select()
    .single();

  if (insertError) {
    throw new AirtimeCashError(`Failed to save airtime-to-cash request: ${insertError.message}`, { statusCode: 500 });
  }

  return {
    reference: row.reference,
    message: result.message || 'An OTP has been sent to the phone number provided'
  };
}

/**
 * Loads a request row and confirms it belongs to userId. Prevents one
 * user from completing/resending another user's pending request.
 */
async function getOwnedRequest(userId, reference) {
  const { data, error } = await supabaseAdmin
    .from('airtime_cash_requests')
    .select('*')
    .eq('reference', reference)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new AirtimeCashError(`Failed to load request: ${error.message}`, { statusCode: 500 });
  }
  if (!data) {
    throw new AirtimeCashError('Request not found', { statusCode: 404, code: 'NOT_FOUND' });
  }
  return data;
}

/**
 * Step 2: confirm the OTP. Only on a 'successful' provider response
 * do we credit the wallet — using the amount the provider says was
 * ACTUALLY shared (handles partial completion), not the amount
 * originally requested. Idempotent: re-calling with a reference
 * that's already 'successful' returns the same result without
 * crediting twice.
 */
async function completeRequest({ userId, reference, otp }) {
  if (!reference) {
    throw new ValidationError('reference is required', {
      details: [{ field: 'reference', message: 'reference is required' }]
    });
  }
  if (!otp) {
    throw new ValidationError('otp is required', {
      details: [{ field: 'otp', message: 'otp is required' }]
    });
  }

  const row = await getOwnedRequest(userId, reference);

  if (row.status === 'successful') {
    return { status: 'successful', creditAmount: Number(row.credit_amount), alreadyProcessed: true };
  }
  if (row.status !== 'otp_pending') {
    throw new AirtimeCashError(`This request already ${row.status}`, { statusCode: 409 });
  }

  const result = await autosync.completeAirtimeToCash(reference, otp);

  if (result.status !== 'successful') {
    await supabaseAdmin
      .from('airtime_cash_requests')
      .update({ status: 'failed', error_message: result.message, updated_at: new Date().toISOString() })
      .eq('id', row.id);

    throw new AirtimeCashError(result.message || 'Airtime-to-cash confirmation failed', { statusCode: 402 });
  }

  const actualAmount = result.amount != null ? Number(result.amount) : Number(row.amount);
  const creditAmount = Math.round(actualAmount * (Number(row.rate_percent) / 100) * 100) / 100;

  const credit = await wallet.creditWallet({
    userId,
    amount: creditAmount,
    source: 'airtime_to_cash',
    description: `Airtime-to-cash: ${row.network} ₦${actualAmount}`,
    reference: `ATC-${reference}`
  });

  await supabaseAdmin
    .from('airtime_cash_requests')
    .update({
      status: 'successful',
      actual_amount: actualAmount,
      credit_amount: creditAmount,
      wallet_credit_reference: credit.reference,
      updated_at: new Date().toISOString()
    })
    .eq('id', row.id);

  return { status: 'successful', creditAmount, newBalance: credit.balanceAfter, alreadyProcessed: false };
}

/**
 * Resend the OTP for a still-pending request.
 */
async function resendOtp({ userId, reference }) {
  if (!reference) {
    throw new ValidationError('reference is required', {
      details: [{ field: 'reference', message: 'reference is required' }]
    });
  }

  const row = await getOwnedRequest(userId, reference);

  if (row.status !== 'otp_pending') {
    throw new AirtimeCashError(`This request already ${row.status}`, { statusCode: 409 });
  }

  const result = await autosync.resendAirtimeToCashOtp(reference);

  if (result.status === 'error') {
    throw new AirtimeCashError(result.message || 'Failed to resend OTP', { statusCode: 502 });
  }

  await supabaseAdmin
    .from('airtime_cash_requests')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', row.id);

  return { message: result.message || 'A new OTP has been sent' };
}

module.exports = {
  AirtimeCashError,
  getActivePlan,
  initiateRequest,
  completeRequest,
  resendOtp
};
