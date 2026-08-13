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
 * admin.html / admin2.html were updated to call
 * "/api/admin?action=<name>" instead of the old per-endpoint paths —
 * no other frontend logic changed.
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../lib/auth');
const { withErrorHandling, sendSuccess, sendNotFound } = require('../lib/response');
const { validateRequiredFields, validateUUID, validateAmount, ValidationError } = require('../lib/validation');
const transactions = require('../lib/transactions');
const autosync = require('../lib/autosync');
const wallet = require('../lib/wallet');

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
// DISPATCH
// ---------------------------------------------------------------------

const POST_ACTIONS = {
  'wallet-adjust': walletAdjust,
  'refund-transaction': refundTransaction,
  'reconcile-transaction': reconcileTransaction,
  'check-transaction-status': checkTransactionStatus
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
