'use strict';

/**
 * lib/autosync.js
 * ---------------------------------------------------------------------
 * AutosyncNG API client, built against the official developer docs at
 * https://autosyncng.com/user/developer/docs (confirmed against the
 * live docs for: Misc/Auth, Data SME, Airtime, Cable, Electricity,
 * Account, Transaction lookup, and the Errors reference).
 *
 * This module's ONLY responsibility is talking to AutosyncNG over
 * HTTP — it does not touch the wallet, does not write transactions,
 * and does not know about Supabase. Purchase endpoints (api/buy-data.js,
 * api/buy-airtime.js, etc.) orchestrate: wallet.debitWallet() ->
 * transactions.createPendingTransaction() -> autosync.purchaseX() ->
 * transactions.markSuccessful()/markFailed().
 *
 * -----------------------------------------------------------------
 * CONFIRMED FROM OFFICIAL DOCS
 * -----------------------------------------------------------------
 * Base URL:        https://autosyncng.com/api/v1  (set via env var — never hardcoded)
 * Auth header:      Authorization: Bearer <developer API key>
 *                    (also requires Content-Type: application/json, Accept: application/json)
 * Access tokens:    long-lived, expire after one year
 * Transaction pin:  sent in the body of every purchase call as "pin"
 * Transaction statuses (authoritative, per docs): successful | failed | pending
 *   - "pending" means AutosyncNG will push the final status to your
 *     webhook_url once known — it is NOT a terminal state.
 * Error shape:      { "status": "error", "message": "..." }
 * Success shape:    { "status": "ok", "message": "...", "data": { "transaction": {...} } }
 *   - NOTE: top-level "status": "ok" only means the request was
 *     accepted — the actual outcome is data.transaction.status
 *     (successful / pending / failed). This module normalizes off
 *     data.transaction.status, not the top-level status.
 *
 * Confirmed endpoints:
 *   GET  /me                    -> account info + wallet balance
 *   GET  /data/sme               -> Data SME categories/products/variations
 *   POST /data/sme               -> purchase Data SME
 *     body: { request_ref, phone, product_id, variation_code, webhook_url, ported_no, pin }
 *   GET  /airtime                -> Airtime categories/products
 *   POST /airtime                -> purchase Airtime
 *     body: { request_ref, phone, product_id, amount, is_mtn_awuf, webhook_url, ported_no, pin }
 *   GET  /cable                  -> Cable TV categories/products
 *   POST /cable                  -> renew / free entry / box office
 *     body: { request_ref, iuc_number, product_id, variation_code, type, amount, is_box_office, pin }
 *   GET  /electricity            -> Electricity disco categories/products
 *   POST /electricity            -> purchase Electricity (returns token for prepaid)
 *     body: { request_ref, meter_number, product_id, type, amount, pin }
 *   GET  /transaction/{reference} -> look up a transaction by reference/request_ref
 *
 * AutosyncNG also exposes Data Gifting, Data Transfer, Data Corporate,
 * Talk More (GET/POST /data/talk-more — confirmed to share the exact
 * Data SME request/response shape), Cable "Change Subscription",
 * Betting, Internet, SMS, and Data PIN endpoints, which follow the
 * same request/response pattern and are included in SERVICE_ENDPOINTS
 * below for getCategories()/getProducts() but are not wired to a
 * dedicated purchase*() function since none were requested.
 *
 * NOT AVAILABLE FROM AUTOSYNCNG: the official docs have no
 * WAEC/NECO/NABTEB "education" or JAMB "exam" pin category — their
 * catalog covers Airtime, Data, Cable, Electricity, Betting, Internet,
 * SMS, and Data PIN only. purchaseEducation() and purchaseExam() are
 * kept below (for interface compatibility with earlier code) but
 * resolve to a normalized failure explaining this, rather than
 * calling a made-up endpoint. If you need result-checker pins, AutosyncNG's
 * closest real feature is "Data PIN" (GET/POST /data-pin) — let me
 * know and I can wire a purchaseDataPin() against that instead.
 * -----------------------------------------------------------------
 *
 * Required environment variables (server-side only — never bundle
 * these into frontend code):
 *   AUTOSYNC_API_URL      e.g. https://autosyncng.com/api/v1
 *   AUTOSYNC_API_KEY      developer Bearer token from AutosyncNG dashboard
 *   AUTOSYNC_MERCHANT_PIN merchant transaction PIN required on purchases
 * ---------------------------------------------------------------------
 */

const axios = require('axios');
const crypto = require('crypto');

const API_URL = process.env.AUTOSYNC_API_URL;
const API_KEY = process.env.AUTOSYNC_API_KEY;
const MERCHANT_PIN = process.env.AUTOSYNC_MERCHANT_PIN;

if (!API_URL || !API_KEY || !MERCHANT_PIN) {
  throw new Error(
    'Missing required env vars: AUTOSYNC_API_URL, AUTOSYNC_API_KEY, and/or AUTOSYNC_MERCHANT_PIN'
  );
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

// Per-service GET/POST paths, confirmed against the docs sidebar +
// individual endpoint pages. Used by getCategories()/getProducts()
// and by the purchase*() functions below.
const SERVICE_ENDPOINTS = {
  'data-sme': { get: '/data/sme', post: '/data/sme' },
  'data-gifting': { get: '/data/gifting', post: '/data/gifting' },
  'data-transfer': { get: '/data/transfer', post: '/data/transfer' },
  'data-corporate': { get: '/data/corporate', post: '/data/corporate' },
  'talk-more': { get: '/data/talk-more', post: '/data/talk-more' },
  airtime: { get: '/airtime', post: '/airtime' },
  'airtime-share': { get: '/airtime-share', post: '/airtime-share' },
  cable: { get: '/cable', post: '/cable' },
  electricity: { get: '/electricity', post: '/electricity' },
  betting: { get: '/betting', post: '/betting' },
  internet: { get: '/internet', post: '/internet' },
  sms: { get: '/sms', post: '/sms' },
  'data-pin': { get: '/data-pin', post: '/data-pin' }
};

const ENDPOINTS = {
  account: '/me',
  transaction: (reference) => `/transaction/${encodeURIComponent(reference)}`
};

const httpClient = axios.create({
  baseURL: API_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
});

class AutosyncError extends Error {
  constructor(message, { statusCode = null, data = null, raw = null, code = 'AUTOSYNC_ERROR' } = {}) {
    super(message);
    this.name = 'AutosyncError';
    this.code = code;
    this.statusCode = statusCode;
    this.data = data;
    this.raw = raw;
  }
}

/**
 * Redact secrets before anything gets logged.
 */
function sanitizeForLog(input) {
  if (!input || typeof input !== 'object') return input;
  const clone = JSON.parse(JSON.stringify(input));
  const REDACT_KEYS = ['pin', 'merchant_pin', 'api_key', 'authorization', 'password'];
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (REDACT_KEYS.includes(key.toLowerCase())) {
        obj[key] = '***REDACTED***';
      } else if (typeof obj[key] === 'object') {
        walk(obj[key]);
      }
    }
  };
  walk(clone);
  return clone;
}

/**
 * Structured, secret-safe error logging for provider failures.
 */
function logProviderError(context, error) {
  const details = {
    context,
    message: error.message,
    statusCode: error.response ? error.response.status : null,
    responseData: error.response ? sanitizeForLog(error.response.data) : null,
    requestPayload: error.config ? sanitizeForLog(safeParseJson(error.config.data)) : null,
    isTimeout: error.code === 'ECONNABORTED',
    isNetworkError: !error.response && !!error.request
  };
  // eslint-disable-next-line no-console
  console.error('[AutosyncNG] Provider error:', JSON.stringify(details));
}

function safeParseJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (_e) {
    return str;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A response is worth retrying only when it's likely transient:
 * network failure, timeout, or a 5xx from AutosyncNG. 4xx (bad
 * request, invalid pin, insufficient balance, invalid recipient,
 * etc.) is never retried since retrying won't change the outcome —
 * and retrying a purchase that already reached AutosyncNG risks a
 * duplicate charge on their side. request_ref-based idempotency on
 * their end is the real protection there; MAX_RETRIES only guards
 * against requests that never arrived.
 */
function isRetryable(error) {
  if (error.code === 'ECONNABORTED') return true; // timeout
  if (!error.response) return true; // network error, no response received
  return error.response.status >= 500;
}

/**
 * Execute an HTTP request with automatic timeout (set on the axios
 * instance) and retry with exponential backoff + jitter for
 * transient failures.
 */
async function requestWithRetry(config, context) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await httpClient.request(config);
      return response;
    } catch (error) {
      lastError = error;
      logProviderError(`${context} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, error);

      const isLastAttempt = attempt === MAX_RETRIES;
      if (isLastAttempt || !isRetryable(error)) {
        break;
      }

      const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 150);
      await sleep(backoff + jitter);
    }
  }

  throw lastError;
}

/**
 * Normalize any AutosyncNG response (success or error) into one
 * standard shape. `success` is true only when the underlying
 * transaction status is "successful" — a "pending" transaction is
 * NOT success:true, since AutosyncNG has not finished processing it
 * yet and will notify the webhook_url with the final status.
 *
 * Standard shape:
 *   {
 *     success: boolean,
 *     status: 'successful' | 'pending' | 'failed' | 'error',
 *     statusCode: number | null,   // HTTP status code
 *     message: string,
 *     reference: string | null,    // AutosyncNG's own transaction reference (UUID)
 *     requestRef: string | null,   // the request_ref you sent (or AutosyncNG generated)
 *     amount: number | null,
 *     details: string | null,      // human-readable transaction detail, when provided
 *     token: string | null,        // electricity prepaid token, when applicable
 *     units: string | null,        // electricity units, when applicable
 *     data: object | null,         // the raw data.transaction object
 *     raw: object | null           // the full raw response body
 *   }
 */
function normalizeResponse(response) {
  const body = (response && response.data) || {};

  // Request-level error (top-level "status": "error").
  if (body.status === 'error') {
    return {
      success: false,
      status: 'error',
      statusCode: response ? response.status : null,
      message: body.message || 'AutosyncNG request failed',
      reference: null,
      requestRef: null,
      amount: null,
      details: null,
      token: null,
      units: null,
      data: null,
      raw: body
    };
  }

  const txn = body.data && body.data.transaction;

  // Purchase-style response: status lives on the nested transaction,
  // and "pending" there is NOT the same as success.
  if (txn) {
    const txnStatus = txn.status || 'pending';
    return {
      success: txnStatus === 'successful',
      status: txnStatus, // 'successful' | 'pending' | 'failed'
      statusCode: response.status,
      message: body.message || 'Request successfully',
      reference: txn.reference || null,
      requestRef: txn.request_ref || null,
      amount: txn.amount !== undefined ? Number(txn.amount) : null,
      details: txn.details || null,
      token: txn.token || null,
      units: txn.units || null,
      data: txn,
      raw: body
    };
  }

  // Catalog/listing-style response (GET /data/sme, /data/talk-more,
  // /airtime, /cable, /electricity, etc.) — these return data.category
  // (products/variations nested inside), not data.transaction. A 2xx,
  // non-"error" body here is a successful read.
  return {
    success: true,
    status: 'successful',
    statusCode: response.status,
    message: body.message || 'Request successful',
    reference: null,
    requestRef: null,
    amount: null,
    details: null,
    token: null,
    units: null,
    data: body.data || null,
    raw: body
  };
}

/**
 * Normalize a thrown axios error (network failure, timeout, or a
 * non-2xx HTTP response) into the same standard shape.
 */
function normalizeFailure(error) {
  const body = error.response ? error.response.data : null;
  const txn = (body && body.data && body.data.transaction) || null;

  const message =
    (body && body.message) ||
    (error.code === 'ECONNABORTED' ? 'AutosyncNG request timed out' : null) ||
    error.message ||
    'AutosyncNG request failed';

  // A non-2xx can still carry a transaction object (e.g. a validated
  // but failed purchase) — prefer its status if present.
  const status = txn ? txn.status || 'failed' : 'error';

  return {
    success: status === 'successful',
    status,
    statusCode: error.response ? error.response.status : null,
    message,
    reference: txn ? txn.reference || null : null,
    requestRef: txn ? txn.request_ref || null : null,
    amount: txn && txn.amount !== undefined ? Number(txn.amount) : null,
    details: txn ? txn.details || null : null,
    token: txn ? txn.token || null : null,
    units: txn ? txn.units || null : null,
    data: txn,
    raw: body
  };
}

/**
 * Run a request through retry + normalization. Always resolves to
 * the standard normalized shape instead of throwing, so callers can
 * check `.success`/`.status` rather than wrapping every call in
 * try/catch.
 */
async function callProvider(config, context) {
  try {
    const response = await requestWithRetry(config, context);
    return normalizeResponse(response);
  } catch (error) {
    return normalizeFailure(error);
  }
}

function generateRequestRef(prefix = 'ASN') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function resolveWebhookUrl(explicitWebhookUrl) {
  // If not explicitly provided, AutosyncNG falls back to the webhook
  // URL configured in your developer dashboard — so it's fine to omit.
  return explicitWebhookUrl || process.env.AUTOSYNC_WEBHOOK_URL || undefined;
}

// -----------------------------------------------------------------------
// Account / catalog
// -----------------------------------------------------------------------

/**
 * Get the merchant's AutosyncNG account info, including wallet_balance.
 * Maps to: GET /me
 */
async function getAccount() {
  return callProvider({ method: 'GET', url: ENDPOINTS.account }, 'getAccount');
}

/**
 * Get product categories. AutosyncNG has no single "all categories"
 * endpoint — each service (data-sme, airtime, cable, electricity,
 * etc.) exposes its own GET endpoint returning that service's
 * category + nested products/variations. This fetches all of them in
 * parallel and returns a map keyed by service type.
 *
 * @param {string[]} [serviceTypes] - subset of SERVICE_ENDPOINTS keys to fetch; defaults to all
 * @returns {Promise<Object>} map of serviceType -> normalized response
 */
async function getCategories(serviceTypes) {
  const types = serviceTypes && serviceTypes.length ? serviceTypes : Object.keys(SERVICE_ENDPOINTS);

  const results = await Promise.all(
    types.map(async (type) => {
      const endpoint = SERVICE_ENDPOINTS[type];
      if (!endpoint) {
        return [type, { success: false, status: 'error', message: `Unknown service type: ${type}` }];
      }
      const result = await callProvider({ method: 'GET', url: endpoint.get }, `getCategories:${type}`);
      return [type, result];
    })
  );

  return Object.fromEntries(results);
}

/**
 * Get products/variations for a single service category.
 * NOTE: AutosyncNG scopes this by service-type slug (e.g. 'data-sme',
 * 'airtime', 'cable', 'electricity'), not by an arbitrary numeric
 * category id — there is no `/products?category_id=` endpoint in
 * their API. `categoryType` should be one of the SERVICE_ENDPOINTS keys.
 *
 * @param {string} categoryType - a key from SERVICE_ENDPOINTS, e.g. 'data-sme'
 * @returns {Promise<Object>} normalized response; on success, .data holds the products array
 */
async function getProducts(categoryType) {
  const endpoint = SERVICE_ENDPOINTS[categoryType];
  if (!endpoint) {
    throw new AutosyncError(
      `Unknown categoryType "${categoryType}". Expected one of: ${Object.keys(SERVICE_ENDPOINTS).join(', ')}`,
      { code: 'INVALID_INPUT' }
    );
  }

  const result = await callProvider({ method: 'GET', url: endpoint.get }, 'getProducts');

  // Reshape so callers get products directly, matching the requested
  // getProducts(categoryId) ergonomics as closely as the real API allows.
  const category = result.raw && result.raw.data && result.raw.data.category;
  return {
    ...result,
    data: category ? category.products : null
  };
}

// -----------------------------------------------------------------------
// Purchases
// -----------------------------------------------------------------------

/**
 * Purchase a data bundle. Defaults to the Data SME endpoint (the
 * category whose request body was confirmed against the docs), and
 * accepts `dataType` to target the other Data categories AutosyncNG
 * offers (gifting, transfer, corporate) or Talk More, which share the
 * same request/response shape.
 *
 * Maps to: POST /data/sme (or the equivalent path for the chosen dataType)
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.productId       - product id/code from getProducts('data-sme')
 * @param {string} params.variationCode   - variation code from the same product
 * @param {string} [params.dataType='data-sme'] - 'data-sme' | 'data-gifting' | 'data-transfer' | 'data-corporate' | 'talk-more'
 * @param {string} [params.webhookUrl]
 * @param {boolean} [params.portedNo]
 * @param {string} [params.reference]     - your request_ref; auto-generated if omitted
 */
async function purchaseData({
  phone,
  productId,
  variationCode,
  dataType = 'data-sme',
  webhookUrl,
  portedNo,
  reference
}) {
  const endpoint = SERVICE_ENDPOINTS[dataType];
  if (!endpoint) {
    throw new AutosyncError(
      `Unknown dataType "${dataType}". Expected one of: data-sme, data-gifting, data-transfer, data-corporate, talk-more`,
      { code: 'INVALID_INPUT' }
    );
  }

  const requestRef = reference || generateRequestRef('DATA');

  return callProvider(
    {
      method: 'POST',
      url: endpoint.post,
      data: {
        request_ref: requestRef,
        phone,
        product_id: productId,
        variation_code: variationCode,
        webhook_url: resolveWebhookUrl(webhookUrl),
        ported_no: !!portedNo,
        pin: MERCHANT_PIN
      }
    },
    'purchaseData'
  );
}

/**
 * Purchase airtime.
 * Maps to: POST /airtime
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.productId    - network product id/code from getProducts('airtime')
 * @param {number} params.amount
 * @param {boolean} [params.isMtnAwuf] - set true for MTN AWUF airtime
 * @param {string} [params.webhookUrl]
 * @param {boolean} [params.portedNo]
 * @param {string} [params.reference]  - your request_ref; auto-generated if omitted
 */
async function purchaseAirtime({ phone, productId, amount, isMtnAwuf, webhookUrl, portedNo, reference }) {
  const requestRef = reference || generateRequestRef('AIR');

  return callProvider(
    {
      method: 'POST',
      url: SERVICE_ENDPOINTS.airtime.post,
      data: {
        request_ref: requestRef,
        phone,
        product_id: productId,
        amount,
        is_mtn_awuf: !!isMtnAwuf,
        webhook_url: resolveWebhookUrl(webhookUrl),
        ported_no: !!portedNo,
        pin: MERCHANT_PIN
      }
    },
    'purchaseAirtime'
  );
}

/**
 * Renew / free-entry / box-office a cable TV subscription.
 * Maps to: POST /cable
 *
 * @param {Object} params
 * @param {string} params.iucNumber
 * @param {string} params.productId        - cable provider id/code from getProducts('cable')
 * @param {number} params.amount           - the outstanding_amount, or a chosen amount for free entry
 * @param {string} [params.variationCode='none'] - must be 'none' for free entry/renewals/box office per docs
 * @param {string} [params.type='renew']
 * @param {boolean} [params.isBoxOffice]   - only set true for box-office accounts
 * @param {string} [params.reference]      - your request_ref; auto-generated if omitted
 */
async function purchaseCable({
  iucNumber,
  productId,
  amount,
  variationCode = 'none',
  type = 'renew',
  isBoxOffice,
  reference
}) {
  const requestRef = reference || generateRequestRef('CABLE');

  return callProvider(
    {
      method: 'POST',
      url: SERVICE_ENDPOINTS.cable.post,
      data: {
        request_ref: requestRef,
        iuc_number: iucNumber,
        product_id: productId,
        variation_code: variationCode,
        type,
        amount,
        is_box_office: !!isBoxOffice,
        pin: MERCHANT_PIN
      }
    },
    'purchaseCable'
  );
}

/**
 * Pay an electricity bill / vend a meter token.
 * Maps to: POST /electricity
 * On success for a prepaid meter, the normalized result's `.token`
 * field carries the vended token.
 *
 * @param {Object} params
 * @param {string} params.meterNumber
 * @param {string} params.productId    - disco id/code from getProducts('electricity')
 * @param {string} params.meterType    - 'prepaid' | 'postpaid'
 * @param {number} params.amount
 * @param {string} [params.reference]  - your request_ref; auto-generated if omitted
 */
async function purchaseElectricity({ meterNumber, productId, meterType, amount, reference }) {
  const requestRef = reference || generateRequestRef('ELEC');

  return callProvider(
    {
      method: 'POST',
      url: SERVICE_ENDPOINTS.electricity.post,
      data: {
        request_ref: requestRef,
        meter_number: meterNumber,
        product_id: productId,
        type: meterType,
        amount,
        pin: MERCHANT_PIN
      }
    },
    'purchaseElectricity'
  );
}

/**
 * NOT SUPPORTED BY AUTOSYNCNG.
 * The official AutosyncNG API has no education result-checker pin
 * category (no WAEC/NECO/NABTEB endpoint exists in their docs).
 * Kept as a stub for interface compatibility — resolves to a
 * normalized failure rather than calling a fabricated endpoint.
 * If this is actually meant to be a Data PIN purchase, use
 * getProducts('data-pin') / a dedicated purchaseDataPin() instead
 * (POST /data-pin, confirmed to exist in the docs but not wired up
 * here since it wasn't requested).
 */
async function purchaseEducation() {
  return {
    success: false,
    status: 'error',
    statusCode: null,
    message:
      'AutosyncNG does not offer an education result-checker pin category. ' +
      "Its documented catalog is: Airtime, Data (SME/Gifting/Transfer/Corporate), Talk More, " +
      "Cable, Electricity, Betting, Internet, SMS, and Data PIN. " +
      "If you meant Data PIN, ask me to wire up purchaseDataPin() against POST /data-pin.",
    reference: null,
    requestRef: null,
    amount: null,
    details: null,
    token: null,
    units: null,
    data: null,
    raw: null
  };
}

/**
 * NOT SUPPORTED BY AUTOSYNCNG.
 * The official AutosyncNG API has no exam pin category (no JAMB
 * endpoint exists in their docs). Kept as a stub for interface
 * compatibility — resolves to a normalized failure rather than
 * calling a fabricated endpoint.
 */
async function purchaseExam() {
  return {
    success: false,
    status: 'error',
    statusCode: null,
    message:
      'AutosyncNG does not offer an exam pin (e.g. JAMB) category. ' +
      "Its documented catalog is: Airtime, Data (SME/Gifting/Transfer/Corporate), Talk More, " +
      "Cable, Electricity, Betting, Internet, SMS, and Data PIN.",
    reference: null,
    requestRef: null,
    amount: null,
    details: null,
    token: null,
    units: null,
    data: null,
    raw: null
  };
}

// -----------------------------------------------------------------------
// Transaction lookup (for reconciling a 'pending' result)
// -----------------------------------------------------------------------

/**
 * Look up a transaction by its reference (AutosyncNG's own UUID
 * reference) or your original request_ref.
 * Maps to: GET /transaction/{reference}
 * Useful for requerying a transaction that came back 'pending' before
 * AutosyncNG's webhook fires, or as a fallback if the webhook is missed.
 *
 * @param {string} reference
 */
async function getTransactionStatus(reference) {
  if (!reference) {
    throw new AutosyncError('reference is required', { code: 'INVALID_INPUT' });
  }
  return callProvider({ method: 'GET', url: ENDPOINTS.transaction(reference) }, 'getTransactionStatus');
}

module.exports = {
  AutosyncError,
  SERVICE_ENDPOINTS,
  generateRequestRef,
  getAccount,
  getCategories,
  getProducts,
  purchaseData,
  purchaseAirtime,
  purchaseCable,
  purchaseElectricity,
  purchaseEducation,
  purchaseExam,
  getTransactionStatus
};
