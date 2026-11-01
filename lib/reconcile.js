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

// How far back a pending order is still looked at (AutosyncNG keeps
// its records, so a long window is cheap).
const WINDOW_HOURS = 24 * 14;
// Providers whose orders can be looked up automatically.
const CHECKABLE_PROVIDERS = [undefined, null, 'autosyncng', 'bundle'];
const CHECKABLE_TYPES = ['data', 'voice', 'airtime', 'cable', 'electricity'];
const FETCH_POOL = 300;
// The original request may still be running (Vercel maxDuration is 60s).
// Never touch a transaction younger than this.
const MIN_AGE_MS = 75 * 1000;
// "Not found" at AutosyncNG is only trusted as "never created" after
// this long, in case the request is still being queued on their side.
const NOT_FOUND_GRACE_MS = 10 * 60 * 1000;

// A bundle part that was never sent (the request stopped at an earlier part
// whose outcome was unknown) is still sent later by the cron, as long as the
// order is younger than this; after that its share is refunded instead.
const RESUME_MAX_MS = 3 * 60 * 60 * 1000;

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

const UNKNOWN_LIKE = ['unknown', 'sending'];
const isDelivered = (o) => o === 'delivered' || o === 'reconciled_delivered';

function isUncertainResult(r) {
  if (!r) return true;
  if (r.status === 'error' && (r.isTimeout || r.isNetworkError)) return true;
  return (r.status === 'error' || r.status === 'failed') &&
    /already\s+(been\s+)?(taken|used|exists)|duplicate\s+(request|reference)/i.test(String(r.message || ''));
}

async function persistBundle(txnId, parts) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .update({ response_payload: { bundle: parts } })
    .eq('id', txnId)
    .eq('status', 'pending');
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[reconcile] could not save bundle progress:', txnId, error.message);
  }
}

/**
 * @param {Object} opts
 * @param {boolean} [opts.allowSend]  only the cron sets this: it may SEND parts that were never attempted
 * @param {{sends:number}} [opts.budget]  max sends left in this sweep
 * @param {number} [opts.deadline]  stop sending after this timestamp
 */
async function resolveBundle(txn, ageMs, opts = {}) {
  const payload = txn.request_payload || {};
  const key = payload.idempotencyKey;
  const summary = txn.response_payload && Array.isArray(txn.response_payload.bundle) ? txn.response_payload.bundle : null;
  // No per-part summary yet => the original request is probably still
  // running (or died before saving it); nothing safe to decide on.
  if (!key || !summary || summary.length === 0) return { outcome: 'waiting', note: 'no bundle summary yet' };

  const table = txn.type === 'data' ? 'data_plans' : 'voice_plans';
  const planIds = [...new Set(summary.map((p) => String(p.planId)))];
  const { data: planRows, error } = await supabaseAdmin.from(table).select('*').in('id', planIds);
  if (error) throw new Error(`bundle plan lookup failed: ${error.message}`);
  const planById = new Map((planRows || []).map((p) => [String(p.id), p]));

  const parts = summary.map((p) => ({ ...p }));
  const providerOf = (i) => ((planById.get(String(parts[i].planId)) || {}).api_provider) || 'autosyncng';
  let changed = false;

  // 1) Parts whose outcome was unknown: ask the provider (AutosyncNG only).
  for (let i = 0; i < parts.length; i++) {
    if (!UNKNOWN_LIKE.includes(parts[i].outcome)) continue;
    if (providerOf(i) !== 'autosyncng') continue; // cannot be verified
    const verdict = await lookupAutosync(`${key}P${i + 1}`, ageMs);
    if (verdict === 'successful') { parts[i].outcome = 'reconciled_delivered'; changed = true; }
    else if (verdict === 'failed') { parts[i].outcome = 'reconciled_not'; changed = true; }
  }

  // 2) Parts that were never sent: the cron sends them now (AutosyncNG only,
  //    because its request_ref makes a re-send impossible to double-deliver).
  const phone = (String(txn.recipient || '').match(/0[789][01]\d{8}/) || [])[0];
  const resumable = (i) => parts[i].outcome === 'not_attempted' && providerOf(i) === 'autosyncng' && ageMs < RESUME_MAX_MS && !!phone;

  if (!parts.some((p) => UNKNOWN_LIKE.includes(p.outcome))) {
    for (;;) {
      const i = parts.findIndex((_, k) => resumable(k));
      if (i < 0) break;

      const budget = opts.budget || { sends: 0 };
      if (!opts.allowSend || budget.sends <= 0 || (opts.deadline && Date.now() > opts.deadline)) {
        if (changed) await persistBundle(txn.id, parts);
        return { outcome: 'waiting', note: 'remaining bundle parts are sent by the cron' };
      }

      let call;
      try {
        const plan = planById.get(String(parts[i].planId));
        call = txn.type === 'data' ? orderService.buildDataCall(plan, phone) : orderService.buildVoiceCall(plan, phone);
      } catch (err) {
        parts[i].outcome = 'rejected';
        parts[i].message = `could not be sent later: ${err.message}`;
        changed = true;
        continue;
      }

      // Mark BEFORE the call, so a crash mid-call is verified, not re-sent.
      parts[i].outcome = 'sending';
      await persistBundle(txn.id, parts);
      budget.sends -= 1;

      const r = await call.callProvider(`${key}P${i + 1}`);
      changed = true;
      if (r && r.status === 'successful') {
        parts[i].outcome = 'delivered';
        parts[i].message = null;
      } else if (isUncertainResult(r)) {
        parts[i].outcome = 'unknown';
        parts[i].message = (r && r.message) || 'no answer';
        break; // next run verifies it with the provider
      } else {
        parts[i].outcome = 'rejected';
        parts[i].message = (r && r.message) || 'rejected';
      }
    }
  }

  if (parts.some((p) => UNKNOWN_LIKE.includes(p.outcome))) {
    if (changed) await persistBundle(txn.id, parts);
    return { outcome: 'waiting', note: 'a part is still unverified' };
  }

  // 3) Everything is settled (anything still 'not_attempted' could not be sent
  //    and counts as not delivered).
  const finals = parts.map((p) => (isDelivered(p.outcome) ? 'delivered' : 'not'));
  const deliveredCount = finals.filter((f) => f === 'delivered').length;

  // Re-read right before moving money: another worker may have
  // resolved it while we were calling the provider.
  const fresh = await transactions.getTransactionById(txn.id);
  if (!fresh || fresh.status !== 'pending') return { outcome: 'skipped', note: 'already resolved elsewhere' };

  if (deliveredCount === 0) {
    await transactions.markFailed({
      transactionId: txn.id,
      reason: 'Bundle: no part was delivered',
      responsePayload: { bundle: parts }
    });
    return { outcome: 'failed' };
  }

  const done = await transactions.markSuccessful({
    transactionId: txn.id,
    providerReference: key,
    responsePayload: { bundle: parts }
  });

  const missed = parts.map((p, i) => ({ p, i })).filter(({ i }) => finals[i] !== 'delivered');
  if (missed.length === 0) return { outcome: 'success' };

  const partial = {
    failedParts: missed.map(({ p }) => ({ name: p.name, share: Number(p.share) })),
    refundAmount: round2(missed.reduce((a, { p }) => a + Number(p.share || 0), 0)),
    refundedCost: round2(missed.reduce((a, { p }) => {
      const plan = planById.get(String(p.planId));
      return a + (Number(plan && plan.cost_price) || 0);
    }, 0))
  };
  await orderService.applyPartialRefund(done, { partial, raw: { bundle: parts } });
  return { outcome: 'partial', refunded: partial.refundAmount };
}

// -----------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------

/**
 * Try to resolve one pending transaction row.
 * @returns {Promise<{outcome:'success'|'failed'|'partial'|'waiting'|'skipped', note?:string}>}
 */
async function resolveTransaction(txn, opts = {}) {
  if (!txn || txn.status !== 'pending') return { outcome: 'skipped', note: 'not pending' };
  const payload = txn.request_payload || {};
  const provider = payload.apiProvider;
  const ageMs = Date.now() - new Date(txn.created_at).getTime();

  if (provider === 'bundle') return resolveBundle(txn, ageMs, opts);
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
async function reconcilePending({ userId, limit = 20, allowSend = false } = {}) {
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const before = new Date(Date.now() - MIN_AGE_MS).toISOString();

  let q = supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('status', 'pending')
    .in('type', CHECKABLE_TYPES)
    .is('reconciliation_note', null)
    .gte('created_at', since)
    .lte('created_at', before)
    .order('created_at', { ascending: false })
    .limit(FETCH_POOL);
  if (userId) q = q.eq('user_id', userId);

  const { data: rows, error } = await q;
  if (error) throw new Error(`pending lookup failed: ${error.message}`);

  const stats = { pool: (rows || []).length, checked: 0, success: 0, failed: 0, partial: 0, waiting: 0, skipped: 0, errors: 0, unverifiable: 0 };

  // Orders from providers that cannot be looked up (ABS, Plinno, SCD) used
  // to fill the batch and starve everything behind them — set them aside
  // first, then spend the batch only on orders that CAN be resolved.
  const checkable = [];
  for (const txn of rows || []) {
    const provider = txn.request_payload && txn.request_payload.apiProvider;
    if (CHECKABLE_PROVIDERS.includes(provider)) checkable.push(txn);
    else stats.unverifiable += 1;
  }

  // Shuffle so orders that keep answering "still pending" do not hog
  // every run and starve the rest.
  for (let i = checkable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [checkable[i], checkable[j]] = [checkable[j], checkable[i]];
  }

  // Shared by every bundle in this sweep: at most 3 re-sends, and none after 35s
  // (the cron function has a 60s limit).
  const sendOpts = { allowSend, budget: { sends: 3 }, deadline: Date.now() + 35 * 1000 };

  for (const txn of checkable.slice(0, limit)) {
    stats.checked += 1;
    try {
      const r = await resolveTransaction(txn, sendOpts);
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
