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
const wallet = require('./wallet');

const TOLERANCE_SECONDS = 300;
// ABS can sit on 'Processing' for many hours before cancelling, so look back a week.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
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

/**
 * Decide what an ABS event means for our order.
 * ABS documents status 1 = settled, 3 = failed, 6 = refunded; their dashboard
 * also shows "Reversed"/"Cancelled", so any event whose name says so, or a
 * status of 3-6, counts as failed. Anything else (e.g. still processing) is
 * ignored.
 * @returns {'settled'|'failed'|null}
 */
function verdictOf(eventName, data) {
  const st = Number(data && data.status);
  const name = String(eventName || '').toLowerCase();
  const text = String((data && (data.status_text || data.status_label || data.state)) || '').toLowerCase();

  if (/fail|revers|cancel|refund/.test(name) || /fail|revers|cancel|refund/.test(text)) return 'failed';
  if (st === 3 || st === 4 || st === 5 || st === 6) return 'failed';
  if (name === 'transaction.settled' || st === 1 || /settled|success/.test(text)) return 'settled';
  return null;
}

/**
 * We had marked this order 'success' (ABS accepted it) but ABS later says it
 * failed / refunded it. Flip it to 'failed' and give the customer's money
 * back. The status flip is guarded (only from 'success'), so the refund can
 * happen at most once; the wallet reference is deterministic as well.
 */
async function failSuccessfulOrder(txn, reason, body) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({
      status: 'failed',
      response_payload: { reason, abs: body, previous_status: 'success' },
      reconciliation_note: null
    })
    .eq('id', txn.id)
    .eq('status', 'success')
    .select()
    .maybeSingle();
  if (error) throw new Error(`ABS webhook: could not mark order failed: ${error.message}`);
  if (!data) return false; // changed by someone else meanwhile

  if (data.wallet_history_id && data.type !== 'wallet_funding') {
    const key = data.request_payload && data.request_payload.idempotencyKey;
    await wallet.refundDebit({
      userId: data.user_id,
      amount: Number(data.amount),
      originalReference: key ? `PURCHASE-${key}` : `TXN-${txn.id}`,
      description: `Refund: ABS reported this ${data.type} order failed (${reason})`
    });
  }
  return true;
}

/**
 * Settle the order an ABS event belongs to, if (and only if) it can be
 * identified unambiguously.
 * @returns {Promise<{handled:boolean, outcome:string}>}
 */
async function handleAbsEvent(eventName, body) {
  const data = (body && body.data) || {};
  const verdict = verdictOf(eventName, data);
  if (!verdict) {
    // eslint-disable-next-line no-console
    console.log('[ABS webhook] ignored event:', eventName, 'status:', data.status);
    return { handled: false, outcome: 'ignored event' };
  }

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

  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[ABS webhook] no matching order for', eventName, 'recipient ending', phone.slice(-4), 'amount', data.amount);
    return { handled: false, outcome: 'no matching order' };
  }
  if (candidates.length > 1) {
    // Several identical orders (same number, same amount) from the SAME customer
    // are interchangeable: settle/fail the oldest one still waiting for ABS.
    const sameUser = candidates.every((c) => c.user_id === candidates[0].user_id);
    const waiting = candidates
      .filter((c) => c.status === 'pending')
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (sameUser && waiting.length > 0) candidates = [waiting[0]];
  }
  if (candidates.length > 1) {
    // eslint-disable-next-line no-console
    console.log('[ABS webhook] ambiguous match for', eventName, 'recipient ending', phone.slice(-4), 'amount', data.amount, 'candidates', candidates.length);
    return { handled: false, outcome: 'ambiguous (several orders for this number)' };
  }

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

  // We counted it successful (ABS accepted it) but ABS now says it failed or
  // was refunded: mark it failed and refund the customer. If the refund
  // cannot be made (e.g. wallet error), flag it for a human instead.
  if (txn.status === 'success' && verdict === 'failed') {
    const reason = `ABS reported ${eventName}${data.message ? `: ${data.message}` : ''}`;
    try {
      const done = await failSuccessfulOrder(txn, reason, body);
      return { handled: done, outcome: done ? 'failed (was success) and refunded' : 'already changed' };
    } catch (err) {
      // Put it back to 'success' so the customer is not left failed-without-refund.
      await supabaseAdmin.from('transactions').update({ status: 'success' })
        .eq('id', txn.id).eq('status', 'failed');
      await transactions.flagForReconciliation({
        transactionId: txn.id,
        note: `ABS sent "${eventName}" (order ${data.order_id || '?'}) but this order is marked successful and the automatic refund failed (${err.message}). Check the ABS dashboard, then fix it manually.`
      });
      return { handled: true, outcome: 'flagged' };
    }
  }

  return { handled: false, outcome: 'already settled' };
}

module.exports = { verifySignature, handleAbsEvent, verdictOf };
