'use strict';

/**
 * lib/absvendor.js
 * ---------------------------------------------------------------------
 * ABS Vendor API client (https://absvendor.com) — airtime + data.
 * Same job as lib/plinno.js / lib/supercheapdata.js: ONLY talks to the
 * provider over HTTP, returns the same normalized shape as
 * lib/autosync.js#callProvider so lib/orderService.js can use it
 * interchangeably. It never touches the wallet or Supabase.
 *
 * -----------------------------------------------------------------
 * FROM ABS DOCS (confirmed from their documentation page):
 * -----------------------------------------------------------------
 * Base URL:  https://absvendor.com/
 * Auth:      Authorization: Bearer <api key>
 * Body:      multipart form-data (curl -F), NOT JSON. All endpoints POST.
 * Rate limit: 300 requests / 60 minutes (HTTP 429 when exceeded).
 *
 * POST /api/user/transaction/buy_airtime.php
 *   amount      integer, required, min 50, whole numbers only
 *   airtimetid  string,  required, e.g. MTNAIR6TFD, GLOT66TFD,
 *                                  AIR67YDCFD, 9MOB67YT
 *   phoneno     string,  required, e.g. 08012345678
 *   coupon_code string,  optional
 *
 * Success: HTTP 200
 *   { "status": true, "data": { coupon_applied, discount_amount,
 *     original_amount, final_amount }, "text": "Bought successfully" }
 *
 * HTTP codes: 200 OK | 400 invalid params | 401 bad API key |
 *             429 rate limit | 500 server error.
 *
 * POST /api/user/transaction/buy_data.php   (confirmed from docs)
 *   phoneno      string, required, e.g. 08012345678
 *   airtimetid   string, required, NETWORK provider ID (e.g. MTN56TFD,
 *                GLO536TFD, AIRYU78TFD, 9MOB8TFD) = the provider's
 *                `product_trackid` from get_system_data.php
 *                (data.data_providers[]). NOT the same as the airtime IDs.
 *   cardunittid  string, required, the PLAN's `trackid` from
 *                data.data_providers[].bouquetdata[]
 *   coupon_code  string, optional
 *   Same success response as airtime.
 *
 * Optional account PIN: ABS has an "API Security Settings" switch
 * "Require transaction PIN on every call". If it is ON, set
 * ABSVENDOR_PIN and it is sent as the `pin` field on every request
 * (or switch that option off in the ABS dashboard).
 *
 * Required environment variable (server-side only):
 *   ABSVENDOR_API_KEY   the Bearer token from ABS dashboard (abs_...)
 * Optional:
 *   ABSVENDOR_PIN       your ABS transaction PIN (only if PIN is required)
 *   ABSVENDOR_BASE_URL  defaults to https://absvendor.com
 *
 * The key is read lazily (per call), so a missing key only fails ABS
 * orders — it does not crash the whole app at startup.
 * ---------------------------------------------------------------------
 */

const BASE_URL = (process.env.ABSVENDOR_BASE_URL || 'https://absvendor.com').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 20000;

class AbsVendorError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.name = 'AbsVendorError';
    this.code = code;
  }
}

function logProviderError(context, info) {
  // eslint-disable-next-line no-console
  console.error('[ABSVendor] Provider error:', JSON.stringify({ context, ...info }));
}

function failure(message, extra = {}) {
  return {
    success: false,
    status: 'failed',
    statusCode: null,
    message,
    reference: null,
    requestRef: null,
    amount: null,
    details: null,
    token: null,
    units: null,
    data: null,
    raw: null,
    ...extra
  };
}

/**
 * POST multipart/form-data to ABS and normalize the answer.
 *
 * HTTP-code handling (ABS uses real status codes, unlike Plinno):
 *   200 + body.status === true -> success
 *   400 / 401 / 429            -> definitive rejection (nothing was
 *                                 bought) -> 'failed' -> wallet refunded
 *   5xx, timeout, network      -> AMBIGUOUS: the purchase may have gone
 *                                 through. Returned as an error with
 *                                 isNetworkError/isTimeout so
 *                                 orderService leaves it 'pending'
 *                                 instead of refunding on a guess.
 *
 * Never retried automatically (double-charge risk).
 */
async function post(path, fields, context) {
  const apiKey = process.env.ABSVENDOR_API_KEY;
  if (!apiKey) {
    logProviderError(context, { message: 'ABSVENDOR_API_KEY is not set' });
    return failure('ABS Vendor is not configured (ABSVENDOR_API_KEY missing)');
  }

  const form = new FormData();
  if (process.env.ABSVENDOR_PIN) fields = { ...fields, pin: process.env.ABSVENDOR_PIN };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  let body = null;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = { raw_text: text.slice(0, 500) };
    }
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    logProviderError(context, { message: err.message, isTimeout });
    return failure(isTimeout ? 'ABS Vendor request timed out' : `ABS Vendor unreachable: ${err.message}`, {
      status: 'error',
      isTimeout,
      isNetworkError: !isTimeout
    });
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = response.status;
  const message = (body && (body.text || body.message)) || null;

  if (httpStatus === 200 && body && body.status === true) {
    const d = body.data || {};
    return {
      success: true,
      status: 'successful',
      statusCode: httpStatus,
      message: message || 'Purchase successful',
      reference: null, // ABS returns no transaction reference
      requestRef: null,
      amount: d.final_amount !== undefined ? Number(d.final_amount) : null,
      details: d,
      token: null,
      units: null,
      data: body,
      raw: body
    };
  }

  logProviderError(context, { statusCode: httpStatus, responseData: body });

  // 5xx (or an unreadable 200) — outcome unknown, do not refund yet.
  if (httpStatus >= 500) {
    return failure(message || `ABS Vendor server error (${httpStatus})`, {
      status: 'error',
      statusCode: httpStatus,
      isTimeout: false,
      isNetworkError: true,
      raw: body
    });
  }

  // 400 / 401 / 429 / 200-with-status-false -> definitive failure.
  return failure(message || `ABS Vendor request failed (${httpStatus})`, {
    statusCode: httpStatus,
    data: body,
    raw: body
  });
}

/**
 * Buy airtime via ABS.
 * @param {string} params.phone
 * @param {string} params.airtimeId  ABS airtimetid, e.g. MTNAIR6TFD
 * @param {number} params.amount     whole naira, min 50
 * @param {string} [params.couponCode]
 */
async function purchaseAirtime({ phone, airtimeId, amount, couponCode }) {
  if (!airtimeId) throw new AbsVendorError('airtimeId is required', { code: 'INVALID_INPUT' });
  const whole = Math.round(Number(amount));
  if (!Number.isFinite(whole) || whole < 50) {
    return failure('ABS airtime amount must be a whole number of at least 50');
  }
  return post(
    '/api/user/transaction/buy_airtime.php',
    { amount: whole, airtimetid: airtimeId, phoneno: phone, coupon_code: couponCode },
    'purchaseAirtime'
  );
}

/**
 * Buy a data bundle via ABS.
 * @param {string} params.phone
 * @param {string} params.networkId  ABS airtimetid for the network (data_providers[].product_trackid)
 * @param {string} params.planId     ABS cardunittid (bouquetdata[].trackid)
 */
async function purchaseData({ phone, networkId, planId, couponCode }) {
  if (!networkId) throw new AbsVendorError('networkId is required', { code: 'INVALID_INPUT' });
  if (!planId) throw new AbsVendorError('planId is required', { code: 'INVALID_INPUT' });
  return post(
    '/api/user/transaction/buy_data.php',
    { phoneno: phone, airtimetid: networkId, cardunittid: planId, coupon_code: couponCode },
    'purchaseData'
  );
}

module.exports = { purchaseAirtime, purchaseData, AbsVendorError };
