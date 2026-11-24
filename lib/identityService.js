'use strict';

/**
 * lib/identityService.js — Identity Verification services (NIN, BVN, ...).
 *
 *  - Price + on/off come from the DB (identity_services), never from the browser.
 *  - ONE verification = ONE wallet debit (reference IDV-<record id>, idempotent).
 *    Viewing / re-downloading an old result never calls the provider and never
 *    touches the wallet (see get() / docUrl(): they only READ).
 *  - Provider says "no record" / error  -> record failed + automatic refund (once).
 *  - Provider timeout (unknown)         -> record stays PENDING, NO refund; admin
 *    resolves it (retry or fail+refund) so nobody is refunded for a delivered result.
 *  - Customers only ever read their own records (every query is scoped to userId).
 */

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabaseAdmin');
const wallet = require('./wallet');
const { verifyPin } = require('./auth');
const { ValidationError, validatePin, isValidRequestRef } = require('./validation');
const provider = require('./identityProvider');

const BUCKET = 'verification-docs';

class IdError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'IdentityError';
    this.code = code || 'IDENTITY_ERROR';
    this.statusCode = statusCode || 400;
  }
}

const money = (n) => Math.round(Number(n) * 100) / 100;

function bad(field, message) {
  throw new ValidationError(message, { details: [{ field, message }] });
}

function reportId(code) {
  const tag = String(code).replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 4);
  return `HDH-${tag}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function stateOf(svc) {
  const configured = provider.isConfigured(svc.code);
  const priced = Number(svc.price) > 0;
  let state = 'available';
  if (!configured) state = 'not_configured';
  else if (!svc.enabled || !priced) state = 'disabled';
  return { configured, state };
}

function presentService(svc) {
  const s = stateOf(svc);
  return {
    code: svc.code, name: svc.name, icon: svc.icon, category: svc.category,
    description: svc.description, price: Number(svc.price), enabled: !!svc.enabled,
    configured: s.configured, state: s.state, input_fields: svc.input_fields || []
  };
}

async function listServices() {
  const { data, error } = await supabaseAdmin
    .from('identity_services').select('*').order('sort_order', { ascending: true });
  if (error) throw new IdError(`Could not load services: ${error.message}. Did you run IDENTITY_SQL.sql?`, 'DB_ERROR', 500);
  return (data || []).map(presentService);
}

async function getService(code) {
  const { data, error } = await supabaseAdmin.from('identity_services').select('*').eq('code', String(code || '')).maybeSingle();
  if (error) throw new IdError('Could not load service', 'DB_ERROR', 500);
  return data || null;
}

// What a customer is allowed to see in the history list (no payload).
function row(r) {
  return {
    id: r.id, report_id: r.report_id, service_code: r.service_code, service_name: r.service_name,
    status: r.status, amount: Number(r.amount), subject_name: r.subject_name, id_masked: r.id_masked,
    created_at: r.created_at, completed_at: r.completed_at, error: r.status === 'failed' ? r.error : null,
    refunded: !!r.refunded, has_slip: Array.isArray(r.documents) && r.documents.some(d => d.kind === 'slip'),
    has_photo: Array.isArray(r.documents) && r.documents.some(d => d.kind === 'photo')
  };
}

async function findByRef(userId, requestRef) {
  const { data } = await supabaseAdmin.from('verification_records').select('*')
    .eq('user_id', userId).eq('request_ref', requestRef).maybeSingle();
  return data || null;
}

function validateInput(svc, input) {
  const clean = {};
  const details = [];
  (svc.input_fields || []).forEach((f) => {
    const v = String((input && input[f.key]) == null ? '' : input[f.key]).trim();
    if (!v && !(f.pattern && new RegExp(f.pattern).test(''))) {
      details.push({ field: f.key, message: `${f.label || f.key} is required` });
      return;
    }
    if (f.pattern && !new RegExp(f.pattern).test(v)) {
      details.push({ field: f.key, message: `${f.label || f.key} is not valid${f.hint ? ' (' + f.hint + ')' : ''}` });
      return;
    }
    clean[f.key] = v;
  });
  if (details.length) throw new ValidationError(details[0].message, { details });
  return clean;
}

async function storeFile(userId, recordId, name, base64, mime) {
  const path = `${userId}/${recordId}/${name}`;
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, Buffer.from(base64, 'base64'), {
    contentType: mime, upsert: true
  });
  if (error) { console.error('[identity] storage upload failed:', error.message); return null; }
  return path;
}

async function refundOnce(rec) {
  if (!rec.debited || rec.refunded) return;
  await wallet.refundDebit({
    userId: rec.user_id, amount: Number(rec.amount), originalReference: rec.transaction_ref,
    description: `Refund: ${rec.service_name} verification (${rec.report_id})`
  });
  await supabaseAdmin.from('verification_records').update({ refunded: true }).eq('id', rec.id);
}

// pending -> failed (guarded, so it only ever happens once) + refund
async function failRecord(rec, message) {
  const { data } = await supabaseAdmin.from('verification_records')
    .update({ status: 'failed', error: String(message || 'Failed').slice(0, 300), completed_at: new Date().toISOString(), input_data: null })
    .eq('id', rec.id).eq('status', 'pending').select('*').maybeSingle();
  if (!data) return (await supabaseAdmin.from('verification_records').select('*').eq('id', rec.id).single()).data;
  await refundOnce(data);
  return { ...data, refunded: data.debited };
}

async function succeedRecord(rec, out) {
  const documents = [];
  if (out.photo) {
    const p = await storeFile(rec.user_id, rec.id, 'photo.jpg', out.photo, 'image/jpeg');
    if (p) documents.push({ kind: 'photo', path: p, filename: `${rec.report_id}-photo.jpg`, mime: 'image/jpeg' });
  }
  for (const d of out.documents || []) {
    const p = await storeFile(rec.user_id, rec.id, `slip.${d.ext}`, d.base64, d.mime);
    if (p) documents.push({ kind: d.kind, path: p, filename: `${rec.report_id}-slip.${d.ext}`, mime: d.mime });
  }
  const { data } = await supabaseAdmin.from('verification_records').update({
    status: 'success', result_data: out.result, subject_name: (out.result.name || '').slice(0, 160) || null,
    id_masked: out.idMasked || null, provider: (provider.getSpec(rec.service_code) || {}).provider || null,
    provider_ref: out.providerRef, documents, error: null, input_data: null, completed_at: new Date().toISOString()
  }).eq('id', rec.id).eq('status', 'pending').select('*').maybeSingle();
  return data || (await supabaseAdmin.from('verification_records').select('*').eq('id', rec.id).single()).data;
}

async function runProvider(rec, input) {
  const out = await provider.call(rec.service_code, input);
  if (out.outcome === 'success') return { rec: await succeedRecord(rec, out), message: 'Verification successful' };
  if (out.outcome === 'failed') return { rec: await failRecord(rec, out.message), message: out.message };
  return { rec, message: 'Your request is still being confirmed. You have not been refunded yet and will not be charged twice. It will be resolved shortly.' };
}

/** Run ONE verification. Re-submitting the same request_ref returns the same record (no second charge). */
async function verify(user, body) {
  const svc = await getService(body.service);
  if (!svc) bad('service', 'Unknown service');
  const st = stateOf(svc);
  if (st.state === 'not_configured') throw new IdError('This service is not configured yet', 'NOT_CONFIGURED', 503);
  if (st.state === 'disabled') throw new IdError('This service is currently unavailable', 'SERVICE_DISABLED', 403);

  const input = validateInput(svc, body.fields || {});
  validatePin(String(body.pin || ''));
  const requestRef = isValidRequestRef(body.request_ref) ? body.request_ref : crypto.randomUUID();

  const existing = await findByRef(user.id, requestRef);
  if (existing) return { record: row(existing), message: 'This request was already processed', alreadyProcessed: true };

  await verifyPin(user.id, String(body.pin));

  const price = money(svc.price);          // price comes from the DB only
  const bal = await wallet.getBalance(user.id);
  if (bal < price) throw new wallet.InsufficientFundsError('Insufficient wallet balance. Please fund your wallet.');

  const id = crypto.randomUUID();
  const ins = await supabaseAdmin.from('verification_records').insert({
    id, user_id: user.id, report_id: reportId(svc.code), service_code: svc.code, service_name: svc.name,
    request_ref: requestRef, status: 'pending', amount: price, transaction_ref: `IDV-${id}`, input_data: input
  }).select('*').single();
  if (ins.error) {
    if (ins.error.code === '23505') {            // same request twice at once
      const again = await findByRef(user.id, requestRef);
      if (again) return { record: row(again), message: 'This request was already processed', alreadyProcessed: true };
    }
    throw new IdError('Could not start verification. Please try again.', 'DB_ERROR', 500);
  }
  let rec = ins.data;

  try {
    await wallet.debitWallet({
      userId: user.id, amount: price, source: 'purchase',
      description: `${svc.name} verification (${rec.report_id})`, reference: rec.transaction_ref
    });
  } catch (e) {
    await supabaseAdmin.from('verification_records').update({
      status: 'failed', error: 'Payment failed', completed_at: new Date().toISOString(), input_data: null
    }).eq('id', id).eq('status', 'pending');
    throw e;
  }
  await supabaseAdmin.from('verification_records').update({ debited: true }).eq('id', id);
  rec = { ...rec, debited: true };

  const r = await runProvider(rec, input);
  return { record: row(r.rec), message: r.message };
}

async function history(userId, q) {
  q = q || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 50);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  let query = supabaseAdmin.from('verification_records')
    .select('id,report_id,service_code,service_name,status,amount,subject_name,id_masked,created_at,completed_at,error,refunded,documents', { count: 'exact' })
    .eq('user_id', userId).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (['pending', 'success', 'failed'].includes(q.status)) query = query.eq('status', q.status);
  if (q.service) query = query.eq('service_code', String(q.service));
  const s = String(q.search || '').trim().replace(/[%,()*]/g, ' ').slice(0, 60);
  if (s) query = query.or(`subject_name.ilike.%${s}%,report_id.ilike.%${s}%,service_name.ilike.%${s}%,id_masked.ilike.%${s}%`);
  const { data, error, count } = await query;
  if (error) throw new IdError('Could not load history', 'DB_ERROR', 500);
  return { rows: (data || []).map(row), total: count || 0 };
}

/** Old result — READ ONLY: no provider call, no wallet movement. */
async function get(user, id) {
  const { data } = await supabaseAdmin.from('verification_records').select('*').eq('id', String(id || '')).eq('user_id', user.id).maybeSingle();
  if (!data) throw new IdError('Record not found', 'NOT_FOUND', 404);
  const out = { ...row(data), result: data.result_data || null, customer_name: user.fullName || user.email || '' };
  const photo = (data.documents || []).find(d => d.kind === 'photo');
  if (photo) {
    const dl = await supabaseAdmin.storage.from(BUCKET).download(photo.path);
    if (dl.data) {
      const buf = Buffer.from(await dl.data.arrayBuffer());
      out.photo_data_url = 'data:image/jpeg;base64,' + buf.toString('base64');
    }
  }
  return out;
}

/** Short-lived signed URL for a stored provider document (slip/photo) — owner only. */
async function docUrl(user, id, kind) {
  const { data } = await supabaseAdmin.from('verification_records').select('documents').eq('id', String(id || '')).eq('user_id', user.id).maybeSingle();
  const doc = data && (data.documents || []).find(d => d.kind === kind);
  if (!doc) throw new IdError('Document not available', 'NOT_FOUND', 404);
  const { data: s, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(doc.path, 120, { download: doc.filename });
  if (error || !s) throw new IdError('Could not prepare the download', 'STORAGE_ERROR', 500);
  return { url: s.signedUrl, filename: doc.filename };
}

// ---------------------------- admin ----------------------------------------
async function adminServices() {
  return listServices();
}

async function adminUpdateService(body) {
  const svc = await getService(body.code);
  if (!svc) bad('code', 'Unknown service');
  const patch = { updated_at: new Date().toISOString() };
  if (body.price !== undefined) {
    const p = money(body.price);
    if (!(p >= 0) || p > 1000000) bad('price', 'Enter a valid price');
    patch.price = p;
  }
  if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 80) || svc.name;
  if (body.icon !== undefined) patch.icon = String(body.icon).trim().slice(0, 8) || svc.icon;
  if (body.enabled !== undefined) {
    const on = body.enabled === true || body.enabled === 'true';
    const price = patch.price !== undefined ? patch.price : Number(svc.price);
    if (on && !provider.isConfigured(svc.code)) throw new IdError('Cannot enable: provider is NOT CONFIGURED for this service (set the environment variables first)', 'NOT_CONFIGURED', 400);
    if (on && !(price > 0)) throw new IdError('Set a price above 0 before enabling', 'PRICE_REQUIRED', 400);
    patch.enabled = on;
  }
  const { error } = await supabaseAdmin.from('identity_services').update(patch).eq('code', svc.code);
  if (error) throw new IdError('Could not save', 'DB_ERROR', 500);
  return presentService({ ...svc, ...patch });
}

async function adminRecords(q) {
  q = q || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 30, 1), 100);
  let query = supabaseAdmin.from('verification_records')
    .select('id,user_id,report_id,service_code,service_name,status,amount,transaction_ref,debited,refunded,subject_name,id_masked,created_at,completed_at,error,provider')
    .order('created_at', { ascending: false }).limit(limit);
  if (['pending', 'success', 'failed'].includes(q.status)) query = query.eq('status', q.status);
  if (q.user_id) query = query.eq('user_id', String(q.user_id));
  const s = String(q.search || '').trim().replace(/[%,()*]/g, ' ').slice(0, 60);
  if (s) query = query.or(`report_id.ilike.%${s}%,service_name.ilike.%${s}%,transaction_ref.ilike.%${s}%`);
  const { data, error } = await query;
  if (error) throw new IdError('Could not load records', 'DB_ERROR', 500);
  const ids = [...new Set((data || []).map(r => r.user_id))];
  let users = {};
  if (ids.length) {
    const u = await supabaseAdmin.from('users').select('id,full_name,email,phone').in('id', ids);
    (u.data || []).forEach(x => { users[x.id] = x; });
  }
  // Admin sees status/amount/report id only — never the person's identity data.
  return (data || []).map(r => ({ ...r, customer: users[r.user_id] || null }));
}

/** Resolve a stuck PENDING record: 'fail' (refund once) or 'retry' (call provider again, still one charge). */
async function adminResolve(id, action) {
  const { data: rec } = await supabaseAdmin.from('verification_records').select('*').eq('id', String(id || '')).maybeSingle();
  if (!rec) throw new IdError('Record not found', 'NOT_FOUND', 404);
  if (rec.status !== 'pending') throw new IdError(`Record is already ${rec.status}`, 'INVALID_STATE', 409);
  if (action === 'fail') {
    const r = await failRecord(rec, 'Cancelled by admin');
    return row(r);
  }
  if (action === 'retry') {
    if (!rec.input_data || !Object.keys(rec.input_data).length) throw new IdError('Original input not available — use fail + refund', 'NO_INPUT', 400);
    const r = await runProvider(rec, rec.input_data);
    return row(r.rec);
  }
  bad('action', 'action must be retry or fail');
}

module.exports = {
  IdError, listServices, verify, history, get, docUrl,
  adminServices, adminUpdateService, adminRecords, adminResolve
};
