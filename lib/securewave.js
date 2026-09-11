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

/**
 * Generate a permanent Static Virtual Account for a user — confirmed
 * from SecureWaveNG's docs as a SEPARATE endpoint from Dynamic
 * Accounts, and requires BVN verification (id_type/id_number).
 *
 * IMPORTANT: the BVN is sent to SecureWaveNG for verification only —
 * this function does not store it anywhere, and callers must not
 * persist it either (see api/static-account-init.js).
 *
 * Maps to: POST {baseURL}/virtual_accounts/generate
 *   Body: {
 *     email, first_name, last_name, phone_number,
 *     bank_code: [1,2,3],   // kolomoni:1, wema:2, safehaven:3
 *     business_id, account_type: "static", id_type: "bvn", id_number
 *   }
 *   Response: {
 *     status: true,
 *     message: "N out of M virtual account(s) generated",
 *     data: [{ account_number, bank_code, account_name, account_bank,
 *              account_email, account_reference, status }, ...]
 *   }
 * NOTE: SecureWaveNG can partially succeed (e.g. "2 out of 3") — this
 * function returns every account that came back with status truthy,
 * so the caller can decide how to handle a partial result.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.firstName
 * @param {string} params.lastName
 * @param {string} params.phone
 * @param {string} params.bvn - 11-digit Bank Verification Number
 * @returns {Promise<Array<{accountNumber, bankName, accountName, reference}>>}
 */
async function generateStaticAccount({ email, firstName, lastName, phone, bvn }) {
  try {
    const response = await httpClient.post('/virtual_accounts/generate', {
      email,
      first_name: firstName,
      last_name: lastName,
      phone_number: phone,
      bank_code: [3], // Safehaven only for now — keep in sync with generateDynamicAccount
      business_id: BUSINESS_ID,
      account_type: 'static',
      id_type: 'bvn',
      id_number: bvn
    });

    const body = response.data;

    if (!body || body.status !== true || !Array.isArray(body.data)) {
      throw new SecurewaveError(
        (body && body.message) || 'SecureWaveNG did not return any virtual accounts',
        { statusCode: response.status, raw: body, code: 'GENERATION_FAILED' }
      );
    }

    const accounts = body.data
      .filter((a) => a && a.account_number)
      .map((a) => ({
        accountNumber: a.account_number,
        bankName: a.account_bank,
        accountName: a.account_name,
        reference: a.account_reference
      }));

    if (accounts.length === 0) {
      throw new SecurewaveError(body.message || 'No virtual accounts were generated — check the BVN and try again', {
        statusCode: response.status,
        raw: body,
        code: 'GENERATION_FAILED'
      });
    }

    return accounts;
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;

    logProviderError('generateStaticAccount', error);

    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

/**
 * List all banks SecureWaveNG supports for customer withdrawals, with
 * their bank_code (needed for validateAccountName/saveCustomerBankInfo).
 * Maps to: GET {baseURL}/banks
 */
async function getBanks() {
  try {
    const response = await httpClient.get('/banks');
    const body = response.data;

    if (!body || body.status !== true || !Array.isArray(body.data)) {
      throw new SecurewaveError((body && body.message) || 'SecureWaveNG did not return a bank list', {
        statusCode: response.status,
        raw: body,
        code: 'BANKS_FETCH_FAILED'
      });
    }

    return body.data.map((b) => ({ id: b.id, name: b.name, bankCode: b.bank_code }));
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;
    logProviderError('getBanks', error);
    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

/**
 * Look up the bank account a customer has on file for withdrawals.
 * Maps to: GET {baseURL}/customer_withdrawals/bank-info
 * (SecureWaveNG's docs show this as a GET request carrying a JSON
 * body — non-standard, but that's what their API expects, so this
 * uses httpClient.request() to send a body alongside a GET.)
 *
 * @returns {Promise<Object|null>} null if the customer has no bank info saved yet
 */
async function getCustomerBankInfo(email) {
  try {
    const response = await httpClient.request({
      method: 'GET',
      url: '/customer_withdrawals/bank-info',
      data: { customer_email: email }
    });

    const body = response.data;
    if (!body || body.status !== true || !body.data) return null;

    return {
      bankName: body.data.bank_name,
      accountNumber: body.data.account_number,
      accountName: body.data.account_name,
      bankCode: body.data.bank_code
    };
  } catch (error) {
    // A 404 / "not found" here just means no bank info saved yet.
    if (error.response && [404, 400].includes(error.response.status)) {
      return null;
    }
    logProviderError('getCustomerBankInfo', error);
    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

/**
 * Save (or overwrite) the bank account a customer withdraws to.
 * Maps to: POST {baseURL}/customer_withdrawals/bank-info
 */
async function saveCustomerBankInfo({ email, bankName, accountName, bankCode, accountNumber }) {
  try {
    const response = await httpClient.post('/customer_withdrawals/bank-info', {
      customer_email: email,
      bank_name: bankName,
      account_name: accountName,
      bank_code: bankCode,
      account_number: accountNumber
    });

    const body = response.data;
    if (!body || body.status !== true || !body.data) {
      throw new SecurewaveError((body && body.message) || 'Failed to save bank info', {
        statusCode: response.status,
        raw: body,
        code: 'SAVE_BANK_INFO_FAILED'
      });
    }

    return {
      bankName: body.data.bank_name,
      accountNumber: body.data.account_number,
      accountName: body.data.account_name,
      bankCode: body.data.bank_code
    };
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;
    logProviderError('saveCustomerBankInfo', error);
    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

/**
 * Confirm the account name for a bank_code + account_number before
 * saving it, so the customer can see whose account they're about to
 * withdraw to.
 * Maps to: POST {baseURL}/customer_withdrawals/validate-account-name
 */
async function validateAccountName({ bankCode, accountNumber }) {
  try {
    const response = await httpClient.post('/customer_withdrawals/validate-account-name', {
      bank_code: bankCode,
      account_number: accountNumber
    });

    const body = response.data;
    if (!body || body.status !== true || !body.data) {
      throw new SecurewaveError((body && body.message) || 'Could not verify that account', {
        statusCode: response.status,
        raw: body,
        code: 'VALIDATION_FAILED'
      });
    }

    return { accountName: body.data.account_name, accountNumber: body.data.account_number };
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;
    logProviderError('validateAccountName', error);
    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

/**
 * Withdraw funds to the bank account the customer has on file.
 * Maps to: POST {baseURL}/customer_withdrawals/withdraw
 *
 * NOTE: SecureWaveNG's shared docs did not show the request body for
 * this endpoint (their example curl sends no --data-raw at all). This
 * sends the fields that match every other endpoint in this same
 * folder (customer_email + amount + narration) as the most likely
 * shape — confirm against a real test withdrawal and adjust here if
 * SecureWaveNG expects different field names.
 *
 * Their example response shows the withdrawal is accepted and
 * "being processed" rather than completed instantly — treat a
 * successful call here as PENDING, not as money already delivered.
 */
async function customerWithdraw({ email, amount, narration }) {
  try {
    const response = await httpClient.post('/customer_withdrawals/withdraw', {
      customer_email: email,
      amount,
      narration: narration || 'Customer withdrawal'
    });

    const body = response.data;
    if (!body || body.status !== true) {
      throw new SecurewaveError((body && body.message) || 'Withdrawal request failed', {
        statusCode: response.status,
        raw: body,
        code: 'WITHDRAW_FAILED'
      });
    }

    const inner = (body.data && body.data.data) || body.data || {};

    return {
      reference: inner.reference || null,
      amount: inner.amount != null ? Number(inner.amount) : Number(amount),
      message: body.message || (body.data && body.data.message) || 'Withdrawal request received',
      raw: body
    };
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;
    logProviderError('customerWithdraw', error);
    const body = error.response && error.response.data;
    throw new SecurewaveError((body && body.message) || error.message || 'SecureWaveNG request failed', {
      statusCode: error.response ? error.response.status : null,
      raw: body || null,
      code: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'REQUEST_FAILED'
    });
  }
}

/**
 * Fetch a customer's withdrawal/funding wallet log from SecureWaveNG
 * (their own ledger, separate from our app's wallet_history) — useful
 * for reconciling a "processing" withdrawal later.
 * Maps to: GET {baseURL}/customer_withdrawals/wallet-logs/{email}
 */
async function getCustomerWalletLogs(email, page = 1) {
  try {
    const response = await httpClient.get(`/customer_withdrawals/wallet-logs/${encodeURIComponent(email)}`, {
      params: { page }
    });

    const body = response.data;
    if (!body || body.status !== true || !body.data) {
      throw new SecurewaveError((body && body.message) || 'Failed to fetch wallet logs', {
        statusCode: response.status,
        raw: body,
        code: 'WALLET_LOGS_FAILED'
      });
    }

    return body.data;
  } catch (error) {
    if (error instanceof SecurewaveError) throw error;
    logProviderError('getCustomerWalletLogs', error);
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
  generateDynamicAccount,
  generateStaticAccount,
  getBanks,
  getCustomerBankInfo,
  saveCustomerBankInfo,
  validateAccountName,
  customerWithdraw,
  getCustomerWalletLogs
};
