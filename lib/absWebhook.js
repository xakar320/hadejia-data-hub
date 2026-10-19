'use strict';

/**
 * lib/absWebhook.js
 * ---------------------------------------------------------------------
 * ABS Vendor webhook support (verification + matching + settling).
 * Used by api/webhook.js, which receives both AutosyncNG and ABS posts.
 *
 * ABS (from their developer page):
 *   Headers:  X-ABS-Event, X-ABS-Delivery, X-ABS-Timestamp (unix s),
 *             X-ABS-Signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 *   Body:     { event, created_at, data: { order_id, status, amount,
 *             service, trans_kind, recipient, message, balance_before,
 *             balance_after, confirmed_at } }
 *   status:   1 settled | 3 failed | 6 refunded
 *   Events:   transaction.settled | transaction.failed | refund.issued
 *             (+ wallet.* which we ignore)
 *
 * THE MATCHING PROBLEM: ABS never returns an order id when we buy, so
 * `data.order_id` means nothing to us. An event can only be matched to
 * our order by recipient phone (+ amount + time). To never settle the
 * wrong order we only act when the match is UNAMBIGUOUS:
 *   - candidates = our ABS single orders (not bundles) for that phone,
 *     created shortly before the event, that are 'pending' or 'success'
 *     (an already-successful order can own the event too);
 *   - if several, narrow by amount == cost_price;
 *   - act only if exactly ONE candidate is left AND it is 'pending'.
 * Anything ambiguous is acknowledged and left for the admin buttons.
 * ABS orders inside bundles are not matched here (their events cannot be
 * told apart from the parts we already know delivered).
 * ---------------------------------------------------------------------
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabaseAdmin');
const transactions = require('./transactions');

const TOLERANCE_SECONDS = 300;
const LOOKBACK_MS = 6 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 2 * 60 * 1000;

function verifySignature({ secret, timestamp, signature, rawBody }) {
  if (!secret || !timestamp || !signature || typeof rawBody !== 'string') return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/** @returns {'settled'|'failed'|null} */
function verdictOf(eventName, data) {
  const st = Number(data && data.status);
  if (eventName === 'transaction.settled' || st === 1) return 'settled';
  if (eventName === 'transaction.failed' || eventName === 'refund.issued' || st === 3 || st === 6) return 'failed';
  return null;
}

/**
 * Settle the order an ABS event belongs to, if (and only if) it can be
 * identified unambiguously.
 * @returns {Promise<{handled:boolean, outcome:string}>}
 */
async function handleAbsEvent(eventName, body) {
  const data = (body && body.data) || {};
  const verdict = verdictOf(eventName, data);
  if (!verdict) return { handled: false, outcome: 'ignored event' };

  const phone = last10(data.recipient);
  if (phone.length < 10) return { handled: false, outcome: 'no recipient' };

  const parsed = Date.parse(data.confirmed_at || (body && body.created_at) || '');
  const at = Number.isFinite(parsed) ? parsed : Date.now();
  const from = new Date(at - LOOKBACK_MS).toISOString();
  const to = new Date(at + LOOKAHEAD_MS).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('request_payload->>apiProvider', 'absvendor')
    .in('status', ['pending', 'success'])
    .ilike('recipient', `%${phone}%`)
    .gte('created_at', from)
    .lte('created_at', to)
    .limit(20);
  if (error) throw new Error(`ABS webhook lookup failed: ${error.message}`);

  let candidates = rows || [];
  if (candidates.length > 1 && Number(data.amount) > 0) {
    const narrowed = candidates.filter((t) => Math.abs(Number(t.cost_price) - Number(data.amount)) < 0.011);
    if (narrowed.length > 0) candidates = narrowed;
  }

  if (candidates.length === 0) return { handled: false, outcome: 'no matching order' };
  if (candidates.length > 1) return { handled: false, outcome: 'ambiguous (several orders for this number)' };

  const txn = candidates[0];

  if (txn.status === 'pending') {
    if (verdict === 'settled') {
      await transactions.markSuccessful({
        transactionId: txn.id,
        providerReference: data.order_id || null,
        responsePayload: { abs: body }
      });
      return { handled: true, outcome: 'success' };
    }
    await transactions.markFailed({
      transactionId: txn.id,
      reason: `ABS reported ${eventName}${data.message ? `: ${data.message}` : ''}`,
      responsePayload: { abs: body }
    });
    return { handled: true, outcome: 'failed' };
  }

  // We already count it successful but ABS says failed / refunded:
  // never move money on our own here — flag it for a human.
  if (txn.status === 'success' && verdict === 'failed') {
    await transactions.flagForReconciliation({
      transactionId: txn.id,
      note: `ABS sent "${eventName}" (order ${data.order_id || '?'}) but this order is marked successful. Check the ABS dashboard before doing anything.`
    });
    return { handled: true, outcome: 'flagged' };
  }

  return { handled: false, outcome: 'already settled' };
}

module.exports = { verifySignature, handleAbsEvent, verdictOf };
