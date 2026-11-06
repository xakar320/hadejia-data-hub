'use strict';

/**
 * lib/wrongNumber.js
 * ---------------------------------------------------------------------
 * A customer bought for the wrong number by mistake. From the transaction
 * he can mark "this was meant for 0802…". The mark is stored inside the
 * transaction's request_payload (intendedPhone, wrongNumberAt), so no new
 * table or column is needed. It only LABELS the transaction (and makes it
 * findable by the intended number) — it never moves money or touches the
 * provider.
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('./supabaseAdmin');
const { ValidationError, validatePhone } = require('./validation');

function bad(field, message) {
  throw new ValidationError(message, { details: [{ field, message }] });
}

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/**
 * @param {string} userId
 * @param {{transaction_id:string, intended_phone?:string}} body  empty intended_phone removes the mark
 */
async function mark(userId, body) {
  const id = String(body.transaction_id || '');
  if (!id) bad('transaction_id', 'Transaction is required');

  const { data: txn, error } = await supabaseAdmin
    .from('transactions')
    .select('id, user_id, type, status, recipient, request_payload')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!txn) bad('transaction_id', 'Transaction not found');

  const payload = Object.assign({}, txn.request_payload || {});
  const raw = String(body.intended_phone || '').trim();

  if (!raw) {                                   // remove the mark
    delete payload.intendedPhone;
    delete payload.wrongNumberAt;
  } else {
    if (!['data', 'voice', 'airtime'].includes(txn.type)) bad('transaction_id', 'Only data, voice and airtime orders can be marked');
    if (txn.status !== 'success') bad('transaction_id', 'Only a successful order can be marked as sent to a wrong number');
    const phone = validatePhone(raw, 'intended_phone');
    if (last10(phone) === last10(txn.recipient)) bad('intended_phone', 'That is the same number the order was sent to');
    payload.intendedPhone = phone;
    payload.wrongNumberAt = new Date().toISOString();
  }

  const { error: upErr } = await supabaseAdmin
    .from('transactions')
    .update({ request_payload: payload })
    .eq('id', id)
    .eq('user_id', userId);
  if (upErr) throw new Error(upErr.message);

  return { id, intended_phone: payload.intendedPhone || null };
}

module.exports = { mark };
