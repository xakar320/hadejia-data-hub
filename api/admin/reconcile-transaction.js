'use strict';

/**
 * api/admin/reconcile-transaction.js
 * ---------------------------------------------------------------------
 * POST /api/admin/reconcile-transaction
 * Admin-only. For a transaction we marked 'failed' (and therefore
 * already refunded) that actually succeeded with the provider — this
 * re-debits the customer's wallet for the same amount and flips the
 * transaction to 'success'. This is a deliberate, explicit admin
 * action; nothing in this codebase calls this automatically, since
 * re-charging a customer without a human confirming delivery first is
 * too risky to do silently.
 *
 * Body: { transactionId }
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../../lib/response');
const { validateRequiredFields, validateUUID } = require('../../lib/validation');
const transactions = require('../../lib/transactions');

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

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAdmin(reconcileTransaction)(req, res);
});
