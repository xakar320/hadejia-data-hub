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
  return sendSuccess(res, result.transaction, { message: 'Purchase successful' });
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAuth(placeOrder)(req, res);
});
