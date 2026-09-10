'use strict';

/**
 * lib/transactions.js
 * ---------------------------------------------------------------------
 * Reusable transaction module for VTU purchases (data, airtime, voice,
 * cable, electricity) and wallet funding records.
 *
 * Lifecycle:
 *   1. createPendingTransaction()  -> debits wallet, inserts a 'pending'
 *      transaction row linked to the wallet_history entry.
 *   2. markSuccessful()            -> transitions pending -> success.
 *   3. markFailed()                -> transitions pending -> failed and
 *      automatically refunds the debited amount.
 *   4. refundTransaction()         -> reverses an already-successful
 *      transaction on demand (e.g. admin-initiated reversal).
 *
 * Duplicate processing is prevented at two layers:
 *   - Wallet debits are idempotent on reference (see wallet.js), so a
 *     retried createPendingTransaction() call with the same
 *     idempotencyKey never charges the wallet twice.
 *   - Status transitions use conditional updates (`.eq('status', 'pending')`)
 *     so two concurrent webhook/callback deliveries can't both apply a
 *     success/failure transition to the same transaction.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY env vars
 * (via lib/supabaseAdmin.js).
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('./supabaseAdmin');
const wallet = require('./wallet');

class TransactionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransactionError';
    this.code = code || 'TRANSACTION_ERROR';
  }
}

class DuplicateTransactionError extends TransactionError {
  constructor(message) {
    super(message || 'This transaction has already been processed', 'DUPLICATE_TRANSACTION');
  }
}

class InvalidStateTransitionError extends TransactionError {
  constructor(message) {
    super(message || 'Transaction is not in a state that allows this action', 'INVALID_STATE');
  }
}

const VALID_TYPES = ['data', 'airtime', 'voice', 'cable', 'electricity', 'wallet_funding'];

function assertValidType(type) {
  if (!VALID_TYPES.includes(type)) {
    throw new TransactionError(`Invalid transaction type: ${type}`, 'INVALID_TYPE');
  }
}

/**
 * Fetch a transaction by id. Throws if not found.
 *
 * @param {string} transactionId
 * @returns {Promise<Object>}
 */
async function getTransactionById(transactionId) {
  if (!transactionId) {
    throw new TransactionError('transactionId is required', 'INVALID_INPUT');
  }

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .single();

  if (error || !data) {
    throw new TransactionError(`Transaction not found: ${transactionId}`, 'NOT_FOUND');
  }

  return data;
}

/**
 * Look up an existing transaction by its idempotency key, if any.
 * The idempotency key is stored inside request_payload.idempotencyKey.
 */
async function findByIdempotencyKey(userId, idempotencyKey) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .eq('request_payload->>idempotencyKey', idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new TransactionError(`Idempotency lookup failed: ${error.message}`, 'DB_ERROR');
  }

  return data || null;
}

/**
 * Create a pending transaction. Debits the wallet first (atomically,
 * via wallet.js) and links the resulting wallet_history entry.
 *
 * If a transaction already exists for the given idempotencyKey, that
 * existing transaction is returned instead of creating/debiting again
 * — safe to call repeatedly for retried client requests.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.type            - one of VALID_TYPES
 * @param {string} [params.planId]        - FK into the relevant *_plans table
 * @param {string} [params.network]       - network / disco / cable provider
 * @param {string} [params.recipient]     - phone number / meter number / smartcard number
 * @param {number} params.amount          - amount charged to the wallet
 * @param {number} [params.costPrice]     - upstream provider cost (for profit tracking)
 * @param {string} params.idempotencyKey  - unique key supplied by the caller (e.g. request id)
 * @param {Object} [params.requestPayload] - extra request metadata to store
 * @returns {Promise<Object>} the transaction row
 */
async function createPendingTransaction({
  userId,
  type,
  planId,
  network,
  recipient,
  amount,
  costPrice,
  idempotencyKey,
  requestPayload
}) {
  if (!userId) throw new TransactionError('userId is required', 'INVALID_INPUT');
  if (!idempotencyKey) throw new TransactionError('idempotencyKey is required', 'INVALID_INPUT');
  assertValidType(type);

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new TransactionError('amount must be a positive number', 'INVALID_AMOUNT');
  }

  // Idempotency check: return the existing transaction rather than
  // creating a duplicate + double-debiting the wallet.
  const existing = await findByIdempotencyKey(userId, idempotencyKey);
  if (existing) {
    return existing;
  }

  // Wallet funding transactions don't debit the wallet — they credit it
  // elsewhere (payment gateway webhook), so skip the debit step here.
  let walletHistoryId = null;

  if (type !== 'wallet_funding') {
    const debit = await wallet.debitWallet({
      userId,
      amount,
      source: 'purchase',
      description: `${type} purchase`,
      reference: `PURCHASE-${idempotencyKey}`
    });
    walletHistoryId = debit.walletHistoryId;
  }

  const payload = Object.assign({ idempotencyKey }, requestPayload || {});

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .insert({
      user_id: userId,
      type,
      plan_id: planId || null,
      network: network || null,
      recipient: recipient || null,
      amount,
      cost_price: typeof costPrice === 'number' ? costPrice : null,
      status: 'pending',
      request_payload: payload,
      wallet_history_id: walletHistoryId
    })
    .select()
    .single();

  if (error) {
    // The wallet was already debited (idempotently) — if the insert
    // fails, refund immediately so the user isn't charged for nothing.
    if (walletHistoryId) {
      await wallet.refundDebit({
        userId,
        amount,
        originalReference: `PURCHASE-${idempotencyKey}`,
        description: `Refund: failed to record transaction (${error.message})`
      });
    }
    throw new TransactionError(`Failed to create transaction: ${error.message}`, 'DB_ERROR');
  }

  return data;
}

/**
 * Transition a pending transaction to 'success'.
 * No-op (returns the current row) if it has already left 'pending' —
 * this makes it safe to call from a provider webhook that might fire
 * more than once for the same event.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} [params.providerReference]
 * @param {Object} [params.responsePayload]
 * @returns {Promise<Object>} the updated (or already-processed) transaction row
 */
async function markSuccessful({ transactionId, providerReference, responsePayload }) {
  if (!transactionId) throw new TransactionError('transactionId is required', 'INVALID_INPUT');

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'success',
      provider_reference: providerReference || null,
      response_payload: responsePayload || null
    })
    .eq('id', transactionId)
    .eq('status', 'pending') // guard: only a pending transaction can become successful
    .select()
    .maybeSingle();

  if (error) {
    throw new TransactionError(`Failed to mark transaction successful: ${error.message}`, 'DB_ERROR');
  }

  if (!data) {
    // Either it doesn't exist, or it already transitioned away from
    // 'pending' — fetch and return the current state instead of erroring,
    // so duplicate webhook deliveries are harmless.
    return getTransactionById(transactionId);
  }

  return data;
}

/**
 * Transition a pending transaction to 'failed' and automatically
 * refund the amount that was debited when it was created.
 * No-op (returns the current row) if it has already left 'pending'.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} [params.reason]
 * @param {Object} [params.responsePayload]
 * @returns {Promise<Object>} the updated (or already-processed) transaction row
 */
async function markFailed({ transactionId, reason, responsePayload }) {
  if (!transactionId) throw new TransactionError('transactionId is required', 'INVALID_INPUT');

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'failed',
      response_payload: Object.assign({ reason: reason || null }, responsePayload || {})
    })
    .eq('id', transactionId)
    .eq('status', 'pending') // guard: only a pending transaction can be marked failed
    .select()
    .maybeSingle();

  if (error) {
    throw new TransactionError(`Failed to mark transaction failed: ${error.message}`, 'DB_ERROR');
  }

  if (!data) {
    // Already processed by a previous call — don't refund twice.
    return getTransactionById(transactionId);
  }

  // Refund the wallet, if this transaction had debited it.
  if (data.wallet_history_id && data.type !== 'wallet_funding') {
    const idempotencyKey = data.request_payload && data.request_payload.idempotencyKey;
    const originalReference = idempotencyKey
      ? `PURCHASE-${idempotencyKey}`
      : `TXN-${transactionId}`;

    await wallet.refundDebit({
      userId: data.user_id,
      amount: Number(data.amount),
      originalReference,
      description: `Refund for failed ${data.type} transaction (${reason || 'no reason given'})`
    });
  }

  return data;
}

/**
 * Reverse an already-successful transaction on demand (e.g. an admin
 * correcting a wrongly-completed purchase). Credits the wallet back
 * and marks the transaction 'reversed'. No-op if it isn't currently
 * 'success'.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} [params.reason]
 * @returns {Promise<Object>} the updated (or unchanged) transaction row
 */
async function refundTransaction({ transactionId, reason }) {
  if (!transactionId) throw new TransactionError('transactionId is required', 'INVALID_INPUT');

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'reversed',
      response_payload: { reversal_reason: reason || null }
    })
    .eq('id', transactionId)
    .eq('status', 'success') // guard: only a successful transaction can be reversed
    .select()
    .maybeSingle();

  if (error) {
    throw new TransactionError(`Failed to reverse transaction: ${error.message}`, 'DB_ERROR');
  }

  if (!data) {
    const current = await getTransactionById(transactionId);
    if (current.status !== 'reversed') {
      throw new InvalidStateTransitionError(
        `Cannot reverse transaction in status '${current.status}'`
      );
    }
    return current; // already reversed — idempotent no-op
  }

  if (data.type !== 'wallet_funding') {
    const idempotencyKey = data.request_payload && data.request_payload.idempotencyKey;
    const originalReference = idempotencyKey
      ? `PURCHASE-${idempotencyKey}`
      : `TXN-${transactionId}`;

    await wallet.refundDebit({
      userId: data.user_id,
      amount: Number(data.amount),
      originalReference,
      description: `Reversal of successful ${data.type} transaction (${reason || 'no reason given'})`
    });
  }

  return data;
}

/**
 * List recent transactions for a user (used by the Transactions screen).
 *
 * @param {string} userId
 * @param {Object} [options]
 * @param {number} [options.limit=20]
 * @param {number} [options.offset=0]
 * @param {string} [options.status]
 * @param {string} [options.type]
 */
async function listUserTransactions(userId, options = {}) {
  if (!userId) throw new TransactionError('userId is required', 'INVALID_INPUT');

  const { limit = 20, offset = 0, status, type } = options;

  let query = supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (type) query = query.eq('type', type);

  const { data, error } = await query;

  if (error) {
    throw new TransactionError(`Failed to list transactions: ${error.message}`, 'DB_ERROR');
  }

  return data;
}

/**
 * Flag a transaction for manual admin review — used when a provider's
 * webhook reports a DIFFERENT outcome than what we already recorded
 * (e.g. we marked something 'failed' and refunded the wallet, but the
 * provider's webhook later says it was actually delivered
 * successfully). This never moves money by itself — it only makes the
 * discrepancy visible in admin.html so a human decides what to do.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} params.note
 */
async function flagForReconciliation({ transactionId, note }) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({ reconciliation_note: note })
    .eq('id', transactionId)
    .select()
    .maybeSingle();

  if (error) {
    throw new TransactionError(`Failed to flag transaction for reconciliation: ${error.message}`, 'DB_ERROR');
  }
  return data;
}

/**
 * Admin-confirmed reconciliation: a transaction we marked 'failed'
 * (and therefore already refunded) turned out to have actually
 * succeeded with the provider. Re-debits the wallet for the same
 * amount and flips the transaction to 'success'. Only callable on a
 * transaction currently in 'failed' status — never overwrites a
 * transaction that's already 'success'/'reversed'/'pending'.
 *
 * This is NOT called automatically by any webhook — only by an
 * explicit admin action (see api/admin/reconcile-transaction.js),
 * since re-charging a customer's wallet without a human confirming it
 * first is too risky to do silently.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} [params.providerReference]
 * @param {Object} [params.responsePayload]
 * @returns {Promise<Object>} the updated transaction row
 */
async function reconcileFailedToSuccess({ transactionId, providerReference, responsePayload }) {
  const txn = await getTransactionById(transactionId);

  if (txn.status !== 'failed') {
    throw new InvalidStateTransitionError(
      `Cannot reconcile transaction in status '${txn.status}' — only a 'failed' transaction can be reconciled to success`
    );
  }

  // Deterministic reference keeps this idempotent — retrying the same
  // reconciliation twice won't double-charge.
  const reconcileRef = `RECONCILE-${transactionId}`;

  await wallet.debitWallet({
    userId: txn.user_id,
    amount: Number(txn.amount),
    source: 'purchase',
    description: 'Reconciliation: provider confirmed successful delivery after this transaction was incorrectly refunded',
    reference: reconcileRef
  });

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'success',
      provider_reference: providerReference || txn.provider_reference,
      response_payload: responsePayload || txn.response_payload,
      reconciliation_note: null
    })
    .eq('id', transactionId)
    .eq('status', 'failed')
    .select()
    .maybeSingle();

  if (error) {
    throw new TransactionError(`Failed to reconcile transaction: ${error.message}`, 'DB_ERROR');
  }
  if (!data) {
    throw new InvalidStateTransitionError('Transaction was no longer in failed state when reconciliation ran (concurrent update?)');
  }
  return data;
}

module.exports = {
  TransactionError,
  DuplicateTransactionError,
  InvalidStateTransitionError,
  VALID_TYPES,
  getTransactionById,
  findByIdempotencyKey,
  createPendingTransaction,
  markSuccessful,
  markFailed,
  refundTransaction,
  listUserTransactions,
  flagForReconciliation,
  reconcileFailedToSuccess
};
