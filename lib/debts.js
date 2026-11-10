'use strict';

/**
 * lib/debts.js — admin's record of customers who were given data / voice /
 * airtime on credit. Purely a notebook: it never touches wallets or
 * providers. All access is server-side (service role), admin only.
 */

const { supabaseAdmin } = require('./supabaseAdmin');
const { ValidationError } = require('./validation');

function bad(field, message) {
  throw new ValidationError(message, { details: [{ field, message }] });
}

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const money = (n) => Math.round(Number(n) * 100) / 100;
const present = (r) => ({ ...r, balance: money(Number(r.amount) - Number(r.paid)) });

async function add(adminId, body) {
  const phone = last10(body.phone);
  if (phone.length < 10) bad('phone', 'Enter the debtor\'s phone number');
  const amount = money(body.amount);
  if (!(amount > 0)) bad('amount', 'Enter the amount owed');

  const { data, error } = await supabaseAdmin
    .from('debts')
    .insert({
      phone,
      name: String(body.name || '').trim().slice(0, 80) || null,
      item: String(body.item || '').trim().slice(0, 120) || null,
      note: String(body.note || '').trim().slice(0, 300) || null,
      amount,
      created_by: adminId
    })
    .select('*')
    .single();
  if (error) throw new Error(`Could not save: ${error.message}`);
  return present(data);
}

async function list({ status = 'open', search = '' } = {}) {
  let q = supabaseAdmin.from('debts').select('*').order('created_at', { ascending: false }).limit(300);
  if (status === 'open' || status === 'paid') q = q.eq('status', status);
  const term = String(search || '').trim();
  if (term) {
    const digits = term.replace(/\D/g, '');
    const safe = term.replace(/[,()%]/g, '');
    q = digits.length >= 3
      ? q.or(`phone.ilike.%${digits.slice(-10)}%,name.ilike.%${safe}%`)
      : q.ilike('name', `%${safe}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data || []).map(present);
  const totalOwed = money(rows.filter((r) => r.status === 'open').reduce((s, r) => s + r.balance, 0));
  return { rows, totalOwed };
}

async function pay(id, amountRaw) {
  const { data: row, error } = await supabaseAdmin.from('debts').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) bad('id', 'Debt not found');
  if (row.status === 'paid') bad('id', 'This debt is already fully paid');

  const balance = money(Number(row.amount) - Number(row.paid));
  const amount = amountRaw === undefined || amountRaw === null || amountRaw === '' ? balance : money(amountRaw);
  if (!(amount > 0)) bad('amount', 'Enter a valid amount');
  if (amount > balance + 0.001) bad('amount', `Only ₦${balance} is still owed`);

  const paid = money(Number(row.paid) + amount);
  const done = paid >= Number(row.amount) - 0.001;
  const { data, error: upErr } = await supabaseAdmin
    .from('debts')
    .update({ paid, status: done ? 'paid' : 'open', paid_at: done ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('status', 'open')
    .select('*')
    .maybeSingle();
  if (upErr) throw new Error(upErr.message);
  if (!data) bad('id', 'This debt changed — refresh and try again');
  return present(data);
}

async function remove(id) {
  const { data, error } = await supabaseAdmin.from('debts').delete().eq('id', id).select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) bad('id', 'Debt not found');
  return { id, deleted: true };
}

/** Open debts for one phone number (used by the buy pages). */
async function check(phone) {
  const p = last10(phone);
  if (p.length < 10) return { debts: [], total: 0 };
  const { data, error } = await supabaseAdmin
    .from('debts').select('*').eq('phone', p).eq('status', 'open').order('created_at', { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  const debts = (data || []).map(present);
  return { debts, total: money(debts.reduce((s, d) => s + d.balance, 0)) };
}

module.exports = { add, list, pay, remove, check };
