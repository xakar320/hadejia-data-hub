'use strict';

/**
 * lib/supercheapdata.js
 * ---------------------------------------------------------------------
 * SuperCheapData API client. Currently only wires purchaseData()
 * (Data Transfer, confirmed live-working — see below), since that's
 * the only case this was needed for so far. Airtime was intentionally
 * NOT wired here yet: SuperCheapData's own website had Airtime
 * purchases visibly disabled at the time this was built, so there was
 * no way to confirm its real response shape safely.
 *
 * This module's ONLY responsibility is talking to SuperCheapData over
 * HTTP — it does not touch the wallet, does not write transactions,
 * and does not know about Supabase, mirroring lib/autosync.js's
 * separation of concerns. It also returns the EXACT SAME normalized
 * response shape as lib/autosync.js's callProvider(), so
 * lib/orderService.js can call either provider interchangeably.
 *
 * -----------------------------------------------------------------
 * CONFIRMED FROM A LIVE TEST CALL (not guessed):
 * -----------------------------------------------------------------
 * Base URL:    https://supercheapdata.com/api
 * Auth header: Authorization: Bearer <api token from SuperCheapData profile page>
 *              (also requires Content-Type: application/json)
 *
 * POST /data
 *   body: { network_type, plan_id, phone_number, transaction_id }
 *     - transaction_id MUST be alphanumeric only — no hyphens or any
 *       other punctuation. Confirmed live: a hyphenated transaction_id
 *       is rejected with "Transaction id can only be alphanumeric,
 *       meaning just letters and numbers are allowed".
 *
 * *** CRITICAL: HTTP status is ALWAYS 200, even on failure. ***
 * Confirmed live with two real calls:
 *   Failure (invalid transaction_id): HTTP 200, body:
 *     { "status": false, "message": "Transaction id can only be ..." }
 *   Success (real ₦310 purchase):     HTTP 200, body:
 *     {
 *       "status": "successful",   <-- STRING "successful", not boolean true
 *       "message": "500MB to 08131003363 data has successfully been
 *                    purchased (...)",
 *       "purchase_amount": 310,
 *       "wallet_before": "20996", <-- string on this field
 *       "wallet_after": 20686,    <-- number on this field (inconsistent, tolerate both)
 *       "api_response": "...",
 *       "reference": "2619227014260242DT",
 *       "data_wallet_desc": ""
 *     }
 *
 * The ONLY reliable success signal is body.status === 'successful'
 * (exact string). HTTP status code must NOT be used to determine
 * success/failure — it is 200 in both cases above. A boolean `false`
 * (not the string "false") is also possible per the failure example.
 * -----------------------------------------------------------------
 *
 * Required environment variables (server-side only):
 *   SUPERCHEAPDATA_API_KEY   token from SuperCheapData's profile page
 * ---------------------------------------------------------------------
 */

const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.SUPERCHEAPDATA_API_KEY;
const BASE_URL = 'https://supercheapdata.com/api';
const REQUEST_TIMEOUT_MS = 20000;

if (!API_KEY) {
  throw new Error('Missing required env var: SUPERCHEAPDATA_API_KEY');
}

class SuperCheapDataError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.name = 'SuperCheapDataError';
    this.code = code;
  }
}

const httpClient = axios.create({
  baseURL: BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  },
  // We need to see the body even on a non-2xx HTTP status, and — per
  // the confirmed behavior above — SuperCheapData actually returns
  // 200 on failure too, so this mainly guards against the rare case
  // of a genuine 4xx/5xx from their infrastructure (e.g. a gateway
  // error), not their own business-logic failures.
  validateStatus: () => true
});

function sanitizeForLog(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = { ...data };
  ['pin', 'password', 'api_key', 'token'].forEach((k) => {
    if (k in clone) clone[k] = '[REDACTED]';
  });
  return clone;
}

function logProviderError(context, error) {
  const details = {
    context,
    message: error.message,
    statusCode: error.response ? error.response.status : null,
    responseData: error.response ? sanitizeForLog(error.response.data) : null,
    isTimeout: error.code === 'ECONNABORTED',
    isNetworkError: !error.response && !!error.request
  };
  // eslint-disable-next-line no-console
  console.error('[SuperCheapData] Provider error:', JSON.stringify(details));
}

/**
 * transaction_id must be alphanumeric only — confirmed live (see
 * header comment). Using base36 timestamp + random hex keeps it
 * short, unique, and free of any punctuation.
 */
function generateTransactionId(prefix = 'HDH') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}${ts}${rand}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Normalize a SuperCheapData response into the exact same shape
 * lib/autosync.js's callProvider() returns, so orderService.js can
 * treat both providers identically.
 */
function normalizeResponse(response) {
  const body = (response && response.data) || {};

  // The ONLY reliable success signal — see header comment. Do NOT use
  // response.status/HTTP code here.
  const success = body.status === 'successful';

  return {
    success,
    status: success ? 'successful' : 'failed',
    statusCode: response ? response.status : null,
    message: body.message || (success ? 'Purchase successful' : 'SuperCheapData request failed'),
    reference: body.reference || null,
    requestRef: null,
    amount: body.purchase_amount !== undefined ? Number(body.purchase_amount) : null,
    details: body.api_response || null,
    token: null,
    units: null,
    data: body,
    raw: body
  };
}

function normalizeFailure(error) {
  const body = error.response ? error.response.data : null;
  const message =
    (body && body.message) ||
    (error.code === 'ECONNABORTED' ? 'SuperCheapData request timed out' : null) ||
    error.message ||
    'SuperCheapData request failed';

  return {
    success: false,
    status: 'error',
    statusCode: error.response ? error.response.status : null,
    message,
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

/**
 * Purchase a data bundle via SuperCheapData.
 *
 * IMPORTANT — SAFETY: unlike a GET request, this is NEVER retried
 * automatically on failure/timeout. A timeout here is ambiguous — the
 * purchase may have actually gone through on SuperCheapData's side —
 * so silently retrying could cause a double charge. If this call
 * fails or times out, it surfaces as a single failed transaction
 * (refunded by the existing wallet/transactions logic), exactly the
 * same safety posture lib/autosync.js already uses for its own
 * purchase calls.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.networkType  - e.g. "mtn_dt" (SuperCheapData's network_type)
 * @param {string} params.planId       - SuperCheapData's plan_id, e.g. "500MB_30_DAYS"
 * @param {string} [params.reference]  - your own transaction_id; auto-generated (alphanumeric) if omitted
 */
async function purchaseData({ phone, networkType, planId, reference }) {
  if (!networkType) {
    throw new SuperCheapDataError('networkType is required', { code: 'INVALID_INPUT' });
  }
  if (!planId) {
    throw new SuperCheapDataError('planId is required', { code: 'INVALID_INPUT' });
  }

  const transactionId = reference ? String(reference).replace(/[^a-zA-Z0-9]/g, '') : generateTransactionId('DATA');

  try {
    const response = await httpClient.post('/data', {
      network_type: networkType,
      plan_id: planId,
      phone_number: phone,
      transaction_id: transactionId
    });

    const normalized = normalizeResponse(response);
    if (!normalized.success) {
      logProviderError('purchaseData', { message: normalized.message, response: { data: response.data, status: response.status } });
    }
    return normalized;
  } catch (error) {
    logProviderError('purchaseData', error);
    return normalizeFailure(error);
  }
}

module.exports = {
  purchaseData,
  SuperCheapDataError
};
