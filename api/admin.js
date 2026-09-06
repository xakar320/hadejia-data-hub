'use strict';

/**
 * api/admin.js
 * ---------------------------------------------------------------------
 * Consolidated admin endpoint — merges what used to be 5 separate
 * files under api/admin/ into one.
 *
 * WHY: Vercel's Hobby plan caps a deployment at 12 Serverless
 * Functions. This project was already at exactly 12 before
 * api/register.js was added, which pushed it to 13 and failed the
 * build. None of the underlying logic changed below — every handler
 * function body is copied verbatim from its original file. This is
 * purely a file-count fix, not a behavior change.
 *
 * Dispatch (via ?action= query param, for both GET and POST):
 *   GET  /api/admin?action=provider-catalog&types=...
 *   POST /api/admin?action=wallet-adjust              body: { userId, action: "credit"|"debit", amount, reason }
 *   POST /api/admin?action=refund-transaction          body: { transactionId, reason }
 *   POST /api/admin?action=reconcile-transaction       body: { transactionId }
 *   POST /api/admin?action=check-transaction-status    body: { transactionId }
 *
 * NOTE: the wallet-adjust body ALSO has a field called "action"
 * ("credit"/"debit") — that's a different, pre-existing field inside
 * the request body, unrelated to the ?action= query param used here
 * for routing. Both happen to be named "action" but serve different
 * purposes; this is intentional and matches the original code, not a
 * bug introduced by merging.
 *
 * Merged from (now removed — see migration notes for this deploy):
 *   api/admin/wallet-adjust.js
 *   api/admin/refund-transaction.js
 *   api/admin/reconcile-transaction.js
 *   api/admin/check-transaction-status.js
 *   api/admin/provider-catalog.js
 *
 * admin.html was updated to call "/api/admin?action=<name>" instead
 * of the old per-endpoint paths — no other frontend logic changed.
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../lib/auth');
const { withErrorHandling, sendSuccess, sendNotFound } = require('../lib/response');
const { validateRequiredFields, validateUUID, validateAmount, validatePhone, ValidationError } = require('../lib/validation');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const transactions = require('../lib/transactions');
const autosync = require('../lib/autosync');
const wallet = require('../lib/wallet');
const axios = require('axios');

// ---------------------------------------------------------------------
// Manual OPay funding — approve/reject a customer's submitted receipt.
//
// SAFETY: a request can only be approved once. Two layers guard this:
//   1. We only proceed if the row's current status is still 'pending'
//      (checked via .eq('status','pending') on the UPDATE itself, so
//      two concurrent approve clicks can't both pass the check —
//      only one UPDATE will actually match a row and return data).
//   2. Even if that somehow raced, wallet.creditWallet() is called
//      with a reference derived from the request id
//      (MANUALFUND-<id>), and the wallet_credit RPC is idempotent on
//      reference — a second credit attempt with the same reference
//      is a no-op, not a double credit.
// ---------------------------------------------------------------------
async function approveManualFunding(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['requestId', 'amount']);
  const requestId = validateUUID(body.requestId, 'requestId');
  const amount = validateAmount(body.amount, 'amount', { min: 1, max: 10000000 });

  // Atomically claim the row: only succeeds if it was still 'pending'.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('manual_funding_requests')
    .update({ status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (claimErr) throw new Error(`Failed to update request: ${claimErr.message}`);
  if (!claimed) {
    throw new ValidationError('This request is no longer pending (already approved/rejected, or does not exist).', {
      details: [{ field: 'requestId', message: 'not pending' }]
    });
  }

  const reference = `MANUALFUND-${claimed.id}`;

  try {
    const result = await wallet.creditWallet({
      userId: claimed.user_id,
      amount,
      source: 'bank_transfer',
      description: `Manual OPay transfer approved by admin (request ${claimed.id})`,
      reference
    });

    await supabaseAdmin
      .from('manual_funding_requests')
      .update({ wallet_history_id: result.walletHistoryId })
      .eq('id', claimed.id);

    return sendSuccess(res, {
      requestId: claimed.id,
      userId: claimed.user_id,
      amount,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter
    }, { message: 'Manual funding approved and wallet credited' });
  } catch (err) {
    // Wallet credit failed after we'd already marked the row
    // 'approved' — roll the status back to 'pending' so it isn't
    // silently lost and an admin can retry.
    await supabaseAdmin
      .from('manual_funding_requests')
      .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
      .eq('id', claimed.id);
    throw err;
  }
}

async function rejectManualFunding(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['requestId']);
  const requestId = validateUUID(body.requestId, 'requestId');
  const adminNote = (body.reason || '').toString().trim().slice(0, 500);

  const { data: claimed, error } = await supabaseAdmin
    .from('manual_funding_requests')
    .update({ status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), admin_note: adminNote || null })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update request: ${error.message}`);
  if (!claimed) {
    throw new ValidationError('This request is no longer pending (already approved/rejected, or does not exist).', {
      details: [{ field: 'requestId', message: 'not pending' }]
    });
  }

  return sendSuccess(res, { requestId: claimed.id }, { message: 'Manual funding request rejected' });
}

// ---------------------------------------------------------------------
// Reseller applications — approve/reject, and a direct toggle for
// admin-initiated grants/revocations without requiring an application.
// ---------------------------------------------------------------------
async function approveReseller(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['applicationId']);
  const applicationId = validateUUID(body.applicationId, 'applicationId');

  const { data: application, error } = await supabaseAdmin
    .from('reseller_applications')
    .update({ status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
    .eq('id', applicationId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update application: ${error.message}`);
  if (!application) {
    throw new ValidationError('This application is no longer pending (already reviewed, or does not exist).', {
      details: [{ field: 'applicationId', message: 'not pending' }]
    });
  }

  const { error: userErr } = await supabaseAdmin.from('users').update({ is_reseller: true }).eq('id', application.user_id);
  if (userErr) throw new Error(`Failed to grant reseller status: ${userErr.message}`);

  return sendSuccess(res, { applicationId: application.id, userId: application.user_id }, { message: 'Reseller application approved' });
}

async function rejectReseller(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['applicationId']);
  const applicationId = validateUUID(body.applicationId, 'applicationId');
  const adminNote = (body.reason || '').toString().trim().slice(0, 500);

  const { data: application, error } = await supabaseAdmin
    .from('reseller_applications')
    .update({ status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), admin_note: adminNote || null })
    .eq('id', applicationId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update application: ${error.message}`);
  if (!application) {
    throw new ValidationError('This application is no longer pending (already reviewed, or does not exist).', {
      details: [{ field: 'applicationId', message: 'not pending' }]
    });
  }

  return sendSuccess(res, { applicationId: application.id }, { message: 'Reseller application rejected' });
}

// Direct toggle — lets an admin grant or revoke reseller status on any
// user without needing an application (e.g. to revoke a reseller who
// is misbehaving, or to grant status to someone who asked in person).
async function setResellerStatus(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['userId', 'isReseller']);
  const userId = validateUUID(body.userId, 'userId');

  const { error } = await supabaseAdmin.from('users').update({ is_reseller: !!body.isReseller }).eq('id', userId);
  if (error) throw new Error(`Failed to update reseller status: ${error.message}`);

  return sendSuccess(res, { userId, isReseller: !!body.isReseller }, { message: 'Reseller status updated' });
}

// ---------------------------------------------------------------------
// Merged from api/admin/wallet-adjust.js — unchanged
// ---------------------------------------------------------------------
async function walletAdjust(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['userId', 'action', 'amount']);
  const userId = validateUUID(body.userId, 'userId');
  const amount = validateAmount(body.amount, 'amount', { min: 1, max: 1000000 });

  if (body.action !== 'credit' && body.action !== 'debit') {
    throw new ValidationError('Invalid action', {
      details: [{ field: 'action', message: 'action must be "credit" or "debit"' }]
    });
  }

  const reason = (body.reason || '').toString().trim().slice(0, 255);
  const description = `Admin ${body.action} by ${req.user.id}${reason ? `: ${reason}` : ''}`;

  const result =
    body.action === 'credit'
      ? await wallet.creditWallet({ userId, amount, source: 'admin_credit', description })
      : await wallet.debitWallet({ userId, amount, source: 'admin_debit', description });

  return sendSuccess(res, {
    userId,
    action: body.action,
    amount,
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
    reference: result.reference
  }, { message: `Wallet ${body.action}ed successfully` });
}

// ---------------------------------------------------------------------
// Merged from api/admin/refund-transaction.js — unchanged
// ---------------------------------------------------------------------
async function refundTransaction(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['transactionId']);
  const transactionId = validateUUID(body.transactionId, 'transactionId');
  const reason = (body.reason || '').toString().trim().slice(0, 255);

  const txn = await transactions.refundTransaction({
    transactionId,
    reason: `${reason || 'Admin-initiated reversal'} (by ${req.user.id})`
  });

  return sendSuccess(res, {
    id: txn.id,
    status: txn.status,
    amount: Number(txn.amount)
  }, { message: 'Transaction reversed and wallet refunded' });
}

// ---------------------------------------------------------------------
// Merged from api/admin/reconcile-transaction.js — unchanged
// ---------------------------------------------------------------------
async function reconcileTransaction(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['transactionId']);
  const transactionId = validateUUID(body.transactionId, 'transactionId');

  const txn = await transactions.reconcileFailedToSuccess({ transactionId });

  return sendSuccess(
    res,
    { id: txn.id, status: txn.status, amount: Number(txn.amount) },
    { message: 'Transaction reconciled — wallet re-debited and marked successful' }
  );
}

// ---------------------------------------------------------------------
// Mark a stuck 'pending' transaction as 'failed' and refund the
// customer — e.g. when a provider (AutosyncNG/SuperCheapData)
// definitively rejected the purchase (like "Invalid product code")
// but our own transaction never got flipped out of 'pending'.
// transactions.markFailed() already does exactly this (refund
// included), it just had no admin-facing action calling it before.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Confirm a stuck 'pending' transaction actually WAS delivered (e.g.
// admin personally verified the customer received their data/airtime,
// even though the provider's dashboard shows something confusing
// like "Invalid product code" against an older/unrelated log line).
// No wallet movement here — the debit already happened when the
// transaction was created; this only fixes the status so it stops
// showing as stuck. Use failTransaction instead if it was NOT
// actually delivered.
// ---------------------------------------------------------------------
async function confirmTransactionDelivered(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['transactionId']);
  const transactionId = validateUUID(body.transactionId, 'transactionId');

  const txn = await transactions.markSuccessful({
    transactionId,
    responsePayload: { manuallyConfirmedBy: req.user.id, note: 'Admin confirmed delivery despite pending/ambiguous provider status' }
  });

  return sendSuccess(
    res,
    { id: txn.id, status: txn.status, amount: Number(txn.amount) },
    { message: 'Transaction marked successful — no wallet change (was already debited at purchase time)' }
  );
}

async function failTransaction(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['transactionId']);
  const transactionId = validateUUID(body.transactionId, 'transactionId');
  const reason = (body.reason || 'Manually marked failed by admin').toString().trim().slice(0, 255);

  const txn = await transactions.markFailed({
    transactionId,
    reason,
    responsePayload: { manuallyFailedBy: req.user.id }
  });

  return sendSuccess(
    res,
    { id: txn.id, status: txn.status, amount: Number(txn.amount) },
    { message: 'Transaction marked failed and wallet refunded' }
  );
}

// ---------------------------------------------------------------------
// Merged from api/admin/check-transaction-status.js — unchanged
// ---------------------------------------------------------------------
async function checkTransactionStatus(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['transactionId']);
  const transactionId = validateUUID(body.transactionId, 'transactionId');

  const txn = await transactions.getTransactionById(transactionId);

  if (!txn.provider_reference) {
    return sendSuccess(res, {
      matched: false,
      message: 'This transaction has no provider_reference on file, so it cannot be looked up with AutosyncNG.'
    });
  }

  const providerResult = await autosync.getTransactionStatus(txn.provider_reference);

  const mismatch = txn.status === 'failed' && providerResult.status === 'successful';

  if (mismatch) {
    await transactions.flagForReconciliation({
      transactionId: txn.id,
      note:
        `Manually checked with AutosyncNG: they report "successful" for reference ${txn.provider_reference}, ` +
        `but this transaction is marked failed and ₦${txn.amount} was refunded. Verify delivery before reconciling.`
    });
  }

  return sendSuccess(res, {
    ourStatus: txn.status,
    providerStatus: providerResult.status,
    providerMessage: providerResult.message,
    mismatch,
    details: providerResult.details
  });
}

// ---------------------------------------------------------------------
// Merged from api/admin/provider-catalog.js — unchanged
// ---------------------------------------------------------------------
async function providerCatalog(req, res) {
  const typesParam = req.query && req.query.types;
  const types = typesParam ? String(typesParam).split(',').map(s => s.trim()).filter(Boolean) : undefined;

  const result = await autosync.getCategories(types);

  return sendSuccess(res, result, { message: 'Fetched live catalog from AutosyncNG' });
}

// ---------------------------------------------------------------------
// Diagnostic — test a provider's raw API response directly from the
// server (no CORS issues, unlike testing from a browser tool like
// Postman/Hoppscotch). Does NOT touch our wallet/transactions/
// orderService — this is purely for inspecting exactly what a
// provider sends back, e.g. to confirm the shape of a success/failure
// response before wiring the provider into a real purchase flow.
// Admin-only.
// ---------------------------------------------------------------------
async function testProvider(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['provider']);

  if (body.provider === 'supercheapdata-airtime') {
    return testSuperCheapDataAirtime(req, res, body);
  }
  if (body.provider === 'supercheapdata-data') {
    return testSuperCheapDataData(req, res, body);
  }

  throw new ValidationError('Unknown provider test', {
    details: [{ field: 'provider', message: 'provider must be one of: supercheapdata-airtime, supercheapdata-data' }]
  });
}

async function testSuperCheapDataAirtime(req, res, body) {
  const apiKey = process.env.SUPERCHEAPDATA_API_KEY;
  if (!apiKey) {
    const err = new Error('SUPERCHEAPDATA_API_KEY is not set in Vercel environment variables yet.');
    err.code = 'MISSING_ENV_VAR';
    throw err;
  }

  validateRequiredFields(body, ['network_id', 'amount', 'phone_number']);
  const networkId = Number(body.network_id);
  if (![1, 2, 3, 4].includes(networkId)) {
    throw new ValidationError('Invalid network_id', {
      details: [{ field: 'network_id', message: 'network_id must be 1 (MTN), 2 (GLO), 3 (AIRTEL), or 4 (9MOBILE)' }]
    });
  }
  const amount = validateAmount(body.amount, 'amount', { min: 1, max: 1000000 });
  const phone = validatePhone(body.phone_number, 'phone_number');
  const transactionId = (body.transaction_id || `DIAG${Date.now()}`).toString().slice(0, 64);

  const payload = {
    network_id: networkId,
    amount,
    phone_number: phone,
    transaction_id: transactionId
  };

  try {
    const response = await axios.post('https://supercheapdata.com/api/airtime', payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      timeout: 20000,
      validateStatus: () => true // we want to see the raw response even on 4xx/5xx
    });

    return sendSuccess(res, {
      requestSent: payload,
      httpStatus: response.status,
      responseBody: response.data
    }, { message: 'SuperCheapData raw response (diagnostic — no wallet/transaction was touched)' });
  } catch (err) {
    console.error('[testProvider] SuperCheapData request failed:', err.message);
    const wrapped = new Error(
      err.code === 'ECONNABORTED'
        ? 'Request to SuperCheapData timed out.'
        : `Could not reach SuperCheapData: ${err.message}`
    );
    wrapped.code = 'PROVIDER_UNREACHABLE';
    throw wrapped;
  }
}

// ---------------------------------------------------------------------
// Data Transfer — mirrors testSuperCheapDataAirtime above, hitting
// /api/data instead. network_type is a free-text field (e.g.
// "mtn_dt") and plan_id is also free-text, since SuperCheapData's
// exact plan_id values live on their per-network "Details" price
// pages, not in a table we have locally yet — paste in whatever
// you're testing.
// ---------------------------------------------------------------------
async function testSuperCheapDataData(req, res, body) {
  const apiKey = process.env.SUPERCHEAPDATA_API_KEY;
  if (!apiKey) {
    const err = new Error('SUPERCHEAPDATA_API_KEY is not set in Vercel environment variables yet.');
    err.code = 'MISSING_ENV_VAR';
    throw err;
  }

  validateRequiredFields(body, ['network_type', 'plan_id', 'phone_number']);
  const networkType = String(body.network_type).trim();
  const planId = String(body.plan_id).trim();
  const phone = validatePhone(body.phone_number, 'phone_number');
  const transactionId = (body.transaction_id || `DIAG${Date.now()}`).toString().slice(0, 64);

  const payload = {
    network_type: networkType,
    plan_id: planId,
    phone_number: phone,
    transaction_id: transactionId
  };

  try {
    const response = await axios.post('https://supercheapdata.com/api/data', payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      timeout: 20000,
      validateStatus: () => true
    });

    return sendSuccess(res, {
      requestSent: payload,
      httpStatus: response.status,
      responseBody: response.data
    }, { message: 'SuperCheapData raw response (diagnostic — no wallet/transaction was touched)' });
  } catch (err) {
    console.error('[testProvider] SuperCheapData data request failed:', err.message);
    const wrapped = new Error(
      err.code === 'ECONNABORTED'
        ? 'Request to SuperCheapData timed out.'
        : `Could not reach SuperCheapData: ${err.message}`
    );
    wrapped.code = 'PROVIDER_UNREACHABLE';
    throw wrapped;
  }
}

// ---------------------------------------------------------------------
// DISPATCH
// ---------------------------------------------------------------------

const POST_ACTIONS = {
  'wallet-adjust': walletAdjust,
  'refund-transaction': refundTransaction,
  'reconcile-transaction': reconcileTransaction,
  'check-transaction-status': checkTransactionStatus,
  'test-provider': testProvider,
  'approve-manual-funding': approveManualFunding,
  'reject-manual-funding': rejectManualFunding,
  'fail-transaction': failTransaction,
  'confirm-transaction-delivered': confirmTransactionDelivered,
  'approve-reseller': approveReseller,
  'reject-reseller': rejectReseller,
  'set-reseller-status': setResellerStatus
};

async function adminRouter(req, res) {
  const action = req.query && req.query.action;

  if (req.method === 'GET') {
    if (action === 'provider-catalog') {
      return requireAdmin(providerCatalog)(req, res);
    }
    return sendNotFound(res, `Unknown GET action: ${action || '(none)'}`);
  }

  if (req.method === 'POST') {
    const fn = POST_ACTIONS[action];
    if (!fn) {
      return sendNotFound(res, `Unknown action: ${action || '(none)'}`);
    }
    return requireAdmin(fn)(req, res);
  }

  res.setHeader('Allow', 'GET, POST');
  res.status(405).json({
    success: false,
    error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed on this endpoint. Allowed: GET, POST`, details: null },
    timestamp: new Date().toISOString()
  });
}

module.exports = withErrorHandling(adminRouter);
