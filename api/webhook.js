'use strict';

/**
 * api/webhook.js
 * ---------------------------------------------------------------------
 * POST /api/webhook
 *
 * Receives asynchronous status notifications from AutosyncNG for
 * transactions that came back "pending" from the synchronous
 * purchase call in api/place-order.js. This is the piece that
 * resolves those pending transactions to their final success/failed
 * state — place-order.js only submits the order.
 *
 * This endpoint is called by AutosyncNG, not by your frontend, so it
 * intentionally does NOT go through auth.js's requireAuth(). Instead,
 * every request is authenticated via AutosyncNG's signature scheme:
 *
 *   hash = sha256(`${merchant_pin}:${transaction.reference}`)
 *
 * matching the verification shown in AutosyncNG's own docs example
 * (PHP: hash('sha256', sprintf('%s:%s', $pin, $data->transaction->reference))).
 * The comparison uses a timing-safe equality check rather than `===`,
 * since a naive string comparison leaks how many leading characters
 * matched via response timing.
 *
 * Body (as sent by AutosyncNG):
 *   {
 *     "hash": "...",
 *     "transaction": {
 *       "reference": "...",   // AutosyncNG's own transaction id — matches
 *                              // what we stored as transactions.provider_reference
 *       "status": "successful" | "completed" | "failed" | "pending" | ...,
 *       ...
 *     }
 *   }
 *
 * Required environment variable:
 *   AUTOSYNC_MERCHANT_PIN   (same merchant pin used in lib/autosync.js purchase calls)
 * ---------------------------------------------------------------------
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const transactions = require('../lib/transactions');
const reconcile = require('../lib/reconcile');
const absWebhook = require('../lib/absWebhook');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../lib/response');

const MERCHANT_PIN = process.env.AUTOSYNC_MERCHANT_PIN;

if (!MERCHANT_PIN) {
  throw new Error('Missing required env var: AUTOSYNC_MERCHANT_PIN');
}

// AutosyncNG's docs example uses "successful"; a wallet/QR transaction
// sample in the same docs uses "completed" for the same terminal-success
// meaning. Treat both as success so this isn't fragile to that
// inconsistency. Likewise cover the plausible terminal-failure spellings.
const SUCCESS_STATUSES = ['successful', 'completed'];
const FAILED_STATUSES = ['failed', 'declined', 'cancelled'];

/**
 * Recompute the expected signature for a given transaction reference
 * and compare it to the one AutosyncNG sent, using a constant-time
 * comparison.
 */
function isValidSignature(providedHash, reference) {
  if (!providedHash || typeof providedHash !== 'string' || !reference) {
    return false;
  }

  const expectedHash = crypto
    .createHash('sha256')
    .update(`${MERCHANT_PIN}:${reference}`)
    .digest('hex');

  const provided = Buffer.from(providedHash);
  const expected = Buffer.from(expectedHash);

  // Buffers of different lengths would make timingSafeEqual throw —
  // treat that as an invalid signature rather than an error.
  if (provided.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(provided, expected);
}

/**
 * Look up the transaction we created whose provider_reference matches
 * AutosyncNG's transaction.reference (set either by markSuccessful()
 * on an immediate success, or by place-order.js's
 * attachPendingProviderReference() when the initial call came back
 * "pending").
 */
async function findTransactionByProviderReference(reference, requestRef) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('provider_reference', reference)
    .maybeSingle();

  if (error) {
    throw new Error(`Webhook transaction lookup failed: ${error.message}`);
  }
  if (data) return data;

  // Timed-out orders keep OUR request ref as provider_reference, so
  // AutosyncNG's own reference never matches them. Fall back to the
  // request_ref AutosyncNG echoes back: exact key first, then — for
  // bundle parts, which are sent as "<key>P1", "<key>P2" — the key
  // without that suffix.
  if (requestRef) {
    const candidates = [String(requestRef)];
    const stripped = String(requestRef).replace(/P\d+$/, '');
    if (stripped !== candidates[0]) candidates.push(stripped);
    for (const c of candidates) {
      const r = await supabaseAdmin
        .from('transactions')
        .select('*')
        .eq('request_payload->>idempotencyKey', c)
        .maybeSingle();
      if (r.data) return r.data;
    }
  }
  return null;
}

/**
 * Read the raw request body (ABS signs the exact bytes, so we cannot
 * rely on a re-serialized req.body). Falls back to req.body if the
 * stream was already consumed by the platform.
 */
async function readRawBody(req) {
  if (typeof req.on === 'function' && !req.readableEnded) {
    const chunks = [];
    try {
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (_) { /* fall through to req.body */ }
    if (chunks.length > 0) return Buffer.concat(chunks).toString('utf8');
  }
  const b = req.body;
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  return b ? JSON.stringify(b) : '';
}

/** ABS Vendor delivery (identified by its X-ABS-Signature header). */
async function handleAbs(req, res, rawBody) {
  const secret = process.env.ABS_WEBHOOK_SECRET;
  if (!secret) {
    // eslint-disable-next-line no-console
    console.error('[webhook:abs] ABS_WEBHOOK_SECRET is not set — cannot verify ABS deliveries');
    return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'ABS webhook secret missing' } });
  }

  const ok = absWebhook.verifySignature({
    secret,
    timestamp: req.headers['x-abs-timestamp'],
    signature: req.headers['x-abs-signature'],
    rawBody
  });
  if (!ok) {
    // eslint-disable-next-line no-console
    console.error('[webhook:abs] Signature verification failed');
    return res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'Signature verification failed' } });
  }

  let body;
  try { body = JSON.parse(rawBody); } catch (_) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'Body is not JSON' } });
  }

  const eventName = String(req.headers['x-abs-event'] || body.event || '');
  const r = await absWebhook.handleAbsEvent(eventName, body);
  // eslint-disable-next-line no-console
  console.log(`[webhook:abs] ${eventName} order=${body.data && body.data.order_id} -> ${r.outcome}`);
  // Always 2xx once verified: ABS retries (and eventually disables the
  // endpoint) on anything else.
  return sendSuccess(res, null, { message: `ABS event processed: ${r.outcome}` });
}

async function webhookHandler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;

  const rawBody = await readRawBody(req);

  if (req.headers['x-abs-signature']) {
    return handleAbs(req, res, rawBody);
  }

  let payload = null;
  try { payload = rawBody ? JSON.parse(rawBody) : null; } catch (_) { payload = null; }

  if (!payload || !payload.transaction || !payload.transaction.reference) {
    // eslint-disable-next-line no-console
    console.error('[webhook] Malformed payload received:', JSON.stringify(payload));
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'Malformed webhook payload', details: null }
    });
  }

  const { hash, transaction } = payload;
  const reference = transaction.reference;

  if (!isValidSignature(hash, reference)) {
    // eslint-disable-next-line no-console
    console.error(`[webhook] Signature verification failed for reference ${reference}`);
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed', details: null }
    });
  }

  const txn = await findTransactionByProviderReference(reference, transaction.request_ref);

  if (!txn) {
    // No transaction of ours matches this reference. Acknowledge with
    // 200 anyway (rather than 404) so AutosyncNG doesn't retry an
    // event that will never match — but log it for investigation,
    // since it may indicate a reference we failed to record.
    // eslint-disable-next-line no-console
    console.error(`[webhook] No matching transaction found for reference ${reference}`);
    return sendSuccess(res, null, { message: 'Acknowledged (no matching transaction on file)' });
  }

  if (txn.status !== 'pending') {
    const incomingStatus = String(transaction.status || '').toLowerCase();

    // The dangerous case: we already marked this 'failed' (and
    // refunded the wallet), but the provider is now telling us it was
    // actually delivered successfully. Flag it for a human to review
    // rather than silently re-charging the customer's wallet.
    if (txn.status === 'failed' && SUCCESS_STATUSES.includes(incomingStatus)) {
      const note =
        `AutosyncNG webhook reported "${incomingStatus}" for reference ${reference}, but this transaction ` +
        `was already marked failed and ₦${txn.amount} was refunded to the customer's wallet. ` +
        `Verify the customer actually received the service before reconciling.`;

      // eslint-disable-next-line no-console
      console.error(`[webhook] MISMATCH — ${note}`);

      await transactions.flagForReconciliation({ transactionId: txn.id, note });

      return sendSuccess(res, null, { message: 'Acknowledged — flagged for manual reconciliation' });
    }

    // Already finalized in a way that doesn't conflict — either the
    // synchronous purchase call resolved it, or an earlier webhook
    // delivery for this same event already did. Acknowledge without
    // reprocessing (AutosyncNG may retry webhook delivery; this makes
    // that safe).
    return sendSuccess(res, null, { message: `Transaction already ${txn.status}` });
  }

  const status = String(transaction.status || '').toLowerCase();

  // Bundle part: the notification is about one part only, so don't
  // finalize the whole order from it — let the reconciler re-check every
  // unverified part with the provider and settle the bundle.
  if (txn.request_payload && txn.request_payload.apiProvider === 'bundle') {
    const r = await reconcile.resolveTransaction(txn);
    return sendSuccess(res, null, { message: `Bundle check: ${r.outcome}` });
  }

  if (SUCCESS_STATUSES.includes(status)) {
    await transactions.markSuccessful({
      transactionId: txn.id,
      providerReference: reference,
      responsePayload: transaction
    });
  } else if (FAILED_STATUSES.includes(status)) {
    // markFailed() automatically refunds the wallet.
    await transactions.markFailed({
      transactionId: txn.id,
      reason: `AutosyncNG webhook reported status: ${status}`,
      responsePayload: transaction
    });
  } else {
    // Still not a terminal status (e.g. another "pending" delivery) —
    // nothing to finalize yet.
    // eslint-disable-next-line no-console
    console.log(`[webhook] Non-terminal status "${status}" for reference ${reference}; no action taken`);
  }

  return sendSuccess(res, null, { message: 'Webhook processed' });
}

// No requireAuth() wrapper — AutosyncNG authenticates itself via the
// hash signature checked inside webhookHandler, not a bearer token.
module.exports = withErrorHandling(webhookHandler);
// Keep the body unparsed so ABS's HMAC can be checked against the raw bytes.
module.exports.config = { api: { bodyParser: false } };
