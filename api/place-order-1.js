'use strict';

/**
 * api/place-order.js
 * ---------------------------------------------------------------------
 * POST /api/place-order
 *
 * Single entry point for every VTU purchase (data, airtime, cable,
 * electricity). Orchestrates the full purchase pipeline using the
 * shared modules as the source of truth for each concern:
 *
 *   1. auth.js         -> requireAuth() verifies the caller and rejects
 *                          suspended/banned/deleted accounts.
 *   2. validation.js    -> rejects malformed input before anything else runs.
 *   3. (this file)      -> resolves the authoritative price/product
 *                          details for the requested service directly
 *                          from the relevant *_plans table, so a client
 *                          can never dictate its own price.
 *   4. transactions.js  -> creates a 'pending' transaction, which
 *                          atomically debits the wallet via wallet.js
 *                          (idempotent on request_ref).
 *   5. autosync.js      -> calls AutosyncNG to fulfill the order.
 *   6. transactions.js  -> transitions pending -> success/failed;
 *                          markFailed() auto-refunds the wallet.
 *   7. response.js      -> sends one normalized JSON shape either way.
 *
 * Request body:
 *   {
 *     "type": "data" | "airtime" | "cable" | "electricity",
 *     "request_ref": "..."   // optional idempotency key; generated if omitted
 *     ... type-specific fields, see each resolve*Order() function below
 *   }
 *
 * Pricing integrity: for "data" and "cable" (change-subscription),
 * amount/cost_price/variation_code always come from the matching row
 * in data_plans/cable_plans by planId — never from the request body.
 * For "airtime" and "electricity", the client supplies the amount
 * (these are open-amount top-ups/bill payments), but it is clamped to
 * the min/max range configured in airtime_plans/electricity_plans and
 * cost_price is derived server-side from the configured discount/
 * commission rate.
 *
 * Transaction outcomes:
 *   - AutosyncNG "successful" -> transaction marked 'success', 200 response.
 *   - AutosyncNG "pending"    -> AutosyncNG hasn't finished processing;
 *                                the transaction is left 'pending' (wallet
 *                                stays debited) and a 202 response is
 *                                returned. Final status arrives via
 *                                AutosyncNG's webhook (see api/webhook.js,
 *                                which verifies AutosyncNG's signature and
 *                                calls transactions.markSuccessful()/
 *                                markFailed() to resolve it) or a later
 *                                call to autosync.getTransactionStatus().
 *   - AutosyncNG "failed"/"error" -> transaction marked 'failed', which
 *                                automatically refunds the debited amount,
 *                                and a normalized error response is sent.
 * ---------------------------------------------------------------------
 */

const { requireAuth } = require('../lib/auth');
const {
  withErrorHandling,
  sendSuccess,
  methodNotAllowed
} = require('../lib/response');
const validation = require('../lib/validation');
const wallet = require('../lib/wallet');
const transactions = require('../lib/transactions');
const autosync = require('../lib/autosync');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

const {
  ValidationError,
  validateRequiredFields,
  validateUUID,
  validatePhone,
  validateProductId,
  validateAmount,
  validateVariationCode,
  validateRequestRef
} = validation;

/**
 * Raised when AutosyncNG reports a transaction as failed. The wallet
 * has already been refunded by the time this is thrown (transactions.markFailed
 * does that). Flows through response.js's sendError with its own
 * code/statusCode, same as every other typed error in this backend.
 */
class OrderFailedError extends Error {
  constructor(message, { details = null } = {}) {
    super(message);
    this.name = 'OrderFailedError';
    this.code = 'PURCHASE_FAILED';
    this.statusCode = 402;
    this.details = details;
  }
}

// -----------------------------------------------------------------------
// Order resolvers — one per supported `type`. Each validates its own
// required fields, looks up authoritative pricing where applicable,
// and returns:
//   {
//     amount, costPrice, network, recipient, planId, requestPayload,
//     callProvider: (reference) => Promise<NormalizedAutosyncResult>
//   }
// -----------------------------------------------------------------------

async function fetchActivePlan(table, filters, notFoundMessage) {
  let query = supabaseAdmin.from(table).select('*');
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }
  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new Error(`Failed to look up ${table}: ${error.message}`);
  }
  if (!data || data.status !== 'active') {
    throw new ValidationError(notFoundMessage, {
      details: [{ field: 'planId', message: notFoundMessage }]
    });
  }
  return data;
}

/**
 * type: "data"
 * body: { planId, phone, dataType?, portedNo? }
 * product_id and variation_code are never taken from the client —
 * both come from the data_plans row (set once by admin in admin.html),
 * same integrity guarantee as electricity's provider_code.
 */
async function resolveDataOrder(body) {
  validateRequiredFields(body, ['planId', 'phone']);

  const planId = validateUUID(body.planId, 'planId');
  const phone = validatePhone(body.phone, 'phone');
  const dataType = body.dataType || 'data-sme';

  const plan = await fetchActivePlan('data_plans', { id: planId }, 'Data plan not found or inactive');
  const variationCode = validateVariationCode(plan.plan_code, 'variationCode');
  const productId = validateProductId(
    plan.product_id,
    'productId (plan is missing its AutosyncNG product_id — set it in admin.html first)'
  );

  return {
    amount: Number(plan.selling_price),
    costPrice: Number(plan.cost_price),
    network: plan.network,
    recipient: phone,
    planId,
    requestPayload: { productId, variationCode, dataType },
    callProvider: (reference) =>
      autosync.purchaseData({
        phone,
        productId,
        variationCode,
        dataType,
        portedNo: !!body.portedNo,
        reference
      })
  };
}

/**
 * type: "voice"
 * body: { planId, phone }
 *
 * ASSUMPTION: AutosyncNG's published catalog has no separate "voice
 * minutes bundle" category — the closest confirmed match is their
 * "Talk More" endpoint (POST /talk-more), which shares the same
 * request/response shape as Data SME. This resolver reuses
 * autosync.purchaseData() with dataType:'talk-more' rather than
 * inventing an unconfirmed endpoint. If AutosyncNG's actual voice
 * product lives elsewhere in their catalog, only this resolver needs
 * to change — voice.html and voice_plans are unaffected.
 */
async function resolveVoiceOrder(body) {
  validateRequiredFields(body, ['planId', 'phone']);

  const planId = validateUUID(body.planId, 'planId');
  const phone = validatePhone(body.phone, 'phone');

  const plan = await fetchActivePlan('voice_plans', { id: planId }, 'Voice plan not found or inactive');
  const variationCode = validateVariationCode(plan.plan_code, 'variationCode');
  const productId = validateProductId(
    plan.product_id,
    'productId (plan is missing its AutosyncNG product_id — set it in admin.html first)'
  );

  return {
    amount: Number(plan.selling_price),
    costPrice: Number(plan.cost_price),
    network: plan.network,
    recipient: phone,
    planId,
    requestPayload: { productId, variationCode, dataType: 'talk-more' },
    callProvider: (reference) =>
      autosync.purchaseData({
        phone,
        productId,
        variationCode,
        dataType: 'talk-more',
        reference
      })
  };
}

/**
 * type: "airtime"
 * body: { network, phone, amount, productId, isMtnAwuf? }
 */
async function resolveAirtimeOrder(body) {
  validateRequiredFields(body, ['network', 'phone', 'amount', 'productId']);

  const network = String(body.network).toUpperCase();
  const phone = validatePhone(body.phone, 'phone');
  const productId = validateProductId(body.productId, 'productId');

  const plan = await fetchActivePlan(
    'airtime_plans',
    { network },
    `Airtime is not currently available for ${network}`
  );

  const amount = validateAmount(body.amount, 'amount', {
    min: Number(plan.min_amount),
    max: Number(plan.max_amount)
  });
  const costPrice = Math.round(amount * (1 - Number(plan.discount_percentage) / 100) * 100) / 100;

  return {
    amount,
    costPrice,
    network,
    recipient: phone,
    planId: null,
    requestPayload: { productId },
    callProvider: (reference) =>
      autosync.purchaseAirtime({ phone, productId, amount, isMtnAwuf: !!body.isMtnAwuf, reference })
  };
}

/**
 * type: "cable"
 * body (change subscription): { cableType: "change", planId, iucNumber, productId, isBoxOffice? }
 * body (renew / free entry):  { cableType: "renew" (default), iucNumber, productId, amount, network?, isBoxOffice? }
 */
async function resolveCableOrder(body) {
  validateRequiredFields(body, ['iucNumber', 'productId']);

  const iucNumber = String(body.iucNumber).trim();
  const productId = validateProductId(body.productId, 'productId');
  const cableType = body.cableType === 'change' ? 'change' : 'renew';

  if (cableType === 'change') {
    validateRequiredFields(body, ['planId']);
    const planId = validateUUID(body.planId, 'planId');
    const plan = await fetchActivePlan('cable_plans', { id: planId }, 'Cable plan not found or inactive');
    const variationCode = validateVariationCode(plan.plan_code, 'variationCode');

    return {
      amount: Number(plan.selling_price),
      costPrice: Number(plan.cost_price),
      network: plan.provider,
      recipient: iucNumber,
      planId,
      requestPayload: { productId, variationCode, cableType },
      callProvider: (reference) =>
        autosync.purchaseCable({
          iucNumber,
          productId,
          amount: Number(plan.selling_price),
          variationCode,
          type: 'change',
          isBoxOffice: !!body.isBoxOffice,
          reference
        })
    };
  }

  // Renewal / free entry / box office: the amount is the customer's
  // actual outstanding balance on their decoder, so it's supplied by
  // the client rather than looked up. NOTE: without a fixed plan row
  // to source cost_price from, cost_price defaults to the same amount
  // (zero recorded margin) — apply a markup via price_manager/admin
  // settings before going live if renewals should be profitable.
  validateRequiredFields(body, ['amount']);
  const amount = validateAmount(body.amount, 'amount', { min: 100, max: 200000 });
  const network = body.network ? String(body.network).toUpperCase() : null;

  return {
    amount,
    costPrice: amount,
    network,
    recipient: iucNumber,
    planId: null,
    requestPayload: { productId, variationCode: 'none', cableType },
    callProvider: (reference) =>
      autosync.purchaseCable({
        iucNumber,
        productId,
        amount,
        variationCode: 'none',
        type: 'renew',
        isBoxOffice: !!body.isBoxOffice,
        reference
      })
  };
}

/**
 * type: "electricity"
 * body: { disco, meterType, meterNumber, amount }
 */
async function resolveElectricityOrder(body) {
  validateRequiredFields(body, ['disco', 'meterType', 'meterNumber', 'amount']);

  const disco = String(body.disco).toUpperCase();
  const meterType = body.meterType === 'postpaid' ? 'postpaid' : 'prepaid';
  const meterNumber = String(body.meterNumber).trim();

  const plan = await fetchActivePlan(
    'electricity_plans',
    { disco, meter_type: meterType },
    `Electricity payment is not currently available for ${disco} (${meterType})`
  );

  const amount = validateAmount(body.amount, 'amount', {
    min: Number(plan.min_amount),
    max: Number(plan.max_amount)
  });
  const costPrice = Math.round(amount * (1 - Number(plan.commission_rate) / 100) * 100) / 100;

  // product_id comes from the server-side plan row, never the client —
  // it identifies the disco to AutosyncNG and must match their catalog.
  const productId = plan.provider_code;

  return {
    amount,
    costPrice,
    network: disco,
    recipient: meterNumber,
    planId: null,
    requestPayload: { productId, meterType },
    callProvider: (reference) =>
      autosync.purchaseElectricity({ meterNumber, productId, meterType, amount, reference })
  };
}

const TYPE_RESOLVERS = {
  data: resolveDataOrder,
  voice: resolveVoiceOrder,
  airtime: resolveAirtimeOrder,
  cable: resolveCableOrder,
  electricity: resolveElectricityOrder
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function formatTransaction(txn, providerResult) {
  return {
    id: txn.id,
    type: txn.type,
    status: txn.status,
    amount: Number(txn.amount),
    network: txn.network,
    recipient: txn.recipient,
    providerReference: txn.provider_reference || (providerResult && providerResult.reference) || null,
    token: (providerResult && providerResult.token) || null,
    units: (providerResult && providerResult.units) || null,
    createdAt: txn.created_at,
    updatedAt: txn.updated_at
  };
}

/**
 * Record AutosyncNG's reference/response on a transaction that is
 * still pending (AutosyncNG returned "pending", not a terminal
 * state). This is a plain field update, not a status transition, so
 * it's done directly here rather than through transactions.js — the
 * `.eq('status', 'pending')` guard still ensures it can't clobber a
 * status transition that a webhook applies concurrently. Failure to
 * record this is logged but never fails the request — the purchase
 * itself already succeeded in being submitted.
 */
async function attachPendingProviderReference(transactionId, providerResult) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .update({
      provider_reference: providerResult.reference,
      response_payload: providerResult.raw
    })
    .eq('id', transactionId)
    .eq('status', 'pending');

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[place-order] Failed to record pending provider reference:', error.message);
  }
}

// -----------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------

async function placeOrder(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['type']);
  const type = String(body.type).toLowerCase();

  const resolveOrder = TYPE_RESOLVERS[type];
  if (!resolveOrder) {
    throw new ValidationError('Unsupported order type', {
      details: [
        {
          field: 'type',
          message: `type must be one of: ${Object.keys(TYPE_RESOLVERS).join(', ')}`
        }
      ]
    });
  }

  const order = await resolveOrder(body);

  const idempotencyKey = body.request_ref
    ? validateRequestRef(body.request_ref, 'request_ref')
    : wallet.generateReference(type.toUpperCase());

  // Debits the wallet atomically and creates the 'pending' row.
  // Idempotent: a retried request with the same request_ref returns
  // the original transaction instead of debiting/creating again.
  let txn = await transactions.createPendingTransaction({
    userId: req.user.id,
    type,
    planId: order.planId,
    network: order.network,
    recipient: order.recipient,
    amount: order.amount,
    costPrice: order.costPrice,
    idempotencyKey,
    requestPayload: order.requestPayload
  });

  // If this idempotency key was already fully processed by a previous
  // request, don't call the provider again — just return the outcome.
  if (txn.status !== 'pending') {
    return sendSuccess(res, formatTransaction(txn), {
      message: `Transaction already ${txn.status}`
    });
  }

  const providerResult = await order.callProvider(idempotencyKey);

  if (providerResult.status === 'successful') {
    txn = await transactions.markSuccessful({
      transactionId: txn.id,
      providerReference: providerResult.reference,
      responsePayload: providerResult.raw
    });
    return sendSuccess(res, formatTransaction(txn, providerResult), {
      message: 'Purchase successful'
    });
  }

  if (providerResult.status === 'pending') {
    await attachPendingProviderReference(txn.id, providerResult);
    return sendSuccess(res, formatTransaction(txn, providerResult), {
      statusCode: 202,
      message: 'Purchase is being processed by the provider'
    });
  }

  // 'failed' or 'error' — markFailed() refunds the wallet automatically.
  txn = await transactions.markFailed({
    transactionId: txn.id,
    reason: providerResult.message,
    responsePayload: providerResult.raw
  });

  throw new OrderFailedError(providerResult.message || 'Purchase failed', {
    details: [
      {
        field: 'transaction',
        message: `Transaction ${txn.id} failed and the amount has been refunded to your wallet`
      }
    ]
  });
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAuth(placeOrder)(req, res);
});
