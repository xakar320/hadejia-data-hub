'use strict';

/**
 * lib/wallet.js
 * ---------------------------------------------------------------------
 * Reusable wallet module: atomic debit/credit against the Supabase
 * `users.wallet_balance` + `wallet_history` ledger.
 *
 * All money movement goes through the Postgres RPC functions
 * `wallet_debit` / `wallet_credit` (see 02_wallet_functions.sql), which
 * lock the user's row and update balance + ledger in one atomic step.
 * This module never mutates wallet_balance directly with a plain
 * select-then-update — that pattern is unsafe under concurrent
 * requests (two simultaneous purchases could both pass a balance
 * check before either debit lands).
 *
 * Every debit/credit call is idempotent on `reference`: retrying the
 * same reference (e.g. a duplicate webhook or retried request) returns
 * the original result instead of moving money twice.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY env vars
 * (via lib/supabaseAdmin.js).
 * ---------------------------------------------------------------------
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabaseAdmin');

class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WalletError';
    this.code = code || 'WALLET_ERROR';
  }
}

class InsufficientFundsError extends WalletError {
  constructor(message) {
    super(message || 'Insufficient wallet balance', 'INSUFFICIENT_FUNDS');
  }
}

const VALID_SOURCES = [
  'card_funding',
  'bank_transfer',
  'dynamic_account',
  'admin_credit',
  'admin_debit',
  'purchase',
  'refund',
  'referral_bonus'
];

/**
 * Generate a unique, human-traceable wallet reference.
 * Format: WAL-<prefix>-<timestamp base36>-<random hex>
 */
function generateReference(prefix = 'TXN') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `WAL-${prefix}-${ts}-${rand}`;
}

function assertValidAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new WalletError('Amount must be a positive number', 'INVALID_AMOUNT');
  }
}

function assertValidSource(source) {
  if (!VALID_SOURCES.includes(source)) {
    throw new WalletError(`Invalid wallet source: ${source}`, 'INVALID_SOURCE');
  }
}

function mapRpcError(error) {
  const msg = error && error.message ? error.message : 'Unknown wallet error';

  if (msg.includes('INSUFFICIENT_FUNDS')) {
    return new InsufficientFundsError();
  }
  if (msg.includes('USER_NOT_FOUND')) {
    return new WalletError('User not found', 'USER_NOT_FOUND');
  }
  if (msg.includes('INVALID_AMOUNT')) {
    return new WalletError('Invalid amount', 'INVALID_AMOUNT');
  }
  if (msg.includes('INVALID_REFERENCE')) {
    return new WalletError('Invalid reference', 'INVALID_REFERENCE');
  }
  return new WalletError(msg, 'WALLET_RPC_ERROR');
}

/**
 * Fetch the current wallet balance for a user.
 *
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function getBalance(userId) {
  if (!userId) throw new WalletError('userId is required', 'INVALID_USER');

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('wallet_balance')
    .eq('id', userId)
    .single();

  if (error) {
    throw new WalletError(`Failed to fetch balance: ${error.message}`, 'DB_ERROR');
  }

  return Number(data.wallet_balance);
}

/**
 * Debit a user's wallet atomically. Throws InsufficientFundsError if
 * the balance is too low.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {number} params.amount
 * @param {string} params.source        - one of VALID_SOURCES
 * @param {string} [params.description]
 * @param {string} [params.reference]   - idempotency key; auto-generated if omitted
 * @returns {Promise<{walletHistoryId: string, balanceBefore: number, balanceAfter: number, reference: string}>}
 */
async function debitWallet({ userId, amount, source, description, reference }) {
  if (!userId) throw new WalletError('userId is required', 'INVALID_USER');
  assertValidAmount(amount);
  assertValidSource(source);

  const ref = reference || generateReference('DR');

  const { data, error } = await supabaseAdmin.rpc('wallet_debit', {
    p_user_id: userId,
    p_amount: amount,
    p_source: source,
    p_description: description || null,
    p_reference: ref
  });

  if (error) throw mapRpcError(error);

  const row = Array.isArray(data) ? data[0] : data;

  return {
    walletHistoryId: row.wallet_history_id,
    balanceBefore: Number(row.balance_before),
    balanceAfter: Number(row.balance_after),
    reference: ref
  };
}

/**
 * Credit a user's wallet atomically.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {number} params.amount
 * @param {string} params.source        - one of VALID_SOURCES
 * @param {string} [params.description]
 * @param {string} [params.reference]   - idempotency key; auto-generated if omitted
 * @returns {Promise<{walletHistoryId: string, balanceBefore: number, balanceAfter: number, reference: string}>}
 */
async function creditWallet({ userId, amount, source, description, reference }) {
  if (!userId) throw new WalletError('userId is required', 'INVALID_USER');
  assertValidAmount(amount);
  assertValidSource(source);

  const ref = reference || generateReference('CR');

  const { data, error } = await supabaseAdmin.rpc('wallet_credit', {
    p_user_id: userId,
    p_amount: amount,
    p_source: source,
    p_description: description || null,
    p_reference: ref
  });

  if (error) throw mapRpcError(error);

  const row = Array.isArray(data) ? data[0] : data;

  return {
    walletHistoryId: row.wallet_history_id,
    balanceBefore: Number(row.balance_before),
    balanceAfter: Number(row.balance_after),
    reference: ref
  };
}

/**
 * Reverse a previous debit (e.g. a failed VTU purchase after the
 * wallet was already charged) by crediting the same amount back.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {number} params.amount
 * @param {string} params.originalReference - the debit reference being reversed
 * @param {string} [params.description]
 * @returns {Promise<{walletHistoryId: string, balanceBefore: number, balanceAfter: number, reference: string}>}
 */
async function refundDebit({ userId, amount, originalReference, description }) {
  if (!originalReference) {
    throw new WalletError('originalReference is required for a refund', 'INVALID_REFERENCE');
  }

  return creditWallet({
    userId,
    amount,
    source: 'refund',
    description: description || `Refund for ${originalReference}`,
    // Deterministic reference means retrying a refund for the same
    // debit is also idempotent, not just the original debit itself.
    reference: `REFUND-${originalReference}`
  });
}

module.exports = {
  WalletError,
  InsufficientFundsError,
  VALID_SOURCES,
  generateReference,
  getBalance,
  debitWallet,
  creditWallet,
  refundDebit
};
