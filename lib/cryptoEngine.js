'use strict';

/**
 * lib/cryptoEngine.js — Crypto Trading, Phase 3: DEMO trading engine.
 *
 * Runs once a minute (cron-job.org -> POST /api/place-order?action=crypto-cron).
 * Everything here uses VIRTUAL money (crypto_demo_ledger). Nothing here can touch a
 * real exchange account: there is no order-placing code for Bitget in this file.
 *
 * Each cycle:
 *   1. read public Bitget prices + candles (no keys needed) and score every allowed pair
 *   2. for each customer with a running bot (or open demo trades): lock the account,
 *      manage open trades (stop-loss, break-even, partial profit, trailing stop,
 *      take-profit, reversal exit), then — only if allowed — open new trades.
 *
 * Safety rules: per-account lock (no double runs), idempotent ledger refs,
 * compare-and-set on balances and on closing a position, admin gates respected,
 * daily max-loss, cooldown after a closed trade, minimum confidence + hard vetoes.
 * No profit is guaranteed — the score only filters out weak setups.
 */

const crypto = require('crypto');
const axios = require('axios');
const { supabaseAdmin } = require('./supabaseAdmin');

const svc = () => require('./cryptoService');
const num = (x) => Number(x || 0);
const r8 = (x) => Math.round(Number(x) * 1e8) / 1e8;
const MIN_TRADE_USD = 5;           // smallest trade the bot will open
const COOLDOWN_MIN = 30;           // wait after closing a pair before re-entering it
const REVERSAL_MIN_AGE_MIN = 15;   // do not exit on "reversal" in the first minutes
const BE_MARGIN = 0.0025;          // break-even stop sits 0.25% above entry (covers fees)

// ============================================================ indicators (pure)
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period; out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= period; l /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = [];
  for (let i = 0; i < closes.length; i++) if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]);
  if (line.length < sig + 2) return null;
  const sg = ema(line, sig); const n = line.length - 1;
  return { line: line[n], signal: sg[n], hist: line[n] - sg[n], prevHist: line[n - 1] - sg[n - 1] };
}
function atr(c, period = 14) {
  if (c.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function btcContext(c1h) {
  if (!c1h || c1h.length < 60) return { ok: false, trendUp: false, roc4: 0 };
  const cl = c1h.map(x => x.c), n = cl.length;
  const e20 = ema(cl, 20)[n - 1], e50 = ema(cl, 50)[n - 1];
  return { ok: true, trendUp: e20 > e50, roc4: (cl[n - 1] / cl[n - 5] - 1) * 100 };
}

/** Score one pair. c1 = 1h candles, c15 = 15m candles (ascending), tick = {price,bid,ask,usdtVol}. */
function analyse(symbol, c1, c15, btc, tick, s) {
  const out = { symbol, score: 0, decision: 'avoid', signals: [], vetoes: [], computed_at: new Date().toISOString() };
  if (!c1 || c1.length < 60 || !c15 || c15.length < 40 || !tick || !(tick.price > 0)) {
    out.vetoes.push('Not enough market data'); return out;
  }
  const closes = c1.map(x => x.c), n = closes.length, price = tick.price;
  const E20 = ema(closes, 20)[n - 1], E50 = ema(closes, 50)[n - 1], E200 = ema(closes, 200)[n - 1];
  const R = rsi(closes, 14), M = macd(closes), A = atr(c1, 14);
  if (R == null || !M || A == null) { out.vetoes.push('Not enough market data'); return out; }
  const atrPct = A / price * 100;
  const cl15 = c15.map(x => x.c), m15 = macd(cl15), e20_15 = ema(cl15, 20), e50_15 = ema(cl15, 50), r15 = rsi(cl15, 14);
  const n15 = cl15.length;
  const vols = c1.map(x => x.v);
  const volRatio = mean(vols.slice(-4, -1)) / (mean(vols.slice(-24, -4)) || 1);
  // structure
  const prior20 = Math.max(...c1.slice(-21, -1).map(x => x.h));
  const breakout = closes[n - 1] > prior20;
  let falseBreakout = false;
  for (let k = 1; k <= 3; k++) {
    const i = n - k; if (i < 21) break;
    const Ri = Math.max(...c1.slice(i - 20, i).map(x => x.h));
    if (c1[i].h > Ri && c1[i].c < Ri) falseBreakout = true;
  }
  const resistance = Math.max(...c1.slice(-49, -1).map(x => x.h));
  const support = Math.min(...c1.slice(-49, -1).map(x => x.l));
  const roomPct = (resistance - price) / price * 100;
  const spreadPct = (tick.ask > 0 && tick.bid > 0) ? (tick.ask - tick.bid) / price * 100 : null;
  const isBtc = symbol === 'BTCUSDT';

  const add = (k, label, pts, max, note) => { out.signals.push({ k, label, pts: Math.round(pts), max, note }); out.score += pts; };
  // trend (25)
  let t = 0; if (price > E50) t += 10; if (E20 > E50) t += 8; if (E200 == null) t += 3; else if (E50 > E200) t += 7;
  add('trend', 'Trend (EMA 20/50/200)', t, 25, price > E50 && E20 > E50 ? 'Uptrend' : 'No clear uptrend');
  // RSI (10)
  const rp = (R >= 50 && R <= 68) ? 10 : (R >= 40 && R < 50) ? 5 : (R > 68 && R <= 75) ? 4 : 0;
  add('rsi', 'RSI 14', rp, 10, 'RSI ' + R.toFixed(0));
  // MACD (15)
  let mp = 0; if (M.hist > 0) mp += 8; if (M.hist > M.prevHist) mp += 7;
  add('macd', 'MACD momentum', mp, 15, M.hist > 0 ? 'Bullish' : 'Bearish');
  // 15m confirmation (10)
  let cp = 0; if (e20_15[n15 - 1] != null && cl15[n15 - 1] > e20_15[n15 - 1]) cp += 5; if (m15 && m15.hist > 0) cp += 5;
  add('m15', '15-minute confirmation', cp, 10, cp >= 10 ? 'Confirmed' : cp ? 'Partly' : 'Not confirmed');
  // volume (10)
  const vp = volRatio >= 1.5 ? 10 : volRatio >= 1.2 ? 7 : volRatio >= 0.9 ? 4 : 0;
  add('volume', 'Volume', vp, 10, 'x' + volRatio.toFixed(2) + ' of average');
  // structure (10)
  let sp = 0; if (breakout) sp += 5; if (roomPct >= Math.max(1.5 * atrPct, 1)) sp += 5;
  add('structure', 'Breakout / room to resistance', sp, 10, (breakout ? 'Breakout. ' : '') + 'Room ' + roomPct.toFixed(1) + '%');
  // Bitcoin direction (10)
  let bp = 0;
  if (btc && btc.ok) { if (btc.trendUp && btc.roc4 > -0.5) bp = 10; else if (btc.roc4 > -1) bp = 5; }
  add('btc', 'Bitcoin direction', bp, 10, btc && btc.ok ? (btc.trendUp ? 'Bitcoin up' : 'Bitcoin weak') : 'No data');
  // liquidity (10)
  let lp = 0; if (spreadPct != null) lp += spreadPct <= 0.05 ? 5 : spreadPct <= 0.15 ? 3 : 0; else lp += 2;
  lp += tick.usdtVol >= 5e6 ? 5 : tick.usdtVol >= 1e6 ? 3 : 0;
  add('liq', 'Liquidity & spread', lp, 10, 'Spread ' + (spreadPct == null ? 'n/a' : spreadPct.toFixed(3) + '%'));

  // hard vetoes (a high score can never override these)
  if (R > 78) out.vetoes.push('Overbought (RSI above 78)');
  if (price < E50 && E20 < E50) out.vetoes.push('Downtrend');
  if (falseBreakout) out.vetoes.push('Recent false breakout');
  if (atrPct > 6) out.vetoes.push('Too volatile');
  if (spreadPct != null && spreadPct > 0.3) out.vetoes.push('Spread too wide');
  if (tick.usdtVol < 5e5) out.vetoes.push('Low trading volume');
  if (btc && btc.ok && btc.roc4 < (isBtc ? -3 : -2)) out.vetoes.push('Bitcoin falling fast');

  out.score = Math.round(out.score);
  out.decision = out.vetoes.length ? 'avoid' : (out.score >= s.min_confidence ? 'buy' : 'wait');
  // patience rule: a high total is not enough — trend, momentum and the 15-minute chart must ALL agree
  if (out.decision === 'buy' && (t < 18 || mp < 8 || cp < 5)) {
    out.decision = 'wait'; out.patience = 'Waiting: trend, momentum and 15-minute chart do not all agree yet';
  }
  // reversal flag, used to exit open trades
  out.reversal = !!(m15 && m15.hist < 0 && e20_15[n15 - 1] != null && e50_15[n15 - 1] != null && cl15[n15 - 1] < e20_15[n15 - 1] && e20_15[n15 - 1] < e50_15[n15 - 1] && r15 != null && r15 < 45 && M.hist < 0);
  Object.assign(out, {
    price, bid: tick.bid || null, ask: tick.ask || null, rsi: +R.toFixed(1), macd_hist: M.hist, ema20: E20, ema50: E50, ema200: E200,
    atr_pct: +atrPct.toFixed(3), support, resistance, vol_ratio: +volRatio.toFixed(2), spread_pct: spreadPct == null ? null : +spreadPct.toFixed(4),
    vol24_usdt: tick.usdtVol, change24h: tick.change24h == null ? null : tick.change24h, breakout
  });
  return out;
}

// ============================================================ market data (Bitget PUBLIC endpoints, no keys)
const BASE = 'https://api.bitget.com';
const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then((v) => { cache.set(key, { t: Date.now(), v }); if (cache.size > 200) cache.clear(); return v; });
}
let market = {
  async tickers() {
    const r = await axios.get(BASE + '/api/v2/spot/market/tickers', { timeout: 5000, validateStatus: () => true });
    if (r.status !== 200 || !r.data || String(r.data.code) !== '00000' || !Array.isArray(r.data.data)) throw new Error('tickers unavailable');
    const m = {};
    r.data.data.forEach((t) => {
      const price = Number(t.lastPr); if (!(price > 0)) return;
      m[t.symbol] = { price, bid: Number(t.bidPr) || 0, ask: Number(t.askPr) || 0, usdtVol: Number(t.usdtVolume || t.quoteVolume) || 0, change24h: t.change24h == null ? null : Number(t.change24h) * 100 };
    });
    return m;
  },
  async candles(symbol, gran, limit) {
    const r = await axios.get(BASE + '/api/v2/spot/market/candles', { params: { symbol, granularity: gran, limit }, timeout: 5000, validateStatus: () => true });
    if (r.status !== 200 || !r.data || String(r.data.code) !== '00000' || !Array.isArray(r.data.data)) throw new Error('candles unavailable');
    const seen = new Set();
    return r.data.data.map(x => ({ t: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) }))
      .filter(x => Number.isFinite(x.t) && Number.isFinite(x.c) && Number.isFinite(x.h) && Number.isFinite(x.l) && !seen.has(x.t) && seen.add(x.t))
      .sort((a, b) => a.t - b.t);
  }
};
function _setMarket(m) { market = m; cache.clear(); }

async function scan(s, extraSymbols) {
  const tickers = await market.tickers();
  const pairs = [...new Set([...(s.allowed_pairs || []), ...(extraSymbols || []), 'BTCUSDT'])];
  const get = (sym) => Promise.all([
    cached('1h:' + sym, 5 * 60 * 1000, () => market.candles(sym, '1h', 200)).catch(() => null),
    cached('15m:' + sym, 45 * 1000, () => market.candles(sym, '15min', 100)).catch(() => null)
  ]);
  const data = await Promise.all(pairs.map(get));
  const byPair = {}; pairs.forEach((p, i) => { byPair[p] = data[i]; });
  const btc = btcContext(byPair.BTCUSDT && byPair.BTCUSDT[0]);
  const map = {};
  pairs.forEach((p) => {
    const [c1, c15] = byPair[p];
    if (!tickers[p]) return;
    map[p] = analyse(p, c1, c15, btc, tickers[p], s);
  });
  return { map, tickers, btc };
}

async function saveScan(map, s) {
  const rows = Object.keys(map).filter(k => (s.allowed_pairs || []).includes(k)).map((k) => {
    const a = map[k];
    return { symbol: k, price: a.price || null, score: a.score, decision: a.decision, analysis: a, computed_at: a.computed_at };
  });
  if (rows.length) await supabaseAdmin.from('crypto_scan').upsert(rows, { onConflict: 'symbol' });
}

// ============================================================ demo money
async function applyMoney(userId, delta, type, ref, meta) {
  const prior = await supabaseAdmin.from('crypto_demo_ledger').select('balance_after').eq('ref', ref).maybeSingle();
  if (prior.data) return { ok: true, already: true, balance: num(prior.data.balance_after) };
  for (let i = 0; i < 6; i++) {
    const a = await supabaseAdmin.from('crypto_accounts').select('demo_balance').eq('user_id', userId).maybeSingle();
    if (!a.data) return { ok: false, error: 'NO_ACCOUNT' };
    const nb = r8(num(a.data.demo_balance) + delta);
    if (nb < 0) return { ok: false, error: 'INSUFFICIENT' };
    const u = await supabaseAdmin.from('crypto_accounts').update({ demo_balance: nb, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('demo_balance', a.data.demo_balance).select('user_id').maybeSingle();
    if (u.data) {
      const l = await supabaseAdmin.from('crypto_demo_ledger').insert({ user_id: userId, type, amount_usdt: r8(delta), balance_after: nb, ref, meta: Object.assign({ virtual: true }, meta || {}) });
      if (l.error) console.error('[crypto-engine] ledger insert failed', ref);
      return { ok: true, balance: nb };
    }
  }
  return { ok: false, error: 'CONFLICT' };
}

// ============================================================ trade execution (virtual)
async function openPosition(userId, symbol, a, size, s) {
  const slip = num(s.demo_slippage_pct) / 100, feeRate = num(s.demo_fee_pct) / 100;
  const fill = Math.max(a.ask || 0, a.price) * (1 + slip);
  const fee = r8(size * feeRate), qty = size / fill;
  const stopPct = Math.max(num(s.stop_loss_pct), 1.2 * a.atr_pct);
  const tpPct = Math.max(num(s.take_profit_pct), 1.5 * stopPct);
  const id = crypto.randomUUID();
  const ins = await supabaseAdmin.from('crypto_positions').insert({
    id, user_id: userId, mode: 'demo', symbol, qty, entry_price: fill, cost_usdt: r8(size), orig_cost_usdt: r8(size), entry_fee_usdt: fee,
    stop_price: fill * (1 - stopPct / 100), take_profit: fill * (1 + tpPct / 100), peak_price: fill, stop_kind: 'stop_loss', partial_done: false,
    score: a.score, fees_usdt: fee, proceeds_usdt: 0, status: 'open',
    analysis: { stop_pct: +stopPct.toFixed(3), tp_pct: +tpPct.toFixed(3), signals: a.signals.map(x => x.k + ':' + x.pts), rsi: a.rsi, atr_pct: a.atr_pct }
  });
  if (ins.error) return null;
  const pay = await applyMoney(userId, -(size + fee), 'buy', 'ENG-BUY-' + id, { symbol, price: fill, qty, fee });
  if (!pay.ok) { await supabaseAdmin.from('crypto_positions').delete().eq('id', id); return null; }
  return id;
}

/** fraction 1 = close everything, 0.5 = partial. Returns true if this call did the sale. */
async function sell(pos, a, reason, s, fraction, patch) {
  const slip = num(s.demo_slippage_pct) / 100, feeRate = num(s.demo_fee_pct) / 100;
  const full = fraction >= 1;
  const sellQty = full ? num(pos.qty) : num(pos.qty) * fraction;
  const bid = (a.bid > 0 ? Math.min(a.bid, a.price) : a.price);
  const fill = bid * (1 - slip);
  const gross = sellQty * fill, fee = r8(gross * feeRate), net = r8(gross - fee);
  const costPart = full ? num(pos.cost_usdt) : num(pos.cost_usdt) * fraction;
  const now = new Date().toISOString();
  const proceeds = r8(num(pos.proceeds_usdt) + net), fees = r8(num(pos.fees_usdt) + fee);
  let q;
  if (full) {
    const realized = r8(proceeds - num(pos.orig_cost_usdt) - num(pos.entry_fee_usdt));
    q = supabaseAdmin.from('crypto_positions').update({ status: 'closed', closed_at: now, exit_price: fill, close_reason: reason, proceeds_usdt: proceeds, fees_usdt: fees, realized_pnl: realized, peak_price: patch && patch.peak_price != null ? patch.peak_price : pos.peak_price })
      .eq('id', pos.id).eq('status', 'open');
  } else {
    q = supabaseAdmin.from('crypto_positions').update(Object.assign({ qty: num(pos.qty) - sellQty, cost_usdt: r8(num(pos.cost_usdt) - costPart), partial_done: true, proceeds_usdt: proceeds, fees_usdt: fees }, patch || {}))
      .eq('id', pos.id).eq('status', 'open').eq('partial_done', false);
  }
  const claimed = await q.select('id').maybeSingle();
  if (!claimed.data) return false;            // someone else already changed this position
  const credit = await applyMoney(pos.user_id, net, 'sell', 'ENG-SELL-' + pos.id + (full ? '-F' : '-P'), { symbol: pos.symbol, price: fill, qty: sellQty, fee, reason });
  if (!credit.ok) console.error('[crypto-engine] credit failed after sell', pos.id, credit.error);
  return true;
}

// ============================================================ account lock
async function lockAccount(acc, now, ms) {
  if (acc.engine_lock_until && new Date(acc.engine_lock_until).getTime() > now) return false;
  const until = new Date(now + (ms || 25000)).toISOString();
  let q = supabaseAdmin.from('crypto_accounts').update({ engine_lock_until: until }).eq('user_id', acc.user_id);
  q = acc.engine_lock_until ? q.eq('engine_lock_until', acc.engine_lock_until) : q.is('engine_lock_until', null);
  const r = await q.select('user_id').maybeSingle();
  return !!r.data;
}
async function unlockAccount(userId) {
  await supabaseAdmin.from('crypto_accounts').update({ engine_lock_until: null }).eq('user_id', userId);
}

// ============================================================ managing open trades
async function manage(pos, a, s, now) {
  if (!a || !(a.price > 0)) return 'no_price';
  const entry = num(pos.entry_price), price = a.price;
  const an = pos.analysis || {};
  const stopPct = num(an.stop_pct) || num(s.stop_loss_pct), tpPct = num(an.tp_pct) || num(s.take_profit_pct);
  const peak = Math.max(num(pos.peak_price) || entry, price);
  const gainPct = (price / entry - 1) * 100;
  let stop = num(pos.stop_price), kind = pos.stop_kind || 'stop_loss';
  const be = entry * (1 + BE_MARGIN);
  if (gainPct >= stopPct && stop < be) { stop = be; kind = 'break_even'; }
  const peakGain = (peak / entry - 1) * 100;
  if (peakGain >= num(s.trailing_pct)) { const trail = peak * (1 - num(s.trailing_pct) / 100); if (trail > stop) { stop = trail; kind = 'trailing'; } }

  const patch = { stop_price: stop, stop_kind: kind, peak_price: peak };
  // 1. stop hit
  if (price <= stop) {
    const reason = kind === 'trailing' ? 'trailing_stop' : kind === 'break_even' ? 'break_even' : 'stop_loss';
    return (await sell(pos, a, reason, s, 1, patch)) ? 'closed:' + reason : 'skip';
  }
  // 2. final take-profit
  if (price >= num(pos.take_profit)) return (await sell(pos, a, 'take_profit', s, 1, patch)) ? 'closed:take_profit' : 'skip';
  // 3. reversal (not in the first minutes)
  const ageMin = (now - new Date(pos.opened_at).getTime()) / 60000;
  if (a.reversal && ageMin >= REVERSAL_MIN_AGE_MIN) return (await sell(pos, a, 'reversal', s, 1, patch)) ? 'closed:reversal' : 'skip';
  // 4. partial profit at half way to take-profit: sell half, protect the rest at break-even
  if (!pos.partial_done && gainPct >= tpPct / 2) {
    if (be > stop) { patch.stop_price = be; patch.stop_kind = 'break_even'; }
    const ok = await sell(pos, a, 'partial_profit', s, 0.5, patch);
    return ok ? 'partial' : 'skip';
  }
  // nothing to do: persist moved stop / new peak
  if (stop !== num(pos.stop_price) || peak !== num(pos.peak_price)) {
    await supabaseAdmin.from('crypto_positions').update(patch).eq('id', pos.id).eq('status', 'open');
  }
  return 'held';
}

// ============================================================ new trades
function utcDayStart(now) { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }

async function considerEntries(acc, open, s, scanMap, now) {
  const cfg = acc.bot_config || {}; const budget = num(cfg.amount_usd);
  if (!(budget >= MIN_TRADE_USD)) return 0;
  if (open.length >= s.max_trades) return 0;
  const since = new Date(now - 24 * 3600 * 1000).toISOString();
  const cl = await supabaseAdmin.from('crypto_positions').select('symbol,realized_pnl,closed_at').eq('user_id', acc.user_id).eq('mode', 'demo').eq('status', 'closed').gte('closed_at', since);
  const closed = cl.data || [];
  const dayStart = utcDayStart(now);
  const todayPnl = closed.filter(p => new Date(p.closed_at).getTime() >= dayStart).reduce((x, p) => x + num(p.realized_pnl), 0);
  if (todayPnl <= -(budget * num(s.daily_max_loss_pct) / 100)) return 0;     // daily loss limit reached
  // loss-streak breaker: 3 losing trades in a row -> no new entries for 2 hours
  const recent = closed.slice().sort((x, y) => new Date(y.closed_at) - new Date(x.closed_at)).slice(0, 3);
  if (recent.length === 3 && recent.every(p => num(p.realized_pnl) < 0) && now - new Date(recent[0].closed_at).getTime() < 2 * 3600 * 1000) return 0;
  const cooling = new Set(closed.filter(p => now - new Date(p.closed_at).getTime() < COOLDOWN_MIN * 60000).map(p => p.symbol));
  const held = new Set(open.map(p => p.symbol));
  const cands = Object.values(scanMap)
    .filter(a => (s.allowed_pairs || []).includes(a.symbol) && a.decision === 'buy' && !held.has(a.symbol) && !cooling.has(a.symbol))
    .sort((x, y) => y.score - x.score);
  let bal = num(acc.demo_balance), used = open.reduce((x, p) => x + num(p.cost_usdt), 0), slots = s.max_trades - open.length, opened = 0;
  for (const a of cands) {
    if (slots <= 0) break;
    const stopPct = Math.max(num(s.stop_loss_pct), 1.2 * a.atr_pct);
    let size = (budget * num(s.risk_per_trade_pct) / 100) / (stopPct / 100);       // risk-based size
    size = Math.min(size, budget / s.max_trades, budget - used);
    const feeRate = num(s.demo_fee_pct) / 100;
    size = Math.min(size, bal / (1 + feeRate));
    if (size < MIN_TRADE_USD) continue;
    const id = await openPosition(acc.user_id, a.symbol, a, size, s);
    if (id) { bal -= size * (1 + feeRate); used += size; slots--; opened++; }
  }
  return opened;
}

// ============================================================ closing everything (user Stop / admin)
async function closeAllForUser(userId, reason, tickersIn) {
  const now = Date.now();
  const accR = await supabaseAdmin.from('crypto_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (!accR.data) return { closed: 0, pending: 0 };
  const pos = await supabaseAdmin.from('crypto_positions').select('*').eq('user_id', userId).eq('mode', 'demo').eq('status', 'open');
  const open = pos.data || []; if (!open.length) return { closed: 0, pending: 0 };
  if (!(await lockAccount(accR.data, now, 20000))) return { closed: 0, pending: open.length, note: 'busy' };
  let closed = 0, pending = 0;
  try {
    let tk = tickersIn; if (!tk) { try { tk = await market.tickers(); } catch (e) { tk = null; } }
    const s = await svc().getSettings();
    // re-read after lock: a cycle may have changed positions
    const fresh = (await supabaseAdmin.from('crypto_positions').select('*').eq('user_id', userId).eq('mode', 'demo').eq('status', 'open')).data || [];
    for (const p of fresh) {
      const a = tk && tk[p.symbol]; if (!a) { pending++; continue; }
      if (await sell(p, a, reason, s, 1, {})) closed++; else pending++;
    }
  } finally { await unlockAccount(userId); }
  return { closed, pending };
}

async function closeAllUsers(reason) {
  const pos = await supabaseAdmin.from('crypto_positions').select('user_id').eq('mode', 'demo').eq('status', 'open');
  const ids = [...new Set((pos.data || []).map(p => p.user_id))];
  let tk = null; try { tk = await market.tickers(); } catch (e) { /* positions stay open and are retried by the engine */ }
  let closed = 0, pending = 0;
  for (const id of ids) { const r = await closeAllForUser(id, reason, tk); closed += r.closed; pending += r.pending; }
  return { closed, pending };
}

// ============================================================ the cycle
async function runCycle(opts) {
  const t0 = Date.now(); const budgetMs = (opts && opts.budgetMs) || 8000;
  const stats = { ok: true, scanned: 0, accounts: 0, opened: 0, closed: 0, partial: 0, skipped_locked: 0, errors: 0, note: '' };
  const s = await svc().getSettings();
  const g = svc().gate(s);
  const posQ = await supabaseAdmin.from('crypto_positions').select('*').eq('mode', 'demo').eq('status', 'open');
  const allOpen = posQ.data || [];
  const runQ = await supabaseAdmin.from('crypto_accounts').select('user_id').eq('mode', 'demo').eq('bot_status', 'running');
  const ids = [...new Set([...(runQ.data || []).map(r => r.user_id), ...allOpen.map(p => p.user_id)])];

  // maintenance with "hold": leave open trades untouched, do nothing at all
  if (s.maintenance.on && s.open_positions_on_maintenance === 'hold') { stats.note = 'maintenance-hold'; await saveStatus(stats); return stats; }
  if (!s.enabled && !allOpen.length) { stats.note = 'disabled'; await saveStatus(stats); return stats; }
  if (!ids.length && !g.open) { stats.note = 'idle'; await saveStatus(stats); return stats; }

  let sc;
  try { sc = await scan(s, allOpen.map(p => p.symbol)); stats.scanned = Object.keys(sc.map).length; }
  catch (e) { stats.ok = false; stats.note = 'market data unavailable'; await saveStatus(stats); return stats; }
  try { await saveScan(sc.map, s); } catch (e) { console.error('[crypto-engine] saveScan', e.message); }
  if (!ids.length) { await saveStatus(stats); return stats; }

  const accs = (await supabaseAdmin.from('crypto_accounts').select('*').in('user_id', ids)).data || [];
  for (const acc of accs) {
    if (Date.now() - t0 > budgetMs) { stats.note = 'time budget reached; rest next minute'; break; }
    if (acc.mode !== 'demo') continue;                       // live is not supported by this engine
    const now = Date.now();
    if (!(await lockAccount(acc, now))) { stats.skipped_locked++; continue; }
    try {
      stats.accounts++;
      const fresh = (await supabaseAdmin.from('crypto_accounts').select('*').eq('user_id', acc.user_id).maybeSingle()).data || acc;
      const open = (await supabaseAdmin.from('crypto_positions').select('*').eq('user_id', acc.user_id).eq('mode', 'demo').eq('status', 'open')).data || [];
      if (fresh.bot_status === 'stopped' && open.length) {
        for (const p of open) { const a = sc.map[p.symbol] || (sc.tickers[p.symbol] && sc.tickers[p.symbol]); if (a && await sell(p, a, 'user_stop', s, 1, {})) stats.closed++; }
        continue;
      }
      let still = [];
      for (const p of open) {
        const r = await manage(p, sc.map[p.symbol], s, now);
        if (String(r).startsWith('closed')) stats.closed++; else if (r === 'partial') { stats.partial++; still.push(p); } else still.push(p);
      }
      if (fresh.bot_status === 'running' && svc().canStartNew(s)) {
        const cur = (await supabaseAdmin.from('crypto_positions').select('*').eq('user_id', acc.user_id).eq('mode', 'demo').eq('status', 'open')).data || [];
        const accNow = (await supabaseAdmin.from('crypto_accounts').select('*').eq('user_id', acc.user_id).maybeSingle()).data || fresh;
        stats.opened += await considerEntries(accNow, cur, s, sc.map, now);
      }
    } catch (e) {
      stats.errors++; console.error('[crypto-engine] account error', acc.user_id, e && e.message);
    } finally { await unlockAccount(acc.user_id); }
  }
  await saveStatus(stats);
  return stats;
}

async function saveStatus(stats) {
  try {
    const value = Object.assign({}, stats, { last_run: new Date().toISOString() });
    const ex = await supabaseAdmin.from('crypto_settings').select('key').eq('key', 'engine_status').maybeSingle();
    if (ex.data) await supabaseAdmin.from('crypto_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', 'engine_status');
    else await supabaseAdmin.from('crypto_settings').insert({ key: 'engine_status', value, updated_at: new Date().toISOString() });
  } catch (e) { /* monitoring only */ }
}

module.exports = {
  runCycle, closeAllForUser, closeAllUsers, scan, analyse, manage, _setMarket,
  _ind: { ema, rsi, macd, atr, btcContext }, MIN_TRADE_USD
};
