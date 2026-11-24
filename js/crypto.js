// js/crypto.js — Crypto Trading dashboard. All numbers come from our server; the browser never sees API secrets.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err) { const w = $('#toast-wrap'); const t = document.createElement('div'); t.className = 'toast ' + (err ? 'err' : 'ok'); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 4500); }
let OV = null, busy = false;

async function api(action, payload) {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { location.href = 'index.html'; throw new Error('Please log in'); }
  const r = await fetch('/api/place-order?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify(payload || {}) });
  let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok || !j || j.success === false) throw new Error((j && j.error && j.error.message) || 'Something went wrong. Please try again.');
  return j.data;
}
const ref = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'r' + Date.now() + Math.random().toString(36).slice(2, 10);

function money(usd) {
  const c = OV.account.display_currency, rate = OV.settings.usd_ngn_rate, n = Number(usd || 0);
  if (c === 'NGN') return '₦' + (n * rate).toLocaleString('en-NG', { maximumFractionDigits: 0 });
  if (c === 'USD') return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDT';
}
const cls = (n) => n > 0 ? 'pos' : n < 0 ? 'neg' : '';

async function load() {
  try { OV = await api('crypto-overview'); render(); }
  catch (e) { $('#box').innerHTML = '<div class="card">' + esc(e.message) + '</div>'; }
}

function render() {
  const s = OV.settings, a = OV.account, n = OV.numbers, g = OV.gate;
  $('#banner').innerHTML = !g.open ? `<div class="banner off">${esc(g.message)}${g.eta ? '<br><small>Expected back: ' + esc(g.eta) + '</small>' : ''}</div>`
    : (s.stop_new_trades || s.pause_all_bots) ? '<div class="banner warn">New trades are temporarily paused by the administrator. Your account and history stay available.</div>' : '';
  const demo = a.mode === 'demo';
  const modeBanner = demo ? '<div class="banner warn">🧪 DEMO MODE — virtual money only. Demo profit is not real money and cannot be withdrawn.</div>' : '<div class="banner warn">🔴 LIVE MODE — real money on your own Bitget account.</div>';
  const botOn = g.open && !s.stop_new_trades && !s.pause_all_bots;
  const pnl = n.realized_pnl_usd;
  $('#box').innerHTML = `
    <div class="seg" style="margin-bottom:8px;" id="seg-cur">${['NGN', 'USD', 'USDT'].map(c => `<button data-c="${c}" class="${a.display_currency === c ? 'on' : ''}">${c === 'NGN' ? '₦ Naira' : c === 'USD' ? '$ Dollar' : 'USDT'}</button>`).join('')}</div>
    <div class="seg" style="margin-bottom:12px;" id="seg-mode"><button data-m="demo" class="${demo ? 'on' : ''}">🧪 Demo</button><button data-m="live" class="${!demo ? 'on' : ''}" ${s.live_enabled ? '' : 'disabled'}>🔴 Live${s.live_enabled ? '' : ' (locked)'}</button></div>
    ${modeBanner}
    <div class="tiles">
      <div class="tile"><div class="k">Available Trading Balance</div><div class="v">${money(n.available_usd)}</div></div>
      <div class="tile"><div class="k">Total Investment</div><div class="v">${money(n.total_investment_usd)}</div></div>
      <div class="tile"><div class="k">Current Portfolio Value</div><div class="v">${money(n.portfolio_value_usd)}</div></div>
      <div class="tile"><div class="k">Realized Profit / Loss</div><div class="v ${cls(pnl)}">${money(pnl)}</div></div>
      <div class="tile"><div class="k">Active Trades</div><div class="v">${n.active_trades}</div></div>
      <div class="tile"><div class="k">Completed Trades</div><div class="v">${n.completed_trades}</div></div>
      <div class="tile"><div class="k">Trading Fees</div><div class="v">${money(n.fees_usd)}</div></div>
      <div class="tile"><div class="k">Hadejia Commission (${s.platform_share_pct}% of net profit)</div><div class="v">${money(n.commission_usd)}</div></div>
    </div>
    <div class="card pad"><h3>🤖 Trading Bot <span class="pillst ${esc(a.bot_status)}">${esc(a.bot_status.replace('_', ' '))}</span></h3>
      ${OV.engine_ready ? '<div class="banner ok" style="margin:0 0 8px;">✅ Engine is running. The bot waits patiently and only trades when the setup is strong.</div>' : '<div class="banner warn" style="margin:0 0 8px;">The trading engine is not running right now, so no new trades will be made until it is back.</div>'}
      <label>Market type</label>
      <select id="in-mt">${[['spot', 'Spot (your own money, no leverage)'], ['futures', 'Futures — coming later'], ['margin', 'Margin — coming later'], ['auto', 'Auto (bot picks the safest available — Spot today)']].map(([v, l]) => { const en = v === 'auto' ? (s.market_types_enabled || []).includes('spot') : (s.market_types_enabled || []).includes(v); return `<option value="${v}" ${en ? '' : 'disabled'} ${((a.bot_config.market_type || 'spot') === v) ? 'selected' : ''}>${l}</option>`; }).join('')}</select>
      <label>Amount the bot may use (USD, $${s.min_investment_usd} – $${s.max_investment_usd})</label>
      <input type="number" id="in-amt" min="${s.min_investment_usd}" step="1" value="${esc(a.bot_config.amount_usd || s.min_investment_usd)}">
      <div class="btn-row"><button class="btn btn-primary" data-b="start" ${botOn && demo ? '' : 'disabled'}>▶ Start</button><button class="btn btn-ghost" data-b="pause">⏸ Pause</button><button class="btn btn-danger" data-b="stop">⏹ Stop</button></div>
      <p class="hint">Rules: the bot waits when there is no good opportunity, uses stop-loss and take-profit, and only uses the amount you set. The company share is taken only from your net realized profit after exchange fees, and never when you are at a loss.</p>
    </div>
    ${demo ? `<div class="card pad"><h3>🧪 Demo money (virtual)</h3>
      <label>Add virtual USD (min $${s.min_investment_usd}, max $${s.max_demo_fund_usd})</label><input type="number" id="in-fund" min="${s.min_investment_usd}" value="1000">
      <div class="btn-row"><button class="btn btn-primary" data-f="fund">Add demo money</button><button class="btn btn-ghost" data-f="reset">Reset demo balance</button></div></div>` : ''}
    <div class="card pad"><h3>📈 Open Trades</h3>${openTrades()}</div>
    ${s.keys_enabled ? keyCard() : ''}
    <div class="card pad"><h3>📡 Coin Scanner &amp; AI Market Analysis</h3><div id="scan">Loading…</div></div>
    <div class="card pad"><h3>📜 Trading History</h3><div id="hist">Loading…</div></div>`;
  bind(); loadHist(); loadScan();
}

function px(n) { n = Number(n); return n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toPrecision(5); }
function openTrades() {
  const list = OV.open_positions || [];
  if (!list.length) return '<p class="hint">No open trades. The bot only buys when the analysis is strong, so waiting is normal.</p>';
  return list.map(p => `<div class="trow"><div><b>${esc(p.symbol)}</b><small>Entry ${px(p.entry_price)} · now ${p.price ? px(p.price) : '—'}<br>Stop ${px(p.stop_price)}${p.stop_kind && p.stop_kind !== 'stop_loss' ? ' (' + esc(p.stop_kind.replace('_', ' ')) + ')' : ''} · Target ${px(p.take_profit)}${p.partial_done ? ' · partial profit taken' : ''}</small></div><div class="${cls(p.pnl_usd)}">${p.pnl_usd == null ? '—' : money(p.pnl_usd)}</div></div>`).join('');
}

async function loadScan() {
  const box = $('#scan'); if (!box) return;
  try {
    const d = await api('crypto-scan');
    if (!d.rows.length) { box.innerHTML = '<p class="hint">No scan yet. It appears once the engine has run.</p>'; return; }
    const lab = { buy: '✅ Good setup', wait: '⏳ Waiting', avoid: '⛔ Avoid' };
    box.innerHTML = (d.stale ? '<div class="banner warn">Scan is old — the engine may be paused.</div>' : '') +
      `<p class="hint">Updated ${d.updated_at ? new Date(d.updated_at).toLocaleTimeString('en-NG') : '—'}. The bot needs a score of ${d.min_confidence}+ AND trend, momentum and the 15-minute chart to agree. A score is a filter, not a promise of profit.</p>` +
      d.rows.map(r => `<details class="trow" style="display:block;"><summary style="display:flex;justify-content:space-between;cursor:pointer;"><span><b>${esc(r.symbol)}</b> <small>${px(r.price)}</small></span><span>${esc(lab[r.decision] || r.decision)} · ${Math.round(r.score)}/100</span></summary>
        <small>${r.signals.map(x => esc(x.label) + ': ' + x.pts + '/' + x.max + ' (' + esc(x.note) + ')').join('<br>')}${r.vetoes.length ? '<br><b>Blocked:</b> ' + r.vetoes.map(esc).join(', ') : ''}${r.patience ? '<br>' + esc(r.patience) : ''}${r.support ? '<br>Support ' + px(r.support) + ' · Resistance ' + px(r.resistance) : ''}</small></details>`).join('');
  } catch (e) { box.textContent = e.message; }
}

function keyCard() {
  const k = OV.key, a = OV.account;
  return `<div class="card pad"><h3>🔑 Connect your Bitget account (for Live)</h3>
    ${k ? `<p>✅ Key connected: <b>…${esc(k.key_hint)}</b>${k.has_ip_whitelist ? ' · IP restricted' : ' · <span style="color:#8a5f14;">no IP restriction (recommended to add one)</span>'}</p>
      ${a.live_consent ? '<p class="hint">Live risk agreement accepted ✔</p>' : '<button class="btn btn-ghost" id="b-consent">I accept the live trading risk agreement</button>'}
      <button class="btn btn-ghost" id="b-keydel" style="margin-top:8px;">Remove key</button>` :
    `<p class="hint">Create a Bitget API key with <b>Trade (spot) permission only</b>. <b>Never</b> enable withdrawal or transfer. Your money stays in your own Bitget account; we cannot withdraw it. Keys are encrypted and never shown again.</p>
      <label>API key</label><input type="text" id="k-key" autocomplete="off"><label>Secret key</label><input type="password" id="k-sec" autocomplete="off"><label>Passphrase</label><input type="password" id="k-pass" autocomplete="off">
      <button class="btn btn-primary" id="b-keysave" style="margin-top:10px;">Verify &amp; save key</button>`}
  </div>`;
}

function bind() {
  document.querySelectorAll('#seg-cur button').forEach(b => b.onclick = () => run(async () => { await api('crypto-currency', { currency: b.dataset.c }); await load(); }));
  document.querySelectorAll('#seg-mode button').forEach(b => b.onclick = () => run(async () => { await api('crypto-mode', { mode: b.dataset.m }); await load(); }));
  document.querySelectorAll('[data-b]').forEach(b => b.onclick = () => run(async () => { await api('crypto-bot', { action: b.dataset.b, amount_usd: Number($('#in-amt').value), market_type: ($('#in-mt') || {}).value || 'spot' }); toast(b.dataset.b === 'stop' ? 'Stopped. Open trades are being closed.' : 'Saved'); await load(); }));
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => run(async () => {
    if (b.dataset.f === 'reset' && !confirm('Reset your demo balance to this amount?')) return;
    await api('crypto-demo-fund', { kind: b.dataset.f, amount_usd: Number($('#in-fund').value), request_ref: ref() }); toast('Done'); await load();
  }));
  const on = (id, fn) => { const e = $(id); if (e) e.onclick = () => run(fn); };
  on('#b-keysave', async () => { await api('crypto-keys-save', { api_key: $('#k-key').value, api_secret: $('#k-sec').value, passphrase: $('#k-pass').value }); toast('Key verified and saved'); await load(); });
  on('#b-keydel', async () => { if (!confirm('Remove your Bitget key?')) return; await api('crypto-keys-delete'); await load(); });
  on('#b-consent', async () => { if (!confirm('Trading with real money can lose money. Do you accept the risk?')) return; await api('crypto-consent'); await load(); });
}
async function run(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { toast(e.message, true); } busy = false; }

async function loadHist() {
  const box = $('#hist'); if (!box) return;
  try {
    const h = await api('crypto-history');
    if (!h.trades.length && !h.demo_ledger.length) { box.innerHTML = '<p class="hint">No trades yet.</p>'; return; }
    box.innerHTML = h.trades.map(t => `<div class="trow"><div><b>${esc(t.symbol)}</b><small>${new Date(t.opened_at).toLocaleString('en-NG')} · ${esc(t.status)}${t.close_reason ? ' · ' + esc(t.close_reason) : ''}</small></div><div class="${cls(Number(t.realized_pnl))}">${t.realized_pnl == null ? '—' : money(t.realized_pnl)}</div></div>`).join('') +
      (h.demo_ledger.length ? '<h4 style="margin:12px 0 4px;font-size:13px;">Demo money log</h4>' + h.demo_ledger.map(l => `<div class="trow"><div>${esc(l.type)}<small>${new Date(l.created_at).toLocaleString('en-NG')}</small></div><div>${money(l.amount_usdt)}</div></div>`).join('') : '');
  } catch (e) { box.textContent = e.message; }
}
load();
