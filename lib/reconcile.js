'use strict';

/**
 * lib/reconcile.js
 * ---------------------------------------------------------------------
 * Resolves 'pending' transactions to a final state by asking the
 * provider what really happened — instead of waiting hours for the
 * once-a-day cron.
 *
 * Called from three places (all safe to run at the same time, every
 * state change is a guarded conditional update):
 *   - api/cron/reconcile-failed-transactions.js (external pinger, every ~2 min)
 *   - api/webhook.js (AutosyncNG pushed a status for a bundle part)
 *   - api/place-order.js?action=check-pending (customer has the
 *     Transactions page open and an order is still pending)
 *
 * What it can and cannot verify:
 *   - AutosyncNG orders (single or bundle parts): looked up through
 *     GET /transaction/{request_ref}. Definite answers resolve the
 *     order; "still pending" / lookup errors leave it for the next run.
 *   - ABS Vendor / Plinno / SuperCheapData: these providers give us no
 *     way to look an order up, so they are NEVER guessed at — left for
 *     the admin's manual buttons.
 *
 * Money rules (same as executeOrder):
 *   - 'successful' -> markSuccessful (no extra wallet movement)
 *   - 'failed'     -> markFailed (refunds the wallet once)
 *   - bundle: delivered parts stay, the rest is refunded via
 *     applyPartialRefund (idempotent PARTREFUND-<id> reference).
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('./supabaseAdmin');
const transactions = require('./transactions');
const autosync = require('./autosync');
const orderService = require('./orderService');

const WINDOW_HOURS = 72;
// The original request may still be running (Vercel maxDuration is 60s).
// Never touch a transaction younger than this.
const MIN_AGE_MS = 75 * 1000;
// "Not found" at AutosyncNG is only trusted as "never created" after
// this long, in case the request is still being queued on their side.
const NOT_FOUND_GRACE_MS = 10 * 60 * 1000;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Ask AutosyncNG about one request_ref.
 * @returns {Promise<'successful'|'failed'|'waiting'>}
 */
async function lookupAutosync(ref, ageMs) {
  let r;
  try {
    r = await autosync.getTransactionStatus(ref);
  } catch (err) {
    return 'waiting';
  }
  if (!r) return 'waiting';

  if (r.status === 'successful') return 'successful';
  if (r.status === 'failed') return 'failed';
  if (r.status === 'pending') return 'waiting';

  // status === 'error': only a real "not found" answer counts, and only
  // after the grace period. Timeouts / network errors / 5xx are not
  // answers.
  if (r.isTimeout || r.isNetworkError) return 'waiting';
  const notFound = r.statusCode === 404 || /not\s*found|no transaction|does not exist/i.test(r.message || '');
  if (notFound && ageMs > NOT_FOUND_GRACE_MS) return 'failed';
  return 'waiting';
}

// -----------------------------------------------------------------------
// Single (non-bundle) AutosyncNG order
// -----------------------------------------------------------------------

async function resolveSingle(txn, ageMs) {
  const payload = txn.request_payload || {};
  // For timeouts executeOrder stores our own idempotencyKey as the
  // provider_reference, and AutosyncNG accepts our request_ref in the
  // lookup, so either value works.
  const ref = txn.provider_reference || payload.idempotencyKey;
  if (!ref) return { outcome: 'skipped', note: 'nothing to look up' };

  const verdict = await lookupAutosync(ref, ageMs);

  if (verdict === 'successful') {
    await transactions.markSuccessful({ transactionId: txn.id, providerReference: ref, responsePayload: { reconciled: 'successful' } });
    return { outcome: 'success' };
  }
  if (verdict === 'failed') {
    await transactions.markFailed({ transactionId: txn.id, reason: 'Provider confirmed this request failed', responsePayload: { reconciled: 'failed' } });
    return { outcome: 'failed' };
  }
  return { outcome: 'waiting' };
}

// -----------------------------------------------------------------------
// Bundle
// -----------------------------------------------------------------------

async function resolveBundle(txn, ageMs) {
  const payload = txn.request_payload || {};
  const key = payload.idempotencyKey;
  const summary = txn.response_payload && Array.isArray(txn.response_payload.bundle) ? txn.response_payload.bundle : null;
  // No per-part summary yet => the original request is probably still
  // running (or died before saving it); nothing safe to decide on.
  if (!key || !summary || summary.length === 0) return { outcome: 'waiting', note: 'no bundle summary yet' };

  const table = txn.type === 'data' ? 'data_plans' : 'voice_plans';
  const planIds = [...new Set(summary.map((p) => String(p.planId)))];
  const { data: planRows, error } = await supabaseAdmin.from(table).select('id, api_provider, cost_price').in('id', planIds);
  if (error) throw new Error(`bundle plan lookup failed: ${error.message}`);
  const planById = new Map((planRows || []).map((p) => [String(p.id), p]));

  // Work out each part's final outcome: 'delivered' | 'not' | 'unknown'
  const finals = [];
  for (let i = 0; i < summary.length; i++) {
    const part = summary[i];
    if (part.outcome === 'delivered') { finals.push('delivered'); continue; }
    if (part.outcome === 'rejected' || part.outcome === 'not_attempted') { finals.push('not'); continue; }
    if (part.outcome === 'reconciled_delivered') { finals.push('delivered'); continue; }
    if (part.outcome === 'reconciled_not') { finals.push('not'); continue; }

    // 'unknown' (timeout / network error on the original request)
    const plan = planById.get(String(part.planId));
    const provider = (plan && plan.api_provider) || 'autosyncng';
    if (provider !== 'autosyncng') { finals.push('unknown'); continue; } // cannot be verified

    const verdict = await lookupAutosync(`${key}P${i + 1}`, ageMs);
    finals.push(verdict === 'successful' ? 'delivered' : verdict === 'failed' ? 'not' : 'unknown');
  }

  if (finals.includes('unknown')) return { outcome: 'waiting', note: 'a part is still unverified' };

  const updated = summary.map((p, i) => ({
    ...p,
    outcome: finals[i] === 'delivered'
      ? (p.outcome === 'delivered' ? 'delivered' : 'reconciled_delivered')
      : (p.outcome === 'rejected' ? 'rejected' : p.outcome === 'not_attempted' ? 'not_attempted' : 'reconciled_not')
  }));

  const deliveredCount = finals.filter((f) => f === 'delivered').length;

  // Re-read right before moving money: another worker may have
  // resolved it while we were calling the provider.
  const fresh = await transactions.getTransactionById(txn.id);
  if (!fresh || fresh.status !== 'pending') return { outcome: 'skipped', note: 'already resolved elsewhere' };

  if (deliveredCount === 0) {
    await transactions.markFailed({
      transactionId: txn.id,
      reason: 'Bundle: no part was delivered',
      responsePayload: { bundle: updated }
    });
    return { outcome: 'failed' };
  }

  const done = await transactions.markSuccessful({
    transactionId: txn.id,
    providerReference: key,
    responsePayload: { bundle: updated }
  });

  const missed = updated.map((p, i) => ({ p, i })).filter(({ i }) => finals[i] !== 'delivered');
  if (missed.length === 0) return { outcome: 'success' };

  const partial = {
    failedParts: missed.map(({ p }) => ({ name: p.name, share: Number(p.share) })),
    refundAmount: round2(missed.reduce((a, { p }) => a + Number(p.share || 0), 0)),
    refundedCost: round2(missed.reduce((a, { p }) => {
      const plan = planById.get(String(p.planId));
      return a + (Number(plan && plan.cost_price) || 0);
    }, 0))
  };
  await orderService.applyPartialRefund(done, { partial, raw: { bundle: updated } });
  return { outcome: 'partial', refunded: partial.refundAmount };
}

// -----------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------

/**
 * Try to resolve one pending transaction row.
 * @returns {Promise<{outcome:'success'|'failed'|'partial'|'waiting'|'skipped', note?:string}>}
 */
async function resolveTransaction(txn) {
  if (!txn || txn.status !== 'pending') return { outcome: 'skipped', note: 'not pending' };
  const payload = txn.request_payload || {};
  const provider = payload.apiProvider;
  const ageMs = Date.now() - new Date(txn.created_at).getTime();

  if (provider === 'bundle') return resolveBundle(txn, ageMs);
  if (provider && provider !== 'autosyncng') {
    return { outcome: 'skipped', note: `${provider} cannot be looked up` };
  }
  // Wallet funding etc. are not provider orders.
  if (!['data', 'voice', 'airtime', 'cable', 'electricity'].includes(txn.type)) {
    return { outcome: 'skipped', note: 'not a provider order' };
  }
  return resolveSingle(txn, ageMs);
}

/**
 * Sweep pending transactions older than MIN_AGE_MS.
 * @param {Object} [opts]
 * @param {string} [opts.userId]  only this user's transactions
 * @param {number} [opts.limit]
 */
async function reconcilePending({ userId, limit = 20 } = {}) {
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const before = new Date(Date.now() - MIN_AGE_MS).toISOString();

  let q = supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('status', 'pending')
    .is('reconciliation_note', null)
    .gte('created_at', since)
    .lte('created_at', before)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (userId) q = q.eq('user_id', userId);

  const { data: rows, error } = await q;
  if (error) throw new Error(`pending lookup failed: ${error.message}`);

  const stats = { checked: 0, success: 0, failed: 0, partial: 0, waiting: 0, skipped: 0, errors: 0 };
  for (const txn of rows || []) {
    stats.checked += 1;
    try {
      const r = await resolveTransaction(txn);
      stats[r.outcome] = (stats[r.outcome] || 0) + 1;
      if (r.outcome === 'success' || r.outcome === 'failed' || r.outcome === 'partial') {
        // eslint-disable-next-line no-console
        console.log(`[reconcile] ${txn.id} -> ${r.outcome}${r.refunded ? ` (refunded N${r.refunded})` : ''}`);
      }
    } catch (err) {
      stats.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[reconcile] error on ${txn.id}:`, err.message);
    }
  }
  return stats;
}

module.exports = { reconcilePending, resolveTransaction, MIN_AGE_MS };
