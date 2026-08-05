'use strict';

/**
 * api/cron/reconcile-failed-transactions.js
 * ---------------------------------------------------------------------
 * Runs on a schedule (see vercel.json). For every recent 'failed'
 * transaction that has a provider_reference, checks the REAL status
 * with AutosyncNG. If AutosyncNG says it was actually delivered
 * successfully, this AUTOMATICALLY re-debits the customer's wallet
 * and marks the transaction 'success' — closing the loop without
 * needing an admin to click through each one by hand.
 *
 * Scope, deliberately conservative:
 *   - Only transactions marked 'failed' in the last RECONCILE_WINDOW_HOURS
 *     (older ones are unlikely to still flip, and we don't want to
 *     keep re-checking ancient records forever).
 *   - Only transactions that HAVE a provider_reference — if AutosyncNG
 *     never even created a transaction (an immediate validation-style
 *     error), there is nothing to look up, and admin.html's manual
 *     "I verified delivery" button remains the only path for those.
 *   - At most RECONCILE_BATCH_LIMIT per run, to bound execution time
 *     and AutosyncNG API load per invocation.
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
    .select('id, provider_reference, amount, user_id')
    .eq('status', 'failed')
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

  const results = { checked: 0, reconciled: 0, stillFailed: 0, errors: 0 };

  for (const txn of candidates || []) {
    results.checked += 1;
    try {
      const providerResult = await autosync.getTransactionStatus(txn.provider_reference);

      if (providerResult.status === 'successful') {
        await transactions.reconcileFailedToSuccess({
          transactionId: txn.id,
          providerReference: txn.provider_reference,
          responsePayload: providerResult.raw
        });
        results.reconciled += 1;
        // eslint-disable-next-line no-console
        console.log(`[cron:reconcile] Auto-reconciled transaction ${txn.id} (₦${txn.amount}) — AutosyncNG confirmed delivery.`);
      } else {
        results.stillFailed += 1;
      }
    } catch (err) {
      results.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[cron:reconcile] Error checking transaction ${txn.id}:`, err.message);
    }
  }

  res.status(200).json({ success: true, data: results });
};
