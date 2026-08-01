'use strict';

/**
 * api/admin/check-transaction-status.js
 * ---------------------------------------------------------------------
 * POST /api/admin/check-transaction-status
 * Admin-only. Queries AutosyncNG directly (GET /transaction/{reference})
 * for the real, current status of a transaction — useful when our
 * synchronous response said "failed" but the customer says they
 * received the service. Read-only: never changes anything by itself.
 * If a mismatch is found (we have it as 'failed', provider says
 * successful), the transaction is flagged via reconciliation_note so
 * it's visible next time this transaction is viewed — actually
 * crediting the wallet still requires the separate, explicit
 * /api/admin/reconcile-transaction call.
 *
 * Body: { transactionId }
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../../lib/response');
const { validateRequiredFields, validateUUID } = require('../../lib/validation');
const transactions = require('../../lib/transactions');
const autosync = require('../../lib/autosync');

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

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAdmin(checkTransactionStatus)(req, res);
});
