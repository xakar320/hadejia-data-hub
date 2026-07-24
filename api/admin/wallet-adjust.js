'use strict';

/**
 * api/admin/wallet-adjust.js
 * ---------------------------------------------------------------------
 * POST /api/admin/wallet-adjust
 * Admin-only. Manually credits or debits a user's wallet (e.g.
 * goodwill credit, correcting a support issue) and writes a proper
 * wallet_history ledger entry — this is the ONLY correct way to
 * change a user's wallet_balance. Editing users.wallet_balance
 * directly from admin.html would skip the ledger entirely, which is
 * why the Wallet Manager UI calls this endpoint instead of writing to
 * the users table itself.
 *
 * Body:
 *   {
 *     "userId": "<uuid>",
 *     "action": "credit" | "debit",
 *     "amount": 1000,
 *     "reason": "Goodwill credit for delayed data delivery"
 *   }
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../../lib/response');
const { validateRequiredFields, validateUUID, validateAmount, ValidationError } = require('../../lib/validation');
const wallet = require('../../lib/wallet');

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

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAdmin(walletAdjust)(req, res);
});
