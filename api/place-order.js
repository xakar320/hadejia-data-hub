'use strict';

/**
 * api/place-order.js
 * ---------------------------------------------------------------------
 * POST /api/place-order
 *
 * Thin HTTP wrapper around lib/orderService.js's executeOrder() — all
 * the actual purchase logic (pricing lookup, PIN check, wallet debit,
 * AutosyncNG call, success/pending/failed handling) lives there now,
 * shared with the WhatsApp bot (api/whatsapp-webhook.js) so both
 * surfaces run through identical logic.
 *
 * Request body:
 *   {
 *     "type": "data" | "voice" | "airtime" | "cable" | "electricity",
 *     "pin": "1234",
 *     "request_ref": "..."   // optional idempotency key
 *     ... type-specific fields — see lib/orderService.js's resolve*Order() functions
 *   }
 * ---------------------------------------------------------------------
 */

const { requireAuth } = require('../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../lib/response');
const { validateRequiredFields } = require('../lib/validation');
const orderService = require('../lib/orderService');
const reconcile = require('../lib/reconcile');

async function placeOrder(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['type']);

  const { type, pin, request_ref: requestRef, ...orderFields } = body;

  const result = await orderService.executeOrder({
    userId: req.user.id,
    type: String(type).toLowerCase(),
    pin,
    requestRef,
    ...orderFields
  });

  if (result.alreadyProcessed) {
    return sendSuccess(res, result.transaction, { message: `Transaction already ${result.transaction.status}` });
  }
  if (result.pending) {
    return sendSuccess(res, result.transaction, { statusCode: 202, message: 'Purchase is being processed by the provider' });
  }
  if (result.partial) {
    return sendSuccess(res, result.transaction, {
      message: `Part of your order was delivered. N${result.partial.refundAmount} was refunded to your wallet for: ${result.partial.failedParts.join(', ')}`
    });
  }
  return sendSuccess(res, result.transaction, { message: 'Purchase successful' });
}

// POST /api/place-order?action=check-pending
// Called by the Transactions page while the customer has an order that
// is still 'pending'. Asks the provider about THIS user's pending
// orders only (older than ~75s) and resolves the ones it can.
// (Kept inside this file: Vercel Hobby allows only 12 functions.)
const lastCheck = new Map(); // userId -> timestamp (best-effort throttle per instance)

async function checkPending(req, res) {
  const now = Date.now();
  const prev = lastCheck.get(req.user.id) || 0;
  if (now - prev < 20 * 1000) {
    return sendSuccess(res, { throttled: true });
  }
  lastCheck.set(req.user.id, now);
  if (lastCheck.size > 500) lastCheck.clear();

  const stats = await reconcile.reconcilePending({ userId: req.user.id, limit: 8 });
  return sendSuccess(res, stats);
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  if (req.query && req.query.action === 'check-pending') {
    return requireAuth(checkPending)(req, res);
  }
  return requireAuth(placeOrder)(req, res);
});
