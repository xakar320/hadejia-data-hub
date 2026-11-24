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
const scheduled = require('../lib/scheduledOrders');
const wrongNumber = require('../lib/wrongNumber');
const debtsLib = require('../lib/debts');
const identity = require('../lib/identityService');
const cryptoSvc = require('../lib/cryptoService');

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

// POST /api/place-order?action=schedule | list-scheduled | cancel-scheduled
// (kept here: Vercel Hobby allows only 12 functions)
async function scheduleAction(req, res) {
  const body = req.body || {};
  const action = req.query.action;
  if (action === 'schedule') {
    return sendSuccess(res, await scheduled.create(req.user.id, body), { message: 'Order scheduled' });
  }
  // Debts book: every user has his own (scoped to req.user.id inside lib/debts).
  if (action === 'debt-check') return sendSuccess(res, await debtsLib.check(req.user.id, body.phone));
  if (action === 'debt-add') return sendSuccess(res, await debtsLib.add(req.user.id, body), { message: 'Saved' });
  if (action === 'debt-list') return sendSuccess(res, await debtsLib.list(req.user.id, body));
  if (action === 'debt-pay') return sendSuccess(res, await debtsLib.pay(req.user.id, String(body.id || ''), body.amount), { message: 'Payment recorded' });
  if (action === 'debt-delete') return sendSuccess(res, await debtsLib.remove(req.user.id, String(body.id || '')), { message: 'Deleted' });
  if (action === 'mark-wrong-number') {
    return sendSuccess(res, await wrongNumber.mark(req.user.id, body), { message: 'Saved' });
  }
  if (action === 'cancel-scheduled') {
    return sendSuccess(res, await scheduled.cancel(req.user.id, String(body.id || '')), { message: 'Cancelled' });
  }
  if (action === 'delete-scheduled') {
    return sendSuccess(res, await scheduled.remove(req.user.id, String(body.id || '')), { message: 'Deleted' });
  }
  return sendSuccess(res, await scheduled.list(req.user.id));
}

// POST /api/place-order?action=id-services | id-verify | id-history | id-get | id-doc
// Identity Verification (kept here: Vercel Hobby allows only 12 functions).
// Everything is scoped to req.user — a customer can only touch his own records.
const ID_ACTIONS = ['id-services', 'id-verify', 'id-history', 'id-get', 'id-doc'];

async function identityAction(req, res) {
  const body = req.body || {};
  const action = req.query.action;
  if (action === 'id-verify') {
    const r = await identity.verify(req.user, body);
    return sendSuccess(res, r.record, { message: r.message, statusCode: r.record.status === 'pending' ? 202 : 200 });
  }
  if (action === 'id-history') return sendSuccess(res, await identity.history(req.user.id, body));
  if (action === 'id-get') return sendSuccess(res, await identity.get(req.user, body.id));
  if (action === 'id-doc') return sendSuccess(res, await identity.docUrl(req.user, body.id, String(body.kind || '')));
  return sendSuccess(res, await identity.listServices());
}

// POST /api/place-order?action=crypto-*  (Crypto Trading — all scoped to req.user)
const CRYPTO_ACTIONS = ['crypto-overview', 'crypto-demo-fund', 'crypto-bot', 'crypto-currency', 'crypto-mode', 'crypto-consent', 'crypto-keys-save', 'crypto-keys-delete', 'crypto-history', 'crypto-scan'];
async function cryptoAction(req, res) {
  const b = req.body || {}; const uid = req.user.id; const a = req.query.action;
  if (a === 'crypto-demo-fund') return sendSuccess(res, await cryptoSvc.demoFund(uid, b), { message: 'Done' });
  if (a === 'crypto-bot') return sendSuccess(res, await cryptoSvc.botControl(uid, b));
  if (a === 'crypto-currency') return sendSuccess(res, await cryptoSvc.setCurrency(uid, b.currency));
  if (a === 'crypto-mode') return sendSuccess(res, await cryptoSvc.setMode(uid, b.mode));
  if (a === 'crypto-consent') return sendSuccess(res, await cryptoSvc.consent(uid));
  if (a === 'crypto-keys-save') return sendSuccess(res, await cryptoSvc.saveKeys(uid, b), { message: 'Key verified and saved' });
  if (a === 'crypto-keys-delete') return sendSuccess(res, await cryptoSvc.deleteKeys(uid));
  if (a === 'crypto-history') return sendSuccess(res, await cryptoSvc.history(uid));
  if (a === 'crypto-scan') return sendSuccess(res, await cryptoSvc.scanView());
  return sendSuccess(res, await cryptoSvc.overview(uid));
}

// POST|GET /api/place-order?action=crypto-cron  — called every minute by cron-job.org.
// NOT a customer call: protected by  Authorization: Bearer <CRON_SECRET>.
async function cryptoCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: { message: 'CRON_SECRET is not set' } });
  const got = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const want = 'Bearer ' + secret;
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
  const stats = await require('../lib/cryptoEngine').runCycle();
  return sendSuccess(res, stats);
}

module.exports = withErrorHandling(async function handler(req, res) {
  const isCron = !!(req.query && req.query.action === 'crypto-cron');
  if (methodNotAllowed(req, res, isCron ? ['POST', 'GET'] : ['POST'])) return;
  if (isCron) return cryptoCron(req, res);
  if (req.query && req.query.action === 'check-pending') {
    return requireAuth(checkPending)(req, res);
  }
  if (req.query && CRYPTO_ACTIONS.includes(req.query.action)) {
    return requireAuth(cryptoAction)(req, res);
  }
  if (req.query && ID_ACTIONS.includes(req.query.action)) {
    return requireAuth(identityAction)(req, res);
  }
  if (req.query && ['schedule', 'list-scheduled', 'cancel-scheduled', 'delete-scheduled', 'mark-wrong-number', 'debt-check', 'debt-add', 'debt-list', 'debt-pay', 'debt-delete'].includes(req.query.action)) {
    return requireAuth(scheduleAction)(req, res);
  }
  return requireAuth(placeOrder)(req, res);
});
