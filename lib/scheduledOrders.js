'use strict';

/**
 * lib/scheduledOrders.js
 * ---------------------------------------------------------------------
 * Orders a customer schedules for a later date/time.
 *  - The PIN is verified when the order is SCHEDULED (never stored).
 *  - The wallet is charged only when the order RUNS (not at scheduling),
 *    so the customer needs enough balance at that time.
 *  - runDue() is called by the cron endpoint every minute
 *    (?task=scheduled). Each order is claimed atomically, and runs with
 *    a fixed request ref (SCH<id>) so it can never be sent twice.
 * Supported: single data / voice / airtime orders (not bulk).
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('./supabaseAdmin');
const { verifyPin } = require('./auth');
const { ValidationError, validatePin, validatePhone } = require('./validation');
const orderService = require('./orderService');

const TYPES = ['data', 'voice', 'airtime'];
const MIN_LEAD_MS = 2 * 60 * 1000;
const MAX_LEAD_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 20;
const MAX_LATE_MS = 3 * 60 * 60 * 1000;   // missed by >3h => not run
const STALE_RUNNING_MS = 10 * 60 * 1000;

const refFor = (id) => 'SCH' + String(id).replace(/-/g, '');

function bad(field, message) {
  throw new ValidationError(message, { details: [{ field, message }] });
}

async function create(userId, body) {
  const type = String(body.type || '').toLowerCase();
  if (!TYPES.includes(type)) bad('type', 'Scheduling works for data, voice and airtime orders only');

  const runAt = new Date(body.run_at);
  if (!Number.isFinite(runAt.getTime())) bad('run_at', 'Choose a valid date and time');
  const lead = runAt.getTime() - Date.now();
  if (lead < MIN_LEAD_MS) bad('run_at', 'Choose a time at least 2 minutes from now');
  if (lead > MAX_LEAD_MS) bad('run_at', 'You can schedule up to 60 days ahead');

  await verifyPin(userId, validatePin(body.pin, 'pin'));

  const phone = validatePhone(body.phone, 'phone');
  let fields;
  if (type === 'airtime') {
    const amount = Number(body.amount);
    if (!body.network || !(amount > 0)) bad('amount', 'Network and amount are required');
    fields = { network: String(body.network), phone, amount };
  } else {
    if (!body.planId) bad('planId', 'Select a plan');
    fields = { planId: String(body.planId), phone };
  }

  const { count, error: countErr } = await supabaseAdmin
    .from('scheduled_orders')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['scheduled', 'running']);
  if (countErr) bad('run_at', `Scheduling is not ready: ${String(countErr.message).slice(0, 160)}`);
  if ((count || 0) >= MAX_ACTIVE) bad('run_at', `You can have at most ${MAX_ACTIVE} scheduled orders at once`);

  const summary = String(body.summary || '').slice(0, 120) || `${type} → ${phone}`;
  const { data, error } = await supabaseAdmin
    .from('scheduled_orders')
    .insert({ user_id: userId, type, order_fields: fields, summary, run_at: runAt.toISOString() })
    .select('id, type, summary, run_at, status')
    .single();
  if (error) bad('run_at', `Could not save: ${String(error.message).slice(0, 160)}`);
  return data;
}

async function list(userId) {
  const { data, error } = await supabaseAdmin
    .from('scheduled_orders')
    .select('id, type, summary, run_at, status, error, transaction_id, finished_at')
    .eq('user_id', userId)
    .in('status', ['scheduled', 'running', 'failed'])   // done/cancelled are hidden (done ones live in history)
    .order('run_at', { ascending: false })
    .limit(30);
  if (error) throw new Error(error.message);
  const rows = data || [];
  const ids = rows.map((r) => r.transaction_id).filter(Boolean);
  if (ids.length) {
    const { data: txns } = await supabaseAdmin
      .from('transactions').select('id, status, created_at').in('id', ids);
    const byId = new Map((txns || []).map((t) => [t.id, t]));
    rows.forEach((r) => {
      const t = byId.get(r.transaction_id);
      if (t) { r.txn_status = t.status; r.txn_created_at = t.created_at; }
    });
  }
  return rows;
}

async function cancel(userId, id) {
  const { data, error } = await supabaseAdmin
    .from('scheduled_orders')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) bad('id', 'This order can no longer be cancelled (already running or finished)');
  return { id, status: 'cancelled' };
}

async function remove(userId, id) {
  const { data, error } = await supabaseAdmin
    .from('scheduled_orders')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .in('status', ['failed', 'cancelled', 'done'])
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) bad('id', 'Only finished orders can be deleted. Cancel it first if it is still waiting.');
  return { id, deleted: true };
}

async function runOne(row) {
  const { data: claimed } = await supabaseAdmin
    .from('scheduled_orders')
    .update({ status: 'running', claimed_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
    .select('id');
  if (!claimed || claimed.length === 0) return 'skipped'; // someone else has it

  const finish = (patch) => supabaseAdmin
    .from('scheduled_orders')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', row.id);

  if (Date.now() - new Date(row.run_at).getTime() > MAX_LATE_MS) {
    await finish({ status: 'failed', error: 'Missed its time by more than 3 hours, so it was not sent.' });
    return 'missed';
  }

  try {
    const result = await orderService.executeOrder(
      { userId: row.user_id, type: row.type, requestRef: refFor(row.id), ...row.order_fields },
      { skipPin: true }
    );
    const t = result.transaction || {};
    await finish({ status: 'done', transaction_id: t.id || null, error: null });
    return 'done';
  } catch (err) {
    await finish({ status: 'failed', error: String(err.message || err).slice(0, 300) });
    return 'failed';
  }
}

async function runDue({ limit = 10 } = {}) {
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const stats = { due: 0, done: 0, failed: 0, missed: 0, skipped: 0 };

  const { data: due } = await supabaseAdmin
    .from('scheduled_orders').select('*')
    .eq('status', 'scheduled').lte('run_at', nowIso)
    .order('run_at', { ascending: true }).limit(limit);
  const { data: stale } = await supabaseAdmin
    .from('scheduled_orders').select('*')
    .eq('status', 'running').lte('claimed_at', staleIso).limit(5);

  const rows = [...(due || []), ...(stale || [])];
  stats.due = rows.length;
  for (const row of rows) {
    const r = await runOne(row);
    stats[r] = (stats[r] || 0) + 1;
  }
  return stats;
}

module.exports = { create, list, cancel, remove, runDue, refFor };
