'use strict';

/**
 * api/cron/reconcile-failed-transactions.js
 * ---------------------------------------------------------------------
 * Runs on a schedule (see vercel.json). Re-checks two kinds of
 * uncertain transactions against AutosyncNG's real status:
 *
 *   1. 'failed' transactions with a provider_reference — AutosyncNG
 *      DID respond with a rejection, but delivery might have actually
 *      gone through anyway on their side. If they now say
 *      "successful", we re-debit the wallet and mark it success.
 *
 *   2. 'pending' transactions with a provider_reference — these are
 *      mostly requests that TIMED OUT (we never got a response at
 *      all — see lib/orderService.js#executeOrder, which now leaves
 *      timeouts 'pending' with our own idempotencyKey stored as
 *      provider_reference, instead of guessing and refunding
 *      immediately). If AutosyncNG now confirms "successful", we mark
 *      it success (NO wallet re-debit — the original debit already
 *      happened and was never refunded, unlike case 1 above). If they
 *      confirm it genuinely failed/doesn't exist, we mark it failed
 *      and refund now, once, with a real answer instead of a guess.
 *
 * Scope, deliberately conservative:
 *   - Only transactions from the last RECONCILE_WINDOW_HOURS.
 *   - Only transactions that HAVE a provider_reference — if AutosyncNG
 *     never even created a transaction (an immediate validation-style
 *     error) or we didn't have anything to look up with, there is
 *     nothing to check, and admin.html's manual buttons remain the
 *     only path for those.
 *   - At most RECONCILE_BATCH_LIMIT per run, to bound execution time
 *     and AutosyncNG API load per invocation.
 *   - If AutosyncNG's answer is still ambiguous (neither a clear
 *     'successful' nor a clear failure/not-found), a 'pending'
 *     transaction is simply left alone for the next run — never
 *     guessed at.
 *
 * Secured via Vercel's CRON_SECRET convention: Vercel automatically
 * sends `Authorization: Bearer $CRON_SECRET` on cron-triggered
 * requests when the CRON_SECRET env var is set — this handler checks
 * for that instead of requireAuth/requireAdmin, since there is no
 * admin session in a cron context.
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('../../lib/supabaseAdmin');
const transactions = require('../../lib/transactions');
const autosync = require('../../lib/autosync');

const RECONCILE_WINDOW_HOURS = 72;
const RECONCILE_BATCH_LIMIT = 20;

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return;
  }

  const since = new Date(Date.now() - RECONCILE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabaseAdmin
    .from('transactions')
    .select('id, status, provider_reference, amount, user_id')
    .in('status', ['failed', 'pending'])
    .is('reconciliation_note', null)
    .not('provider_reference', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(RECONCILE_BATCH_LIMIT);

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[cron:reconcile] Failed to fetch candidates:', error.message);
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });
    return;
  }

  const results = { checked: 0, confirmedSuccess: 0, confirmedFailed: 0, stillUncertain: 0, errors: 0 };

  for (const txn of candidates || []) {
    results.checked += 1;
    try {
      const providerResult = await autosync.getTransactionStatus(txn.provider_reference);

      if (providerResult.status === 'successful') {
        if (txn.status === 'failed') {
          // Was refunded when marked failed — re-debit before flipping to success.
          await transactions.reconcileFailedToSuccess({
            transactionId: txn.id,
            providerReference: txn.provider_reference,
            responsePayload: providerResult.raw
          });
        } else {
          // Was 'pending' (e.g. a timeout) — never refunded, so just
          // confirm success with no additional wallet movement.
          await transactions.markSuccessful({
            transactionId: txn.id,
            providerReference: txn.provider_reference,
            responsePayload: providerResult.raw
          });
        }
        results.confirmedSuccess += 1;
        // eslint-disable-next-line no-console
        console.log(`[cron:reconcile] Confirmed SUCCESS for transaction ${txn.id} (₦${txn.amount}, was ${txn.status}).`);
      } else if (txn.status === 'pending' && (providerResult.status === 'failed' || providerResult.status === 'error')) {
        // A pending (timed-out) transaction that AutosyncNG now
        // definitively confirms failed — refund now, with a real
        // answer instead of a guess.
        await transactions.markFailed({
          transactionId: txn.id,
          reason: providerResult.message || 'AutosyncNG confirmed this request failed',
          responsePayload: providerResult.raw
        });
        results.confirmedFailed += 1;
        // eslint-disable-next-line no-console
        console.log(`[cron:reconcile] Confirmed FAILED for transaction ${txn.id} (₦${txn.amount}) — refunded.`);
      } else {
        // Still ambiguous, or a 'failed' transaction that AutosyncNG
        // still confirms failed (nothing to do — it was already
        // refunded when first marked failed). Leave as-is.
        results.stillUncertain += 1;
      }
    } catch (err) {
      results.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[cron:reconcile] Error checking transaction ${txn.id}:`, err.message);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[cron:reconcile] Run summary:', JSON.stringify(results));
  res.status(200).json({ success: true, data: results });
};

