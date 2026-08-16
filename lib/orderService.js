'use strict';

/**
 * lib/orderService.js
 * ---------------------------------------------------------------------
 * The core "place an order" pipeline, extracted out of api/place-order.js
 * so it has exactly ONE implementation shared by every caller — the
 * HTTP endpoint (api/place-order.js) and the WhatsApp bot
 * (api/whatsapp-webhook.js) both call executeOrder() here rather than
 * each having their own copy of this logic.
 *
 *   1. validation.js    -> rejects malformed input before anything else runs.
 *   2. auth.js verifyPin -> confirms the caller's transaction PIN.
 *   3. (this file)       -> resolves authoritative price/product details
 *                           directly from the relevant *_plans table.
 *   4. transactions.js   -> creates a 'pending' transaction, which
 *                           atomically debits the wallet via wallet.js.
 *   5. autosync.js       -> calls AutosyncNG to fulfill the order.
 *   6. transactions.js   -> transitions pending -> success/failed;
 *                           markFailed() auto-refunds the wallet.
 *
 * See api/place-order.js's original header comments for the full
 * pricing-integrity and transaction-outcome notes — they still apply
 * unchanged; this file just relocates the code.
 * ---------------------------------------------------------------------
 */

const { verifyPin } = require('./auth');
const validation = require('./validation');
const wallet = require('./wallet');
const transactions = require('./transactions');
const autosync = require('./autosync');
const supercheapdata = require('./supercheapdata');
const { supabaseAdmin } = require('./supabaseAdmin');

const {
  ValidationError,
  validateRequiredFields,
  validateUUID,
  validatePhone,
  validateProductId,
  validateAmount,
  validateVariationCode,
  validateRequestRef,
  validatePin
} = validation;

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
// Plan lookup helpers
// -----------------------------------------------------------------------

/**
 * Maps whatever free-text an admin typed into a data plan's
 * "Plan Type" field (e.g. "SME", "Gifting", "Data Transfer",
 * "Corporate", "Talk More") to the exact dataType string AutosyncNG's
 * API expects. Returns null if it can't confidently recognize it, so
 * the caller can fall back to a safe default and log a warning rather
 * than silently guessing wrong.
 */
function normalizeDataType(planType) {
  if (!planType || typeof planType !== 'string') return null;
  const v = planType.toLowerCase().replace(/[\s_-]+/g, '');

  if (v.includes('gift')) return 'data-gifting';
  if (v.includes('transfer')) return 'data-transfer';
  if (v.includes('corporate') || v.includes('corp')) return 'data-corporate';
  if (v.includes('talkmore') || v.includes('talk')) return 'talk-more';
  if (v.includes('sme')) return 'data-sme';

  return null;
}

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

async function fetchProviderProductId(table, providerColumn, providerValue, notFoundMessage) {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('product_id')
    .eq(providerColumn, providerValue)
    .eq('status', 'active')
    .not('product_id', 'is', null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up ${table}: ${error.message}`);
  }
  if (!data || !data.product_id) {
    throw new ValidationError(notFoundMessage, {
      details: [{ field: 'network', message: notFoundMessage }]
    });
  }
  return data.product_id;
}

// -----------------------------------------------------------------------
// Order resolvers — one per supported `type`.
// -----------------------------------------------------------------------

async function resolveDataOrder(body) {
  validateRequiredFields(body, ['planId', 'phone']);

  const planId = validateUUID(body.planId, 'planId');
  const phone = validatePhone(body.phone, 'phone');

  const plan = await fetchActivePlan('data_plans', { id: planId }, 'Data plan not found or inactive');
  const apiProvider = plan.api_provider || 'autosyncng';

  // BUGFIX: dataType used to be hardcoded to 'data-sme' for every
  // single data purchase, regardless of what category the plan
  // actually belongs to. A plan whose variation_code only exists
  // under AutosyncNG's "data-gifting" catalog (for example) would
  // then be purchased with dataType:'data-sme', and AutosyncNG
  // correctly rejects that as "Invalid product code" — but only
  // AFTER the wallet had already been debited, leaving the
  // transaction stuck 'pending'. Now dataType is derived from the
  // plan's own plan_type column, matching whichever AutosyncNG
  // category it was actually sourced from. body.dataType (if ever
  // explicitly passed) still wins, for backward compatibility.
  const dataType = body.dataType || normalizeDataType(plan.plan_type) || 'data-sme';
  if (!body.dataType && !normalizeDataType(plan.plan_type)) {
    console.warn(
      `[orderService] Data plan ${planId} has no recognizable plan_type ("${plan.plan_type}") — ` +
      `falling back to 'data-sme'. Set "Plan Type" correctly in admin.html to fix this.`
    );
  }

  if (apiProvider === 'supercheapdata') {
    // Column reuse per migration 14_data_plans_api_provider.sql:
    // product_id -> SuperCheapData's network_type (e.g. "mtn_dt")
    // plan_code  -> SuperCheapData's plan_id (e.g. "500MB_30_DAYS")
    const networkType = validateProductId(
      plan.product_id,
      'networkType (plan is missing its SuperCheapData network_type — set it in the product_id field in admin.html)'
    );
    const scdPlanId = validateVariationCode(
      plan.plan_code,
      'planId (plan is missing its SuperCheapData plan_id — set it in the plan_code field in admin.html)'
    );

    return {
      amount: Number(plan.selling_price),
      costPrice: Number(plan.cost_price),
      network: plan.network,
      recipient: phone,
      planId,
      requestPayload: { apiProvider, networkType, scdPlanId },
      callProvider: (reference) =>
        supercheapdata.purchaseData({
          phone,
          networkType,
          planId: scdPlanId,
          reference
        })
    };
  }

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
    requestPayload: { apiProvider, productId, variationCode, dataType },
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

async function resolveAirtimeOrder(body) {
  validateRequiredFields(body, ['network', 'phone', 'amount']);

  const network = String(body.network).toUpperCase();
  const phone = validatePhone(body.phone, 'phone');

  const plan = await fetchActivePlan(
    'airtime_plans',
    { network },
    `Airtime is not currently available for ${network}`
  );

  const productId = validateProductId(
    plan.product_id,
    'productId (plan is missing its AutosyncNG product_id — set it in admin.html first)'
  );

  const amount = validateAmount(body.amount, 'amount', {
    min: Number(plan.min_amount),
    max: Number(plan.max_amount)
  });
  const costPrice = Math.round(amount * (1 - Number(plan.discount_percentage) / 100) * 100) / 100;

  const endpointType = plan.endpoint_type || 'airtime';

  return {
    amount,
    costPrice,
    network,
    recipient: phone,
    planId: null,
    requestPayload: { productId, endpointType },
    callProvider: (reference) =>
      endpointType === 'airtime-share'
        ? autosync.purchaseAirtimeShare({ phone, productId, amount, reference })
        : autosync.purchaseAirtime({ phone, productId, amount, isMtnAwuf: !!body.isMtnAwuf, reference })
  };
}

async function resolveCableOrder(body) {
  validateRequiredFields(body, ['iucNumber']);
  const iucNumber = String(body.iucNumber).trim();
  const cableType = body.cableType === 'change' ? 'change' : 'renew';

  if (cableType === 'change') {
    validateRequiredFields(body, ['planId']);
    const planId = validateUUID(body.planId, 'planId');
    const plan = await fetchActivePlan('cable_plans', { id: planId }, 'Cable plan not found or inactive');
    const variationCode = validateVariationCode(plan.plan_code, 'variationCode');
    const productId = validateProductId(
      plan.product_id,
      'productId (plan is missing its AutosyncNG product_id — set it in admin.html first)'
    );

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

  validateRequiredFields(body, ['network', 'amount']);
  const network = String(body.network).toUpperCase();
  const amount = validateAmount(body.amount, 'amount', { min: 100, max: 200000 });

  const productId = await fetchProviderProductId(
    'cable_plans',
    'provider',
    network,
    `${network} is not currently configured (no plan with a product_id) — set one up in admin.html first`
  );

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
    console.error('[orderService] Failed to record pending provider reference:', error.message);
  }
}

// -----------------------------------------------------------------------
// executeOrder — the single entry point every caller uses
// -----------------------------------------------------------------------

/**
 * Place and fulfill an order. Verifies the PIN, resolves pricing from
 * the database, debits the wallet, calls AutosyncNG, and resolves the
 * transaction to success/pending/failed — the exact same pipeline
 * regardless of whether the caller is the app (via HTTP) or the
 * WhatsApp bot (calling this directly, in-process).
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.type - one of TYPE_RESOLVERS' keys
 * @param {string} params.pin - plaintext transaction PIN
 * @param {string} [params.requestRef] - optional idempotency key
 * @param {Object} params.orderFields - the type-specific fields (planId, phone, amount, etc.)
 * @returns {Promise<{ transaction: Object, providerResult: Object|null, alreadyProcessed: boolean, pending: boolean }>}
 * @throws {ValidationError|AuthError|OrderFailedError}
 */
async function executeOrder({ userId, type, pin, requestRef, ...orderFields }) {
  const validatedPin = validatePin(pin, 'pin');
  await verifyPin(userId, validatedPin);

  const resolveOrder = TYPE_RESOLVERS[type];
  if (!resolveOrder) {
    throw new ValidationError('Unsupported order type', {
      details: [{ field: 'type', message: `type must be one of: ${Object.keys(TYPE_RESOLVERS).join(', ')}` }]
    });
  }

  const order = await resolveOrder(orderFields);

  const idempotencyKey = requestRef
    ? validateRequestRef(requestRef, 'request_ref')
    : wallet.generateReference(type.toUpperCase());

  let txn = await transactions.createPendingTransaction({
    userId,
    type,
    planId: order.planId,
    network: order.network,
    recipient: order.recipient,
    amount: order.amount,
    costPrice: order.costPrice,
    idempotencyKey,
    requestPayload: order.requestPayload
  });

  if (txn.status !== 'pending') {
    return { transaction: formatTransaction(txn), providerResult: null, alreadyProcessed: true, pending: false };
  }

  const providerResult = await order.callProvider(idempotencyKey);

  if (providerResult.status === 'successful') {
    txn = await transactions.markSuccessful({
      transactionId: txn.id,
      providerReference: providerResult.reference,
      responsePayload: providerResult.raw
    });
    return { transaction: formatTransaction(txn, providerResult), providerResult, alreadyProcessed: false, pending: false };
  }

  if (providerResult.status === 'pending') {
    await attachPendingProviderReference(txn.id, providerResult);
    return { transaction: formatTransaction(txn, providerResult), providerResult, alreadyProcessed: false, pending: true };
  }

  // A timeout/network error means we genuinely don't know what
  // happened on the provider's side — AutosyncNG never responded at
  // all, so there's no definitive rejection to act on (unlike e.g.
  // "Invalid product code", which IS a real response and correctly
  // still falls through to markFailed below). Treating this the same
  // as a definitive failure was refunding customers whose orders had
  // actually gone through — the money was taken correctly, the data
  // was delivered, and then it was ALSO refunded, a pure loss.
  //
  // Instead: leave it 'pending', and record our own idempotencyKey as
  // provider_reference (it's the only identifier we have — we never
  // got AutosyncNG's own reference back) so it can be looked up
  // later, either by api/cron/reconcile-failed-transactions.js or an
  // admin using the "Check real status with AutosyncNG" tool.
  if (providerResult.status === 'error' && (providerResult.isTimeout || providerResult.isNetworkError)) {
    await attachPendingProviderReference(txn.id, { ...providerResult, reference: idempotencyKey });
    return { transaction: formatTransaction(txn, providerResult), providerResult, alreadyProcessed: false, pending: true };
  }

  txn = await transactions.markFailed({
    transactionId: txn.id,
    reason: providerResult.message,
    responsePayload: providerResult.raw
  });

  throw new OrderFailedError(providerResult.message || 'Purchase failed', {
    details: [{ field: 'transaction', message: `Transaction ${txn.id} failed and the amount has been refunded to your wallet` }]
  });
}

module.exports = {
  OrderFailedError,
  TYPE_RESOLVERS,
  fetchActivePlan,
  fetchProviderProductId,
  formatTransaction,
  executeOrder
};
