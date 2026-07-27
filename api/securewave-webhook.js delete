'use strict';

/**
 * api/securewave-webhook.js
 * ---------------------------------------------------------------------
 * POST /api/securewave-webhook
 *
 * Receives payment notifications from SecureWaveNG (Dynamic Virtual
 * Account funding). Verifies the HMAC-SHA256 signature, then credits
 * the matching user's wallet.
 *
 * Confirmed from SecureWaveNG's docs (documenter.getpostman.com,
 * "SecureWaveNG API Documentation"):
 *   - Signature header: X-Signature
 *   - Formula: HMAC_SHA256(secret, raw_request_body)
 *   - Example payload (Virtual Account Webhook):
 *     {
 *       "notification_status": "payment_successful",
 *       "transaction_id": "TX123456789",
 *       "provider_reference": "PROV12345",
 *       "amount": 10000,
 *       "fees": 100,
 *       "settlement_amount": 9900,
 *       "currency": "NGN",
 *       "transaction_type": "transfer",
 *       "transaction_status": "success",
 *       "customer": { "customer_id": 123, "email": "...", "phone": "..." },
 *       ...
 *     }
 *
 * ASSUMPTION (needs confirmation against your actual "generate virtual
 * account" request/response, not yet available to me): when a virtual
 * account is created for a user, we must be able to look that user back
 * up when this webhook fires. This implementation assumes the account
 * is created with `customer_id` set to our own user's UUID (public.users.id)
 * so the webhook's `customer.customer_id` maps directly back — if
 * SecureWaveNG's create-account response instead returns their own
 * internal customer id, we'll need a small mapping table instead. Flag
 * this to me once you share the create-account endpoint details.
 *
 * Required environment variable:
 *   SECUREWAVE_WEBHOOK_SECRET
 * ---------------------------------------------------------------------
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const wallet = require('../lib/wallet');
const transactions = require('../lib/transactions');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../lib/response');

const WEBHOOK_SECRET = process.env.SECUREWAVE_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  throw new Error('Missing required env var: SECUREWAVE_WEBHOOK_SECRET');
}

const SUCCESS_STATUSES = ['success', 'payment_successful', 'completed'];

function isValidSignature(rawBody, providedSignature) {
  if (!providedSignature) return false;

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const provided = Buffer.from(providedSignature);
  const expectedBuf = Buffer.from(expected);

  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

async function webhookHandler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;

  // We need the EXACT raw bytes SecureWaveNG signed, before any JSON
  // parsing, for the HMAC to verify correctly. If your Vercel setup
  // auto-parses req.body, configure this route with
  // `export const config = { api: { bodyParser: false } }` and read
  // the raw stream instead — flagging this as a deployment detail to
  // confirm once we wire this up for real.
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const signature = req.headers['x-signature'];

  if (!isValidSignature(rawBody, signature)) {
    // eslint-disable-next-line no-console
    console.error('[securewave-webhook] Signature verification failed');
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed', details: null }
    });
  }

  const payload = req.body;

  if (!payload || !payload.transaction_id) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'Malformed webhook payload', details: null }
    });
  }

  const status = String(payload.transaction_status || payload.notification_status || '').toLowerCase();
  if (!SUCCESS_STATUSES.includes(status)) {
    // Not a success event (e.g. a failed/reversed notification) —
    // acknowledge without crediting anything.
    return sendSuccess(res, null, { message: `Acknowledged (status: ${status})` });
  }

  const customerId = payload.customer && payload.customer.customer_id;
  if (!customerId) {
    // eslint-disable-next-line no-console
    console.error('[securewave-webhook] No customer_id on payload:', JSON.stringify(payload));
    return sendSuccess(res, null, { message: 'Acknowledged (no customer_id to match)' });
  }

  // ASSUMPTION: customer_id === our public.users.id (see file header).
  const { data: user, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('id', customerId)
    .maybeSingle();

  if (userErr || !user) {
    // eslint-disable-next-line no-console
    console.error(`[securewave-webhook] No matching user for customer_id ${customerId}`);
    return sendSuccess(res, null, { message: 'Acknowledged (no matching user on file)' });
  }

  const amount = Number(payload.amount) / 100; // assume kobo, like Paystack-style NGN gateways — CONFIRM with SecureWaveNG docs
  const idempotencyRef = `SECUREWAVE-${payload.transaction_id}`;

  // Record a wallet_funding transaction (createPendingTransaction skips
  // the wallet debit for this type — the actual credit happens next).
  const txn = await transactions.createPendingTransaction({
    userId: user.id,
    type: 'wallet_funding',
    amount,
    idempotencyKey: idempotencyRef,
    requestPayload: { provider: 'securewaveng', transaction_id: payload.transaction_id }
  });

  if (txn.status === 'pending') {
    await wallet.creditWallet({
      userId: user.id,
      amount,
      source: 'bank_transfer',
      description: `Wallet funding via SecureWaveNG virtual account (${payload.transaction_id})`,
      reference: idempotencyRef
    });

    await transactions.markSuccessful({
      transactionId: txn.id,
      providerReference: payload.provider_reference || payload.transaction_id,
      responsePayload: payload
    });
  }

  return sendSuccess(res, null, { message: 'Webhook processed' });
}

module.exports = withErrorHandling(webhookHandler);
