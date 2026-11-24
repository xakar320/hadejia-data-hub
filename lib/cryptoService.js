'use strict';

/**
 * lib/cryptoService.js — Crypto Trading (Phase 2: dashboard, demo account, admin control, key vault).
 *
 * Model: every customer trades on HIS OWN Bitget account with a trade-only API key.
 * We never hold customers' crypto. Hadejia Data Hub earns a performance fee (from the
 * customer's main wallet) on NET REALIZED profit above a high-water mark (Phase 3+).
 *
 *  - Demo money is virtual, kept in an append-only ledger, and can never mix with real money.
 *  - API keys are encrypted (AES-256-GCM, key from env CRYPTO_KEY_SECRET) and never returned.
 *  - Every admin change is audited (who / when / old / new / reason).
 *  - Live trading is OFF until admin turns on live_enabled AND the customer connected a key AND consented.
 */

const crypto = require('crypto');
const axios = require('axios');
const { supabaseAdmin } = require('./supabaseAdmin');
const { ValidationError } = require('./validation');

class CryptoError extends Error {
  constructor(message, code, statusCode) { super(message); this.name = 'CryptoError'; this.code = code || 'CRYPTO_ERROR'; this.statusCode = statusCode || 400; }
}
const bad = (field, msg) => { throw new ValidationError(msg, { details: [{ field, message: msg }] }); };

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  enabled: false,                 // master switch (OFF until admin turns it on)
  maintenance: { on: false, reason: '', message: '', eta: '' },
  demo_enabled: true,
  live_enabled: false,            // Live trading: OFF until admin allows
  keys_enabled: false,            // may customers connect a Bitget key?
  stop_new_trades: false,
  pause_all_bots: false,
  shutdown: false,                // emergency risk shutdown
  open_positions_on_maintenance: 'manage',   // manage = keep protecting open trades; hold = leave untouched
  min_investment_usd: 11,
  max_investment_usd: 1000,
  max_trades: 3,
  risk_per_trade_pct: 1,
  stop_loss_pct: 2,
  take_profit_pct: 4,
  trailing_pct: 1.5,
  daily_max_loss_pct: 5,
  min_confidence: 75,
  market_types_enabled: ['spot'], // spot is the only type the engine can trade today; futures/margin are locked
  demo_fee_pct: 0.1,
  demo_slippage_pct: 0.05,
  allowed_pairs: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'],
  platform_share_pct: 20,
  usd_ngn_rate: 1500,
  max_demo_fund_usd: 10000
};
const RANGES = {
  min_investment_usd: [1, 100000], max_investment_usd: [1, 1000000], max_trades: [1, 20], risk_per_trade_pct: [0.1, 10],
  stop_loss_pct: [0.2, 50], take_profit_pct: [0.2, 200], trailing_pct: [0.1, 50], daily_max_loss_pct: [0.5, 100],
  min_confidence: [1, 100], demo_fee_pct: [0, 1], demo_slippage_pct: [0, 1], platform_share_pct: [0, 90], usd_ngn_rate: [100, 10000], max_demo_fund_usd: [11, 1000000]
};
const BOOLS = ['enabled', 'demo_enabled', 'live_enabled', 'keys_enabled', 'stop_new_trades', 'pause_all_bots', 'shutdown'];

async function getSettings() {
  const { data } = await supabaseAdmin.from('crypto_settings').select('value').eq('key', 'config').maybeSingle();
  const v = (data && data.value) || {};
  return Object.assign({}, DEFAULTS, v, { maintenance: Object.assign({}, DEFAULTS.maintenance, v.maintenance || {}) });
}

function cleanPatch(patch) {
  const out = {};
  Object.keys(patch || {}).forEach((k) => {
    if (!(k in DEFAULTS)) return;
    let v = patch[k];
    if (BOOLS.includes(k)) { out[k] = v === true || v === 'true'; return; }
    if (RANGES[k]) {
      v = Number(v); const [lo, hi] = RANGES[k];
      if (!(v >= lo && v <= hi)) bad(k, `${k} must be between ${lo} and ${hi}`);
      out[k] = v; return;
    }
    if (k === 'allowed_pairs') {
      const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map(s => String(s).trim().toUpperCase()).filter(Boolean);
      if (!list.length || list.some(s => !/^[A-Z0-9]{3,15}USDT$/.test(s))) bad(k, 'Pairs must look like BTCUSDT (Spot USDT), separated by commas');
      out[k] = [...new Set(list)].slice(0, 50); return;
    }
    if (k === 'market_types_enabled') {
      const list = [...new Set((Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map(x => String(x).trim().toLowerCase()).filter(Boolean))];
      if (!list.length || list.some(x => !['spot', 'futures', 'margin'].includes(x))) bad(k, 'Choose from: spot, futures, margin');
      if (list.some(x => x !== 'spot')) bad(k, 'Futures and Margin trading are not available yet (they use leverage and need a legal review first). Only Spot can be enabled.');
      out[k] = list; return;
    }
    if (k === 'maintenance') {
      out[k] = { on: v.on === true || v.on === 'true', reason: String(v.reason || '').slice(0, 300), message: String(v.message || '').slice(0, 500), eta: String(v.eta || '').slice(0, 80) }; return;
    }
    if (k === 'open_positions_on_maintenance') {
      if (!['manage', 'hold'].includes(v)) bad(k, 'Must be manage or hold');
      out[k] = v;
    }
  });
  if (out.min_investment_usd !== undefined || out.max_investment_usd !== undefined) { /* cross-check later */ }
  return out;
}

async function adminUpdateSettings(adminUser, patch, reason) {
  reason = String(reason || '').trim();
  if (reason.length < 3) bad('reason', 'A reason is required for every change');
  const clean = cleanPatch(patch);
  if (!Object.keys(clean).length) bad('settings', 'Nothing to change');
  const cur = await getSettings();
  const next = Object.assign({}, cur, clean);
  if (next.min_investment_usd > next.max_investment_usd) bad('min_investment_usd', 'Minimum investment cannot be above the maximum');
  const changed = Object.keys(clean).filter(k => JSON.stringify(cur[k]) !== JSON.stringify(clean[k]));
  if (!changed.length) return cur;
  for (const k of changed) {
    const a = await supabaseAdmin.from('crypto_settings_audit').insert({ setting: k, old_value: cur[k] === undefined ? null : cur[k], new_value: clean[k], changed_by: adminUser.id, reason: reason.slice(0, 300) });
    if (a.error) throw new CryptoError('Could not write the audit log — change not applied', 'AUDIT_FAILED', 500);
  }
  const ex = await supabaseAdmin.from('crypto_settings').select('key').eq('key', 'config').maybeSingle();
  const row = { key: 'config', value: next, updated_by: adminUser.id, updated_at: new Date().toISOString() };
  const w = ex.data ? await supabaseAdmin.from('crypto_settings').update(row).eq('key', 'config') : await supabaseAdmin.from('crypto_settings').insert(row);
  if (w.error) throw new CryptoError('Could not save settings', 'DB_ERROR', 500);
  return next;
}

// ------------------------------------------------------------------ gating
function gate(s) {
  if (!s.enabled) return { open: false, message: 'Crypto Trading is currently disabled.' };
  if (s.maintenance.on) return { open: false, message: s.maintenance.message || 'Crypto Trading is under maintenance. Please check back later.', eta: s.maintenance.eta };
  if (s.shutdown) return { open: false, message: 'Crypto Trading has been paused for safety. Your account and history are still visible.' };
  return { open: true };
}
function canStartNew(s) { return gate(s).open && !s.stop_new_trades && !s.pause_all_bots; }

// ------------------------------------------------------------------ accounts
async function getAccount(userId) {
  const { data } = await supabaseAdmin.from('crypto_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (data) return data;
  const ins = await supabaseAdmin.from('crypto_accounts').insert({ user_id: userId }).select('*').maybeSingle();
  if (ins.error || !ins.data) {
    const again = await supabaseAdmin.from('crypto_accounts').select('*').eq('user_id', userId).maybeSingle();
    if (again.data) return again.data;
    throw new CryptoError('Could not open your crypto account', 'DB_ERROR', 500);
  }
  return ins.data;
}
const num = (x) => Number(x || 0);

async function overview(userId) {
  const s = await getSettings(); const acc = await getAccount(userId);
  const pos = await supabaseAdmin.from('crypto_positions').select('*').eq('user_id', userId).eq('mode', acc.mode);
  const rows = pos.data || []; const open = rows.filter(p => p.status === 'open'), closed = rows.filter(p => p.status === 'closed');
  const fund = await supabaseAdmin.from('crypto_demo_ledger').select('amount_usdt,type').eq('user_id', userId);
  const invested = (fund.data || []).filter(l => l.type === 'fund').reduce((a, l) => a + num(l.amount_usdt), 0);
  const realized = closed.reduce((a, p) => a + num(p.realized_pnl), 0);
  const fees = rows.reduce((a, p) => a + num(p.fees_usdt), 0);
  const inTrades = open.reduce((a, p) => a + num(p.cost_usdt), 0);
  const key = await supabaseAdmin.from('crypto_api_keys').select('key_hint,can_withdraw,has_ip_whitelist,verified_at,status').eq('user_id', userId).maybeSingle();
  const g = gate(s);
  const sc = await supabaseAdmin.from('crypto_scan').select('symbol,price,computed_at');
  const px = {}; (sc.data || []).forEach(r => { px[r.symbol] = r; });
  let unreal = 0, haveAll = true;
  const openList = open.map((p) => {
    const q = px[p.symbol]; const last = q ? num(q.price) : null;
    const val = last ? num(p.qty) * last : null; if (val == null) haveAll = false; else unreal += val - num(p.cost_usdt);
    return { id: p.id, symbol: p.symbol, entry_price: num(p.entry_price), price: last, cost_usdt: num(p.cost_usdt), pnl_usd: val == null ? null : val - num(p.cost_usdt), stop_price: num(p.stop_price), take_profit: num(p.take_profit), stop_kind: p.stop_kind || null, partial_done: !!p.partial_done, opened_at: p.opened_at, score: p.score };
  });
  const es = await supabaseAdmin.from('crypto_settings').select('value').eq('key', 'engine_status').maybeSingle();
  const lastRun = es.data && es.data.value && es.data.value.last_run;
  const engineAlive = !!lastRun && (Date.now() - new Date(lastRun).getTime()) < 5 * 60 * 1000;
  return {
    gate: g, settings: publicSettings(s),
    account: { mode: acc.mode, bot_status: acc.bot_status, bot_config: acc.bot_config || {}, display_currency: acc.display_currency, live_consent: !!acc.live_consent_at },
    numbers: {
      available_usd: num(acc.demo_balance), total_investment_usd: invested, in_trades_usd: inTrades,
      portfolio_value_usd: num(acc.demo_balance) + inTrades + (haveAll ? unreal : 0), realized_pnl_usd: realized, unrealized_pnl_usd: haveAll ? unreal : null,
      fees_usd: fees, commission_usd: 0, active_trades: open.length, completed_trades: closed.length
    },
    key: key.data || null,
    open_positions: openList,
    engine_ready: engineAlive, engine_last_run: lastRun || null,
    live_available: !!(s.live_enabled && key.data && key.data.status === 'verified' && acc.live_consent_at)
  };
}
function publicSettings(s) {
  return { enabled: s.enabled, maintenance: s.maintenance, demo_enabled: s.demo_enabled, live_enabled: s.live_enabled, keys_enabled: s.keys_enabled, stop_new_trades: s.stop_new_trades, pause_all_bots: s.pause_all_bots,
    min_investment_usd: s.min_investment_usd, max_investment_usd: s.max_investment_usd, max_trades: s.max_trades, market_types_enabled: s.market_types_enabled, min_confidence: s.min_confidence, usd_ngn_rate: s.usd_ngn_rate, platform_share_pct: s.platform_share_pct, allowed_pairs: s.allowed_pairs, max_demo_fund_usd: s.max_demo_fund_usd };
}

async function setCurrency(userId, cur) {
  if (!['NGN', 'USD', 'USDT'].includes(cur)) bad('currency', 'Choose NGN, USD or USDT');
  await getAccount(userId);
  await supabaseAdmin.from('crypto_accounts').update({ display_currency: cur, updated_at: new Date().toISOString() }).eq('user_id', userId);
  return { display_currency: cur };
}

// ------------------------------------------------------------------ demo money (virtual)
async function demoFund(userId, body) {
  const s = await getSettings(); if (!s.demo_enabled) throw new CryptoError('Demo trading is currently disabled', 'DEMO_OFF', 403);
  const kind = body.kind === 'reset' ? 'reset' : 'fund';
  const ref = String(body.request_ref || '').slice(0, 80); if (!/^[A-Za-z0-9\-_]{8,80}$/.test(ref)) bad('request_ref', 'Missing request reference');
  const acc = await getAccount(userId);
  const prior = await supabaseAdmin.from('crypto_demo_ledger').select('*').eq('ref', `DEMO-${userId}-${ref}`).maybeSingle();
  if (prior.data) return { balance: num(prior.data.balance_after), alreadyProcessed: true };
  const openPos = await supabaseAdmin.from('crypto_positions').select('id').eq('user_id', userId).eq('mode', 'demo').eq('status', 'open');
  if (kind === 'reset' && (openPos.data || []).length) throw new CryptoError('Close your open demo trades before resetting', 'OPEN_TRADES', 409);
  let amount = Number(body.amount_usd);
  if (kind === 'reset') amount = Math.max(num(body.amount_usd), s.min_investment_usd);
  if (!(amount >= s.min_investment_usd && amount <= s.max_demo_fund_usd)) bad('amount_usd', `Amount must be between $${s.min_investment_usd} and $${s.max_demo_fund_usd}`);
  const old = num(acc.demo_balance);
  const newBal = kind === 'reset' ? amount : old + amount;
  // compare-and-set so two taps at once cannot both apply
  const upd = await supabaseAdmin.from('crypto_accounts').update({ demo_balance: newBal, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('demo_balance', acc.demo_balance).select('user_id').maybeSingle();
  if (!upd.data) throw new CryptoError('Your balance changed, please try again', 'CONFLICT', 409);
  const led = await supabaseAdmin.from('crypto_demo_ledger').insert({ user_id: userId, type: kind, amount_usdt: newBal - old, balance_after: newBal, ref: `DEMO-${userId}-${ref}`, meta: { virtual: true } });
  if (led.error) throw new CryptoError('Could not record the demo transaction', 'DB_ERROR', 500);
  return { balance: newBal };
}

// ------------------------------------------------------------------ bot controls
async function botControl(userId, body) {
  const s = await getSettings(); const acc = await getAccount(userId); const act = String(body.action || '');
  if (!['start', 'pause', 'stop'].includes(act)) bad('action', 'Unknown action');
  if (act === 'start') {
    if (!canStartNew(s)) throw new CryptoError(gate(s).open ? 'New trades are temporarily stopped by the administrator.' : gate(s).message, 'BLOCKED', 403);
    if (acc.mode === 'demo' && !s.demo_enabled) throw new CryptoError('Demo trading is currently disabled', 'DEMO_OFF', 403);
    if (acc.mode === 'live') throw new CryptoError('Live trading is not available yet', 'LIVE_OFF', 403);
    const amt = Number(body.amount_usd);
    if (!(amt >= s.min_investment_usd && amt <= s.max_investment_usd)) bad('amount_usd', `Trading amount must be between $${s.min_investment_usd} and $${s.max_investment_usd}`);
    if (amt > num(acc.demo_balance)) throw new CryptoError('Your demo balance is lower than that amount', 'INSUFFICIENT_DEMO', 400);
    // market type: the customer's choice is a rule. Only spot can trade today; futures/margin stay locked.
    const mt = String(body.market_type || (acc.bot_config || {}).market_type || 'spot').toLowerCase();
    if (!['spot', 'futures', 'margin', 'auto'].includes(mt)) bad('market_type', 'Choose Spot, Futures, Margin or Auto');
    const enabled = s.market_types_enabled || ['spot'];
    if (mt === 'auto') { if (!enabled.includes('spot')) throw new CryptoError('No trading type is open right now', 'TYPE_OFF', 403); }
    else if (!enabled.includes(mt)) throw new CryptoError(mt === 'spot' ? 'Spot trading is switched off by the administrator' : (mt[0].toUpperCase() + mt.slice(1)) + ' trading is not available yet. Please choose Spot.', 'TYPE_OFF', 403);
    const cfg = Object.assign({}, acc.bot_config || {}, { amount_usd: amt, market_type: mt, started_at: new Date().toISOString() });
    await supabaseAdmin.from('crypto_accounts').update({ bot_status: 'running', bot_config: cfg, updated_at: new Date().toISOString() }).eq('user_id', userId);
    return { bot_status: 'running' };
  }
  const st = act === 'pause' ? 'paused' : 'stopped';
  await supabaseAdmin.from('crypto_accounts').update({ bot_status: st, updated_at: new Date().toISOString() }).eq('user_id', userId);
  // Pause = no new buys, open trades keep being protected. Stop = close every open demo trade now.
  if (act === 'stop' && acc.mode === 'demo') {
    let r = { closed: 0, pending: 0 };
    try { r = await require('./cryptoEngine').closeAllForUser(userId, 'user_stop'); } catch (e) { console.error('[crypto] stop close', e && e.message); r = { closed: 0, pending: -1 }; }
    return { bot_status: st, closed_trades: r.closed, closing_in_progress: r.pending !== 0 };
  }
  return { bot_status: st };
}

async function setMode(userId, mode) {
  if (!['demo', 'live'].includes(mode)) bad('mode', 'Mode must be demo or live');
  const s = await getSettings(); const acc = await getAccount(userId);
  if (acc.bot_status === 'running') throw new CryptoError('Stop the bot before switching mode', 'BOT_RUNNING', 409);
  if (mode === 'live') {
    if (!s.live_enabled) throw new CryptoError('Live trading is not enabled yet', 'LIVE_OFF', 403);
    const k = await supabaseAdmin.from('crypto_api_keys').select('status').eq('user_id', userId).maybeSingle();
    if (!k.data || k.data.status !== 'verified') throw new CryptoError('Connect and verify your Bitget key first', 'NO_KEY', 400);
    if (!acc.live_consent_at) throw new CryptoError('You must accept the live trading risk agreement first', 'NO_CONSENT', 400);
  }
  await supabaseAdmin.from('crypto_accounts').update({ mode, updated_at: new Date().toISOString() }).eq('user_id', userId);
  return { mode };
}

async function consent(userId) {
  await getAccount(userId);
  await supabaseAdmin.from('crypto_accounts').update({ live_consent_at: new Date().toISOString() }).eq('user_id', userId);
  return { ok: true };
}

// ------------------------------------------------------------------ API key vault
function vaultKey() {
  const secret = process.env.CRYPTO_KEY_SECRET;
  if (!secret || secret.length < 32) throw new CryptoError('API key storage is not configured (CRYPTO_KEY_SECRET missing)', 'NOT_CONFIGURED', 503);
  return crypto.createHash('sha256').update(secret).digest();
}
function enc(plain) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv); const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.'); }
function dec(s) { const [iv, tag, ct] = String(s).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', vaultKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); }

// Bitget v2 signed GET (used to verify a key and, later, to trade)
async function bitgetGet(path, key, secret, pass) {
  const ts = String(Date.now());
  const sign = crypto.createHmac('sha256', secret).update(ts + 'GET' + path).digest('base64');
  return axios.get('https://api.bitget.com' + path, {
    headers: { 'ACCESS-KEY': key, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': pass, 'Content-Type': 'application/json', locale: 'en-US' },
    timeout: 15000, validateStatus: () => true
  });
}

async function saveKeys(userId, body) {
  const s = await getSettings();
  if (!s.keys_enabled) throw new CryptoError('Connecting a Bitget key is not open yet', 'KEYS_OFF', 403);
  const key = String(body.api_key || '').trim(), secret = String(body.api_secret || '').trim(), pass = String(body.passphrase || '').trim();
  if (!/^[\w\-]{8,100}$/.test(key) || !/^[\w\-]{8,200}$/.test(secret) || pass.length < 1 || pass.length > 100) bad('api_key', 'Check your API key, secret and passphrase');
  vaultKey();                                   // fail early if storage is not configured
  let res;
  try { res = await bitgetGet('/api/v2/spot/account/info', key, secret, pass); } catch (e) { throw new CryptoError('Could not reach Bitget. Try again shortly.', 'EXCHANGE_DOWN', 502); }
  const d = res.data || {};
  if (res.status !== 200 || String(d.code) !== '00000') throw new CryptoError('Bitget rejected this key. Check the key, secret and passphrase.', 'KEY_REJECTED', 400);
  const info = d.data || {};
  const auth = JSON.stringify(info.authorities || info.permissions || []).toLowerCase();
  if (/withdraw|transfer/.test(auth)) throw new CryptoError('This key has withdrawal/transfer permission. Create a new key with TRADE permission only (no withdrawal).', 'UNSAFE_KEY', 400);
  const hasIp = Array.isArray(info.ips) ? info.ips.length > 0 : !!String(info.ips || '').trim();
  const row = { user_id: userId, exchange: 'bitget', key_enc: enc(key), secret_enc: enc(secret), passphrase_enc: enc(pass), key_hint: key.slice(-4), can_withdraw: false, has_ip_whitelist: hasIp, verified_at: new Date().toISOString(), status: 'verified' };
  const ex = await supabaseAdmin.from('crypto_api_keys').select('user_id').eq('user_id', userId).maybeSingle();
  const w = ex.data ? await supabaseAdmin.from('crypto_api_keys').update(row).eq('user_id', userId) : await supabaseAdmin.from('crypto_api_keys').insert(row);
  if (w.error) throw new CryptoError('Could not save your key', 'DB_ERROR', 500);
  return { key_hint: row.key_hint, has_ip_whitelist: hasIp, verified: true };
}
async function deleteKeys(userId) {
  const acc = await getAccount(userId);
  if (acc.mode === 'live' && acc.bot_status !== 'stopped') throw new CryptoError('Stop the live bot first', 'BOT_RUNNING', 409);
  await supabaseAdmin.from('crypto_api_keys').delete().eq('user_id', userId);
  await supabaseAdmin.from('crypto_accounts').update({ mode: 'demo', live_consent_at: null }).eq('user_id', userId);
  return { ok: true };
}

// ------------------------------------------------------------------ coin scanner (read-only, from the engine's last scan)
async function scanView() {
  const s = await getSettings();
  const r = await supabaseAdmin.from('crypto_scan').select('symbol,price,score,decision,analysis,computed_at');
  const rows = (r.data || []).filter(x => (s.allowed_pairs || []).includes(x.symbol)).map((x) => {
    const a = x.analysis || {};
    return { symbol: x.symbol, price: num(x.price), score: x.score, decision: x.decision, signals: a.signals || [], vetoes: a.vetoes || [], patience: a.patience || null, rsi: a.rsi, spread_pct: a.spread_pct, support: a.support, resistance: a.resistance, change24h: a.change24h, computed_at: x.computed_at };
  }).sort((a, b) => b.score - a.score);
  const newest = rows.reduce((m, x) => Math.max(m, new Date(x.computed_at).getTime()), 0);
  return { rows, min_confidence: s.min_confidence, stale: !newest || Date.now() - newest > 5 * 60 * 1000, updated_at: newest ? new Date(newest).toISOString() : null };
}

// ------------------------------------------------------------------ history
async function history(userId) {
  const acc = await getAccount(userId);
  const p = await supabaseAdmin.from('crypto_positions').select('id,symbol,status,entry_price,exit_price,cost_usdt,fees_usdt,realized_pnl,close_reason,opened_at,closed_at,score').eq('user_id', userId).eq('mode', acc.mode).order('opened_at', { ascending: false }).limit(100);
  const l = await supabaseAdmin.from('crypto_demo_ledger').select('type,amount_usdt,balance_after,created_at').eq('user_id', userId).order('id', { ascending: false }).limit(50);
  return { trades: p.data || [], demo_ledger: l.data || [] };
}

// ------------------------------------------------------------------ admin
async function adminOverview() {
  const s = await getSettings();
  const a = await supabaseAdmin.from('crypto_accounts').select('user_id,mode,bot_status,demo_balance,display_currency,updated_at');
  const keys = await supabaseAdmin.from('crypto_api_keys').select('user_id,key_hint,has_ip_whitelist,status');
  const keyMap = {}; (keys.data || []).forEach(k => { keyMap[k.user_id] = k; });
  const ids = (a.data || []).map(x => x.user_id); let users = {};
  if (ids.length) { const u = await supabaseAdmin.from('users').select('id,full_name,email,phone').in('id', ids); (u.data || []).forEach(x => { users[x.id] = x; }); }
  const audit = await supabaseAdmin.from('crypto_settings_audit').select('*').order('id', { ascending: false }).limit(40);
  return {
    settings: s, engine: await engineStatus(), key_storage_configured: !!(process.env.CRYPTO_KEY_SECRET && process.env.CRYPTO_KEY_SECRET.length >= 32),
    accounts: (a.data || []).map(x => Object.assign({}, x, { customer: users[x.user_id] || null, key: keyMap[x.user_id] ? { hint: keyMap[x.user_id].key_hint, ip: keyMap[x.user_id].has_ip_whitelist } : null })),
    audit: audit.data || []
  };
}

async function engineStatus() {
  const es = await supabaseAdmin.from('crypto_settings').select('value').eq('key', 'engine_status').maybeSingle();
  const v = (es.data && es.data.value) || null;
  const open = await supabaseAdmin.from('crypto_positions').select('id').eq('status', 'open');
  return { last_run: v && v.last_run, alive: !!(v && v.last_run && Date.now() - new Date(v.last_run).getTime() < 5 * 60 * 1000), last: v, open_positions: (open.data || []).length };
}

/** Emergency actions — each one is audited. */
async function adminEmergency(adminUser, action, reason) {
  reason = String(reason || '').trim(); if (reason.length < 3) bad('reason', 'A reason is required');
  if (action === 'pause_all') {
    await adminUpdateSettings(adminUser, { pause_all_bots: true }, reason);
    await supabaseAdmin.from('crypto_accounts').update({ bot_status: 'admin_paused' }).eq('bot_status', 'running');
  } else if (action === 'resume_all') {
    await adminUpdateSettings(adminUser, { pause_all_bots: false, shutdown: false, stop_new_trades: false }, reason);
    await supabaseAdmin.from('crypto_accounts').update({ bot_status: 'running' }).eq('bot_status', 'admin_paused');
  } else if (action === 'stop_new_trades') {
    await adminUpdateSettings(adminUser, { stop_new_trades: true }, reason);
  } else if (action === 'allow_new_trades') {
    await adminUpdateSettings(adminUser, { stop_new_trades: false }, reason);
  } else if (action === 'shutdown') {
    await adminUpdateSettings(adminUser, { shutdown: true, stop_new_trades: true, pause_all_bots: true }, reason);
    await supabaseAdmin.from('crypto_accounts').update({ bot_status: 'admin_paused' }).eq('bot_status', 'running');
  } else if (action === 'close_all') {
    // pause every bot, then sell every open demo trade at the current price
    await adminUpdateSettings(adminUser, { pause_all_bots: true, stop_new_trades: true }, reason);
    await supabaseAdmin.from('crypto_accounts').update({ bot_status: 'admin_paused' }).eq('bot_status', 'running');
    await require('./cryptoEngine').closeAllUsers('admin_close_all');
  } else bad('action', 'Unknown emergency action');
  return adminOverview();
}

module.exports = {
  CryptoError, DEFAULTS, getSettings, adminUpdateSettings, overview, setCurrency, demoFund, botControl, setMode, consent,
  saveKeys, deleteKeys, history, scanView, adminOverview, adminEmergency, gate, canStartNew, _enc: enc, _dec: dec
};
