'use strict';

/**
 * lib/plinno.js
 * ---------------------------------------------------------------------
 * Plinno API client — a third data provider alongside AutosyncNG and
 * SuperCheapData (lib/autosync.js / lib/supercheapdata.js).
 *
 * ⚠️ UNCONFIRMED — built from instruction, not a live test call.
 * Unlike lib/supercheapdata.js's header (which documents an actual
 * confirmed request/response from a real purchase), this file was
 * written on the instruction that Plinno's API has "the exact same
 * structure as SuperCheapData" — so every assumption below (endpoint
 * path, body field names, response shape, the "always HTTP 200"
 * quirk) is COPIED from SuperCheapData's confirmed behavior, not
 * independently verified against Plinno. Test with one real purchase
 * once deployed, and send back:
 *   1. The exact request that was sent (this code logs it on failure)
 *   2. The exact raw response body Plinno returned
 * so this file can be corrected to match reality, the same way
 * lib/autosync.js and lib/supercheapdata.js were.
 *
 * This module's ONLY responsibility is talking to Plinno over HTTP —
 * it does not touch the wallet, does not write transactions, and does
 * not know about Supabase, mirroring lib/supercheapdata.js's
 * separation of concerns. It returns the EXACT SAME normalized
 * response shape as lib/autosync.js's callProvider(), so
 * lib/orderService.js can call any of the three providers
 * interchangeably.
 *
 * -----------------------------------------------------------------
 * ASSUMED (copied from SuperCheapData's confirmed shape — VERIFY):
 * -----------------------------------------------------------------
 * Base URL:    https://ruhuufundsdata.plinno.com/api
 * Auth header: Authorization: Bearer <Plinno API token>
 *              (also requires Content-Type: application/json)
 *
 * POST /data
 *   body: { network_type, plan_id, phone_number, transaction_id }
 *     - transaction_id assumed alphanumeric-only, same as SuperCheapData.
 *
 * *** ASSUMED: HTTP status is ALWAYS 200, even on failure (per SuperCheapData). ***
 *   Success: { "status": "successful", "message": "...", "purchase_amount": 310,
 *              "wallet_before": ..., "wallet_after": ..., "reference": "...", "api_response": "..." }
 *   Failure: { "status": false, "message": "..." }
 *
 * The ONLY success signal used is body.status === 'successful' (exact
 * string) — HTTP status code is NOT used to determine success/failure.
 * -----------------------------------------------------------------
 *
 * Required environment variables (server-side only):
 *   PLINNO_API_KEY   token from Plinno's dashboard/profile page
 * ---------------------------------------------------------------------
 */

const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.PLINNO_API_KEY;
const BASE_URL = 'https://ruhuufundsdata.plinno.com/api';
const REQUEST_TIMEOUT_MS = 20000;

if (!API_KEY) {
  throw new Error('Missing required env var: PLINNO_API_KEY');
}

class PlinnoError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.name = 'PlinnoError';
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
  // See header note: assumed (copied from SuperCheapData) that Plinno
  // may also return 200 on business-logic failure, so we inspect the
  // body rather than relying on the HTTP status. This still guards
  // against a genuine 4xx/5xx from their infrastructure.
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
  console.error('[Plinno] Provider error:', JSON.stringify(details));
}

/**
 * transaction_id assumed alphanumeric-only (copied from SuperCheapData
 * — verify against Plinno). Base36 timestamp + random hex keeps it
 * short, unique, and free of any punctuation.
 */
function generateTransactionId(prefix = 'HDH') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}${ts}${rand}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Normalize a Plinno response into the exact same shape
 * lib/autosync.js's callProvider() returns, so orderService.js can
 * treat all three providers identically.
 */
function normalizeResponse(response) {
  const body = (response && response.data) || {};

  // ASSUMED success signal (copied from SuperCheapData) — verify.
  const success = body.status === 'successful';

  return {
    success,
    status: success ? 'successful' : 'failed',
    statusCode: response ? response.status : null,
    message: body.message || (success ? 'Purchase successful' : 'Plinno request failed'),
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
    (error.code === 'ECONNABORTED' ? 'Plinno request timed out' : null) ||
    error.message ||
    'Plinno request failed';

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
    // A timeout means Plinno never responded at all — we genuinely
    // don't know if the purchase went through. orderService.js uses
    // these flags to leave the transaction 'pending' instead of
    // refunding on a guess.
    isTimeout: error.code === 'ECONNABORTED',
    isNetworkError: !error.response && !!error.request,
    data: null,
    raw: body
  };
}

/**
 * Purchase a data bundle via Plinno.
 *
 * IMPORTANT — SAFETY: never retried automatically on failure/timeout,
 * for the same reason as lib/supercheapdata.js#purchaseData: a timeout
 * is ambiguous (the purchase may have gone through on Plinno's side),
 * so silently retrying could cause a double charge.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.networkType  - assumed Plinno's network_type (e.g. "mtn_dt")
 * @param {string} params.planId       - assumed Plinno's plan_id
 * @param {string} [params.reference]  - your own transaction_id; auto-generated (alphanumeric) if omitted
 */
async function purchaseData({ phone, networkType, planId, reference }) {
  if (!networkType) {
    throw new PlinnoError('networkType is required', { code: 'INVALID_INPUT' });
  }
  if (!planId) {
    throw new PlinnoError('planId is required', { code: 'INVALID_INPUT' });
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
  PlinnoError
};
