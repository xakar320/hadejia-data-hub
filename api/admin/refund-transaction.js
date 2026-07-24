'use strict';

/**
 * api/admin/refund-transaction.js
 * ---------------------------------------------------------------------
 * POST /api/admin/refund-transaction
 * Admin-only. Reverses an already-successful transaction (e.g. the
 * customer never received the data/airtime despite AutosyncNG
 * reporting success) and refunds the wallet. Thin wrapper around
 * transactions.refundTransaction() — see that function for the
 * guard that only allows reversing a 'success' transaction.
 *
 * Body:
 *   {
 *     "transactionId": "<uuid>",
 *     "reason": "Customer confirmed data was not delivered"
 *   }
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../../lib/response');
const { validateRequiredFields, validateUUID } = require('../../lib/validation');
const transactions = require('../../lib/transactions');

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

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAdmin(refundTransaction)(req, res);
});
