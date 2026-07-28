'use strict';

/**
 * api/securewave-webhook.js
 * ---------------------------------------------------------------------
 * POST /api/securewave-webhook
 *
 * Receives payment notifications from SecureWaveNG for Dynamic Virtual
 * Account funding, verifies the signature, matches the payment back to
 * a user via the dynamic_accounts row created in
 * api/fund-wallet-init.js, then credits the wallet.
 *
 * Confirmed from SecureWaveNG's docs (shared directly by the project
 * owner from their Postman collection):
 *   - Signature header: X-Signature
 *   - Formula: HMAC_SHA256(secret, raw_request_body)
 *   - Example payload (Virtual Account Webhook):
 *     {
 *       "notification_status": "payment_successful",
 *       "transaction_id": "TX123456789",
 *       "provider_reference": "PROV12345",
 *       "amount": 10000,              // Naira, not kobo — matches the
 *                                        plain-Naira amounts used when
 *                                        generating the account
 *       "transaction_status": "success",
 *       "receiver": { "name": "...", "account_number": "...", "bank": "..." },
 *       "customer": { "customer_id": 123, "name": "...", "email": "...", "phone": "..." },
 *       ...
 *     }
 *
 * Matching strategy: the webhook payload has no field that maps
 * directly to our own user id, so we match on `receiver.account_number`
 * against the dynamic_accounts row created when the account was
 * generated (which does carry our user_id). Dynamic accounts are
 * single-use and get deactivated after their one payment; static
 * accounts (see api/static-account-init.js) are permanent and stay
 * active to receive every future payment.
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
// Flat fee (in Naira) deducted from every SecureWaveNG virtual-account
// funding to cover their transaction fee, before crediting the wallet.
// Configurable via env var so it can be adjusted without a redeploy of
// application logic — just update the value in Vercel.
const FLAT_FEE = Number(process.env.SECUREWAVE_FLAT_FEE || 50);

if (!WEBHOOK_SECRET) {
  throw new Error('Missing required env var: SECUREWAVE_WEBHOOK_SECRET');
}

const SUCCESS_STATUSES = ['success', 'payment_successful', 'completed'];

function isValidSignature(rawBody, providedSignature) {
  if (!providedSignature) return false;

  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  const provided = Buffer.from(providedSignature);
  const expectedBuf = Buffer.from(expected);

  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

/**
 * Read the raw request body as a Buffer, straight from the Node.js
 * stream, before touching req.body at all. Vercel's platform also
 * auto-populates req.body for convenience, but that re-serialized
 * version does NOT reliably match the exact bytes the sender signed
 * (different key order/whitespace) — HMAC verification needs the
 * original bytes, which is why this reads the stream directly instead.
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function webhookHandler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;

  const rawBodyBuffer = await readRawBody(req);
  const rawBody = rawBodyBuffer.toString('utf8');
  const signature = req.headers['x-signature'];

  if (!isValidSignature(rawBody, signature)) {
    // eslint-disable-next-line no-console
    console.error('[securewave-webhook] Signature verification failed');
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed', details: null }
    });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (parseErr) {
    // eslint-disable-next-line no-console
    console.error('[securewave-webhook] Body was not valid JSON:', rawBody.slice(0, 300));
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'Body is not valid JSON', details: null }
    });
  }

  if (!payload || !payload.transaction_id) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'Malformed webhook payload', details: null }
    });
  }

  const status = String(payload.transaction_status || payload.notification_status || '').toLowerCase();
  if (!SUCCESS_STATUSES.includes(status)) {
    // Not a success event — acknowledge without crediting anything.
    return sendSuccess(res, null, { message: `Acknowledged (status: ${status})` });
  }

  const accountNumber = payload.receiver && payload.receiver.account_number;
  if (!accountNumber) {
    // eslint-disable-next-line no-console
    console.error('[securewave-webhook] No receiver.account_number on payload:', JSON.stringify(payload));
    return sendSuccess(res, null, { message: 'Acknowledged (no account number to match)' });
  }

  const { data: dynAccount, error: daErr } = await supabaseAdmin
    .from('dynamic_accounts')
    .select('id, user_id, provider_ref, account_type')
    .eq('provider', 'securewaveng')
    .eq('account_number', accountNumber)
    .eq('is_active', true)
    .maybeSingle();

  if (daErr || !dynAccount) {
    // eslint-disable-next-line no-console
    console.error(`[securewave-webhook] No matching active dynamic account for ${accountNumber}`);
    return sendSuccess(res, null, { message: 'Acknowledged (no matching account on file)' });
  }

  const grossAmount = Number(payload.amount); // Naira, not kobo (see file header)
  const netAmount = Math.max(0, grossAmount - FLAT_FEE);

  // Use THIS payment's own transaction_id as the idempotency reference,
  // not the account's fixed provider_ref — a static account is reused
  // across many payments, so each one needs its own reference. (A
  // one-time dynamic account only ever gets a single payment, so this
  // is equally correct there too.)
  const paymentRef = `SECUREWAVE-${payload.transaction_id}`;

  const txn = await transactions.createPendingTransaction({
    userId: dynAccount.user_id,
    type: 'wallet_funding',
    amount: netAmount,
    idempotencyKey: paymentRef,
    requestPayload: {
      provider: 'securewaveng',
      transaction_id: payload.transaction_id,
      account_number: accountNumber,
      gross_amount: grossAmount,
      fee_deducted: FLAT_FEE
    }
  });

  if (txn.status === 'pending') {
    await wallet.creditWallet({
      userId: dynAccount.user_id,
      amount: netAmount,
      source: 'bank_transfer',
      description: `Wallet funding via SecureWaveNG (₦${grossAmount} received, ₦${FLAT_FEE} fee deducted) — ref ${payload.transaction_id}`,
      reference: paymentRef
    });

    await transactions.markSuccessful({
      transactionId: txn.id,
      providerReference: payload.provider_reference || payload.transaction_id,
      responsePayload: payload
    });
  }

  // Dynamic accounts are single-use — deactivate so a later, unrelated
  // payment notification can never match this account_number again.
  // Static accounts are permanent and reused for every future payment,
  // so they are left active.
  if (dynAccount.account_type !== 'static') {
    await supabaseAdmin.from('dynamic_accounts').update({ is_active: false }).eq('id', dynAccount.id);
  }

  return sendSuccess(res, null, { message: 'Webhook processed' });
}

module.exports = withErrorHandling(webhookHandler);
