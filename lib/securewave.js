'use strict';

/**
 * lib/securewave.js
 * ---------------------------------------------------------------------
 * SecureWaveNG API client for Dynamic Virtual Accounts, confirmed
 * directly from their Postman documentation (shared by the project
 * owner, not from a generic guess).
 *
 * Confirmed endpoint:
 *   POST {baseURL}/dynamic_accounts/generate
 *   Headers: Accept, Content-Type, Authorization: Bearer {secret},
 *            x-api-key: {public key}
 *   Body: {
 *     email, first_name, last_name, phone_number,
 *     bank_code: [3],           // Safehaven — the only bank confirmed
 *                                 to support "dynamic" account_type
 *     business_id, account_type: "dynamic", amount
 *   }
 *   Response: {
 *     status: true,
 *     message: "Dynamic account successfully generated",
 *     data: [{
 *       account_number, bank_code, account_name, account_bank,
 *       account_email, account_reference, category, amount_to_pay,
 *       expires (seconds), status
 *     }]
 *   }
 *
 * This module's only job is talking to SecureWaveNG — it does not
 * touch the wallet or write transactions. api/fund-wallet-init.js
 * orchestrates: generateDynamicAccount() -> transactions.createPendingTransaction()
 * -> store the account in dynamic_accounts for the webhook to match
 * against later.
 *
 * Required environment variables:
 *   SECUREWAVE_API_URL      defaults to https://securewaveng.com/api
 *   SECUREWAVE_SECRET_KEY   Bearer token (server-only)
 *   SECUREWAVE_PUBLIC_KEY   x-api-key value
 *   SECUREWAVE_BUSINESS_ID  your SecureWaveNG business_id
 * ---------------------------------------------------------------------
 */

const axios = require('axios');

const API_URL = process.env.SECUREWAVE_API_URL || 'https://securewaveng.com/api';
const SECRET_KEY = process.env.SECUREWAVE_SECRET_KEY;
const PUBLIC_KEY = process.env.SECUREWAVE_PUBLIC_KEY;
const BUSINESS_ID = process.env.SECUREWAVE_BUSINESS_ID;

if (!SECRET_KEY || !PUBLIC_KEY || !BUSINESS_ID) {
  throw new Error(
    'Missing required env vars: SECUREWAVE_SECRET_KEY, SECUREWAVE_PUBLIC_KEY, and/or SECUREWAVE_BUSINESS_ID'
  );
}

const REQUEST_TIMEOUT_MS = 15000;

const httpClient = axios.create({
  baseURL: API_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SECRET_KEY}`,
    'x-api-key': PUBLIC_KEY
  }
});

class SecurewaveError extends Error {
  constructor(message, { statusCode = null, raw = null, code = 'SECUREWAVE_ERROR' } = {}) {
    super(message);
    this.name = 'SecurewaveError';
    this.code = code;
    this.statusCode = statusCode;
    this.raw = raw;
  }
}

function logProviderError(context, error) {
  const details = {
    context,
    message: error.message,
    statusCode: error.response ? error.response.status : null,
    responseData: error.response ? error.response.data : null,
    isTimeout: error.code === 'ECONNABORTED',
    isNetworkError: !error.response && !!error.request
  };
  // eslint-disable-next-line no-console
  console.error('[SecureWaveNG] Provider error:', JSON.stringify(details));
}

/**
 * Generate a single-use Dynamic Virtual Account for one wallet-funding
 * attempt. The account expires after `expiresInSeconds` (SecureWaveNG
 * returned 900 = 15 minutes in their example) or once paid.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.firstName
 * @param {string} params.lastName
 * @param {string} params.phone
 * @param {number} params.amount - amount in Naira (NOT kobo — confirmed
 *   from SecureWaveNG's own example requests, which pass small values
 *   like 120/150 directly as Naira)
 * @returns {Promise<{
 *   accountNumber: string, bankName: string, accountName: string,
 *   reference: string, amountToPay: number, expiresInSeconds: number,
 *   raw: object
 * }>}
 */
async function generateDynamicAccount({ email, firstName, lastName, phone, amount }) {
  try {
    const response = await httpClient.post('/dynamic_accounts/generate', {
      email,
      first_name: firstName,
      last_name: lastName,
      phone_number: phone,
      bank_code: [3], // Safehaven — only bank confirmed for account_type: "dynamic"
      business_id: BUSINESS_ID,
      account_type: 'dynamic',
      amount
    });

    const body = response.data;

    if (!body || body.status !== true || !Array.isArray(body.data) || body.data.length === 0) {
      throw new SecurewaveError(
        (body && body.message) || 'SecureWaveNG did not return a virtual account',
        { statusCode: response.status, raw: body, code: 'GENERATION_FAILED' }
      );
    }

    const account = body.data[0];

    if (!account || !account.account_number) {
      throw new SecurewaveError('SecureWaveNG returned an incomplete account object', {
        statusCode: response.status,
        raw: body,
        code: 'GENERATION_FAILED'
      });
    }

    return {
      accountNumber: account.account_number,
      bankName: account.account_bank,
      accountName: account.account_name,
      reference: account.account_reference,
      amountToPay: Number(account.amount_to_pay),
      expiresInSeconds: Number(account.expires) || 900,
      raw: body
    };
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;

    logProviderError('generateDynamicAccount', error);

    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

module.exports = {
  SecurewaveError,
  generateDynamicAccount
};
