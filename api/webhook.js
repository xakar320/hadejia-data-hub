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
async function findTransactionByProviderReference(reference) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('provider_reference', reference)
    .maybeSingle();

  if (error) {
    throw new Error(`Webhook transaction lookup failed: ${error.message}`);
  }

  return data;
}

async function webhookHandler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;

  const payload = req.body;

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

  const txn = await findTransactionByProviderReference(reference);

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
