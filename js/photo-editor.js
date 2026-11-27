// js/photo-editor.js — runs 100% in the browser (Canvas). Photos are never uploaded.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err) { const w = $('#toast-wrap'); const t = document.createElement('div'); t.className = 'toast ' + (err ? 'err' : 'ok'); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 4500); }

const MAX_SRC = 2048;            // photos are scaled down to this on load (saves RAM on small phones)
const MAX_EXPORT_PX = 16e6;      // refuse exports larger than 16 megapixels
const FILTERS = { none: '', Mono: 'grayscale(1)', Sepia: 'sepia(.85)', Warm: 'sepia(.35) saturate(1.3) hue-rotate(-10deg)', Cool: 'saturate(1.1) hue-rotate(15deg) brightness(1.03)', Vivid: 'saturate(1.7) contrast(1.1)', Fade: 'contrast(.85) brightness(1.1) saturate(.8)', Invert: 'invert(1)' };
const FONTS = { Sans: 'Arial, Helvetica, sans-serif', Serif: 'Georgia, serif', Mono: '"Courier New", monospace', Bold: '"Arial Black", Impact, sans-serif' };
const STICKERS = ['😀', '😍', '🔥', '⭐', '❤️', '🎉', '🎂', '🎈', '🎁', '👍', '💯', '✅', '📱', '📶', '💡', '🛒', '💰', '🚀', '📞', '⚡', '🌟', '🏆', '🕌', '🇳🇬'];

let S, imgs = {}, selected = null, tab = 'photo', hist = [], hi = -1, limits = { max_mb: 10 }, ctxFilterOK = true, view = { scale: 1 };
const cv = $('#cv'), ctx = cv.getContext('2d');
let projectId = null, projectName = 'Untitled';

const blank = (w, h, bg) => ({ w: w || 1080, h: h || 1080, bg: bg || '#ffffff', fit: 'cover', imgId: null, rot: 0, fh: false, fv: false, zoom: 1, px: 0, py: 0, br: 100, co: 100, sa: 100, filter: 'none', layers: [] });
const L = (o) => Object.assign({ id: 'l' + Math.random().toString(36).slice(2, 8), type: 'text', x: .5, y: .5, size: .08, text: 'Text', color: '#ffffff', font: 'Sans', bold: true, op: 1, rot: 0 }, o);

// ---------- templates ----------
const TPL = {
  business: () => { const s = blank(1080, 1080, '#0f3d2e'); s.layers = [L({ text: 'YOUR BUSINESS NAME', y: .3, size: .09, color: '#C6F135', font: 'Bold' }), L({ text: 'Quality products. Fast service.', y: .45, size: .045 }), L({ text: '📞 0800 000 0000', y: .85, size: .06, color: '#C6F135' })]; return s; },
  vtu: () => { const s = blank(1080, 1350, '#0b2f24'); s.layers = [L({ text: 'DATA • AIRTIME • BILLS', y: .16, size: .07, color: '#C6F135', font: 'Bold' }), L({ type: 'emoji', text: '📱', y: .4, size: .3 }), L({ text: 'Cheap & Instant', y: .62, size: .1, font: 'Bold' }), L({ text: 'MTN • Airtel • Glo • 9mobile', y: .72, size: .045 }), L({ text: 'Hadejia Data Hub', y: .9, size: .06, color: '#C6F135' })]; return s; },
  birthday: () => { const s = blank(1080, 1080, '#7c2d92'); s.layers = [L({ type: 'emoji', text: '🎂', y: .3, size: .3 }), L({ text: 'Happy Birthday!', y: .58, size: .11, font: 'Bold', color: '#ffe066' }), L({ text: 'Name goes here', y: .72, size: .07 }), L({ type: 'emoji', text: '🎈', x: .12, y: .15, size: .15 }), L({ type: 'emoji', text: '🎉', x: .88, y: .15, size: .15 })]; return s; },
  social: () => { const s = blank(1080, 1080, '#1B2540'); s.layers = [L({ text: 'Your headline here', y: .4, size: .09, font: 'Bold', color: '#C6F135' }), L({ text: 'Add a short message', y: .55, size: .05 })]; return s; },
  status: () => { const s = blank(1080, 1920, '#0f3d2e'); s.layers = [L({ text: 'Hadejia Data Hub', y: .12, size: .07, color: '#C6F135', font: 'Bold' }), L({ type: 'emoji', text: '📶', y: .4, size: .3 }), L({ text: 'Your message', y: .62, size: .08, font: 'Bold' })]; return s; },
  product: () => { const s = blank(1080, 1350, '#f4efe1'); s.fit = 'contain'; s.layers = [L({ text: 'PRODUCT NAME', y: .08, size: .08, color: '#0f3d2e', font: 'Bold' }), L({ text: '₦0,000', y: .92, size: .1, color: '#c0392b', font: 'Bold' })]; return s; },
  idphoto: () => { const s = blank(413, 531, '#ffffff'); return s; }
};

// ---------- state / history ----------
const snap = () => JSON.stringify(S);
function pushHist() { hist = hist.slice(0, hi + 1); hist.push(snap()); if (hist.length > 50) hist.shift(); hi = hist.length - 1; }
function undo() { if (hi > 0) { hi--; S = JSON.parse(hist[hi]); selected = null; renderAll(); } }
function redo() { if (hi < hist.length - 1) { hi++; S = JSON.parse(hist[hi]); selected = null; renderAll(); } }
function commit() { pushHist(); }

// ---------- drawing ----------
function layout(w, h) { return Math.min(1, 900 / Math.max(w, h)); }
function drawScene(g, W, H, forExport) {
  g.save(); g.fillStyle = S.bg; g.fillRect(0, 0, W, H);
  const img = S.imgId && imgs[S.imgId];
  if (img) {
    const odd = S.rot % 2 === 1; const iw = odd ? img.height : img.width, ih = odd ? img.width : img.height;
    const base = (S.fit === 'cover' ? Math.max : Math.min)(W / iw, H / ih) * S.zoom;
    g.save(); g.translate(W / 2 + S.px * W, H / 2 + S.py * H); g.rotate(S.rot * Math.PI / 2); g.scale(S.fh ? -1 : 1, S.fv ? -1 : 1);
    const f = `brightness(${S.br}%) contrast(${S.co}%) saturate(${S.sa}%) ${FILTERS[S.filter] || ''}`;
    if (ctxFilterOK) g.filter = f;
    g.scale(base, base); g.drawImage(img, -img.width / 2, -img.height / 2); g.restore();
  }
  g.filter = 'none';
  S.layers.forEach(l => drawLayer(g, l, W, H, forExport));
  g.restore();
}
function drawLayer(g, l, W, H, forExport) {
  g.save(); g.globalAlpha = l.op; g.translate(l.x * W, l.y * H); g.rotate(l.rot * Math.PI / 180);
  let bw = 0, bh = 0;
  if (l.type === 'text' || l.type === 'emoji') {
    const px = Math.max(4, l.size * W);
    g.font = `${l.bold ? 'bold ' : ''}${px}px ${l.type === 'emoji' ? 'sans-serif' : FONTS[l.font] || FONTS.Sans}`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = l.color;
    const lines = String(l.text).split('\n'); bh = px * 1.2 * lines.length; bw = 0;
    lines.forEach((t, i) => {
      const y = (i - (lines.length - 1) / 2) * px * 1.2;
      if (l.type === 'text' && l.shadow !== false) { g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = px * .08; }
      g.fillText(t, 0, y); g.shadowBlur = 0; bw = Math.max(bw, g.measureText(t).width);
    });
  } else if (l.type === 'image') {
    const im = imgs[l.imgId]; if (im) { bw = l.size * W; bh = bw * im.height / im.width; g.drawImage(im, -bw / 2, -bh / 2, bw, bh); }
  } else if (l.type === 'wm') {
    const px = Math.max(8, l.size * W); g.font = `bold ${px}px Arial, sans-serif`; g.fillStyle = l.color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = l.op; const step = px * 5;
    g.rotate(-Math.PI / 7);
    for (let yy = -H; yy < H * 2; yy += step) for (let xx = -W; xx < W * 2; xx += step * 1.6) g.fillText(l.text, xx, yy);
    g.restore(); l._box = null; return;
  }
  l._box = { cx: l.x * W, cy: l.y * H, w: bw, h: bh, rot: l.rot };
  if (!forExport && selected === l.id) { g.globalAlpha = 1; g.strokeStyle = '#C6F135'; g.lineWidth = Math.max(2, W / 300); g.setLineDash([8, 6]); g.strokeRect(-bw / 2 - 6, -bh / 2 - 6, bw + 12, bh + 12); }
  g.restore();
}
function renderCanvas() {
  const sc = layout(S.w, S.h); view.scale = sc;
  const W = Math.round(S.w * sc), H = Math.round(S.h * sc);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  drawScene(ctx, W, H, false);
}
function renderAll() { renderCanvas(); renderTabs(); renderPanel(); $('#b-undo').disabled = hi <= 0; $('#b-redo').disabled = hi >= hist.length - 1; }

// ---------- loading images ----------
function loadFile(file, keepAlpha) {
  return new Promise((ok, no) => {
    if (!file) return no(new Error('No file'));
    if (!/^image\//.test(file.type)) return no(new Error('Please choose an image file (JPG, PNG, WebP).'));
    if (file.size > limits.max_mb * 1024 * 1024) return no(new Error(`File is too large. Maximum is ${limits.max_mb} MB.`));
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, MAX_SRC / Math.max(im.width, im.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
      const g = c.getContext('2d'); if (!keepAlpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } g.drawImage(im, 0, 0, c.width, c.height); ok(c);
    };
    im.onerror = () => { URL.revokeObjectURL(url); no(new Error('This browser cannot open that image format. Try a JPG or PNG.')); };
    im.src = url;
  });
}
const newImg = (c) => { const id = 'i' + Math.random().toString(36).slice(2, 8); imgs[id] = c; return id; };

// ---------- panels ----------
const TABS = [['photo', '📷 Photo'], ['size', '✂️ Crop/Size'], ['adjust', '🎚 Adjust'], ['filters', '🎞 Filters'], ['text', '🔤 Text'], ['logo', '🏷 Logo'], ['wm', '💧 Watermark'], ['stk', '😀 Stickers'], ['layer', '🧩 Layer']];
function renderTabs() { $('#tabs').innerHTML = TABS.map(t => `<button data-t="${t[0]}" class="${tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join(''); $('#tabs').querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderTabs(); renderPanel(); }); }
const slider = (id, label, min, max, val, step) => `<label>${label}: <span id="${id}-v">${val}</span></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step || 1}" value="${val}">`;
function bindSlider(id, apply) { const e = $('#' + id); if (!e) return; e.oninput = () => { apply(+e.value); $('#' + id + '-v').textContent = e.value; renderCanvas(); }; e.onchange = commit; }
const selLayer = () => S.layers.find(l => l.id === selected);

function renderPanel() {
  const p = $('#panel'); let h = '';
  if (tab === 'photo') {
    h = `<button class="btn btn-primary" id="p-up">📷 Upload photo</button>
      <p class="hint">JPG / PNG / WebP, up to ${limits.max_mb} MB. Large photos are reduced to ${MAX_SRC}px so your phone doesn't run out of memory.</p>
      <label>Background color (shows when the photo doesn't fill the frame)</label><input type="color" id="p-bg" value="${S.bg}">
      <label>Photo fit</label><div class="chips"><button data-fit="cover" class="${S.fit === 'cover' ? 'on' : ''}">Fill frame</button><button data-fit="contain" class="${S.fit === 'contain' ? 'on' : ''}">Fit inside</button></div>
      <p class="hint">Tip: drag on the picture to move the photo; pinch with two fingers to zoom.</p>`;
  } else if (tab === 'size') {
    h = `<label>Frame shape (crop)</label><div class="chips" id="p-ar">${[['1:1', 1080, 1080], ['4:5', 1080, 1350], ['16:9', 1280, 720], ['9:16', 1080, 1920], ['3:4 (ID)', 413, 531]].map(a => `<button data-w="${a[1]}" data-h="${a[2]}" class="${S.w === a[1] && S.h === a[2] ? 'on' : ''}">${a[0]}</button>`).join('')}</div>
      <div class="row2"><div><label>Width (px)</label><input type="text" inputmode="numeric" id="p-w" value="${S.w}"></div><div><label>Height (px)</label><input type="text" inputmode="numeric" id="p-h" value="${S.h}"></div></div>
      <button class="btn btn-ghost" id="p-rs" style="margin-top:8px;">Resize</button>
      <label>Rotate / Flip</label><div class="chips"><button id="p-rl">⟲ 90°</button><button id="p-rr">⟳ 90°</button><button id="p-fh">⇋ Flip</button><button id="p-fv">⇅ Flip</button></div>
      ${slider('p-zoom', 'Zoom', 50, 400, Math.round(S.zoom * 100))}<p class="hint">Resize sets the output size (max 4096 px per side).</p>`;
  } else if (tab === 'adjust') {
    h = slider('p-br', 'Brightness', 40, 180, S.br) + slider('p-co', 'Contrast', 40, 180, S.co) + slider('p-sa', 'Saturation', 0, 220, S.sa) + `<button class="btn btn-ghost" id="p-reset" style="margin-top:10px;">Reset</button>`;
    if (!ctxFilterOK) h = '<p class="hint warn">This browser does not support photo filters/adjustments. Use Chrome on Android or desktop.</p>';
  } else if (tab === 'filters') {
    h = !ctxFilterOK ? '<p class="hint warn">This browser does not support filters. Use Chrome.</p>' : '<div class="chips" id="p-fl">' + Object.keys(FILTERS).map(k => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${k === 'none' ? 'Original' : k}</button>`).join('') + '</div>';
  } else if (tab === 'text') {
    h = `<button class="btn btn-primary" id="p-addt">＋ Add text</button>`;
    const l = selLayer(); if (l && l.type === 'text') h += `<label>Text (new line = Enter)</label><textarea id="p-tx" rows="2">${esc(l.text)}</textarea>
      <div class="row2"><div><label>Color</label><input type="color" id="p-tc" value="${l.color}"></div><div><label>Font</label><select id="p-tf">${Object.keys(FONTS).map(f => `<option ${l.font === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div></div>
      ${slider('p-ts', 'Size', 2, 30, Math.round(l.size * 100))}`; else h += '<p class="hint">Tap a text on the picture to edit it, or add a new one.</p>';
  } else if (tab === 'logo') {
    h = `<button class="btn btn-primary" id="p-up-logo">🏷 Upload your logo</button><button class="btn btn-ghost" id="p-hdh" style="margin-top:8px;">Use Hadejia Data Hub logo</button><p class="hint">Use a transparent PNG for best results. Then drag it where you want and change size in the Layer tab.</p>`;
  } else if (tab === 'wm') {
    h = `<label>Watermark text</label><input type="text" id="p-wmt" value="Hadejia Data Hub"><button class="btn btn-primary" id="p-addwm" style="margin-top:8px;">Add watermark</button><p class="hint">Repeats across the whole picture. Adjust opacity in the Layer tab. A logo can also be used as a watermark (Logo tab → lower its opacity).</p>`;
  } else if (tab === 'stk') {
    h = '<div class="chips">' + STICKERS.map(s => `<button class="stk" data-s="${s}">${s}</button>`).join('') + '</div>';
  } else if (tab === 'layer') {
    const l = selLayer();
    if (!l) h = '<p class="hint">Tap an item on the picture to select it.</p>';
    else h = slider('p-lo', 'Opacity %', 5, 100, Math.round(l.op * 100)) + slider('p-lr', 'Rotate °', -180, 180, l.rot) +
      (l.type !== 'wm' ? slider('p-lz', 'Size', 2, 100, Math.round(l.size * 100)) : slider('p-lz', 'Size', 2, 12, Math.round(l.size * 100))) +
      `<div class="chips" style="margin-top:10px;"><button id="p-front">Bring to front</button><button id="p-dup">Duplicate</button><button id="p-del" style="color:#c0392b;">Delete</button></div>`;
  }
  p.innerHTML = h; bindPanel();
}

function bindPanel() {
  const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
  on('p-up', () => $('#f-photo').click()); on('p-up-logo', () => $('#f-logo').click());
  const bg = $('#p-bg'); if (bg) { bg.oninput = () => { S.bg = bg.value; renderCanvas(); }; bg.onchange = commit; }
  document.querySelectorAll('[data-fit]').forEach(b => b.onclick = () => { S.fit = b.dataset.fit; commit(); renderAll(); });
  document.querySelectorAll('#p-ar button').forEach(b => b.onclick = () => { S.w = +b.dataset.w; S.h = +b.dataset.h; S.px = S.py = 0; commit(); renderAll(); });
  on('p-rs', () => { const w = Math.round(+$('#p-w').value), h = Math.round(+$('#p-h').value); if (!(w >= 50 && h >= 50 && w <= 4096 && h <= 4096)) return toast('Width and height must be between 50 and 4096.', true); S.w = w; S.h = h; commit(); renderAll(); });
  on('p-rl', () => { S.rot = (S.rot + 3) % 4; commit(); renderAll(); }); on('p-rr', () => { S.rot = (S.rot + 1) % 4; commit(); renderAll(); });
  on('p-fh', () => { S.fh = !S.fh; commit(); renderAll(); }); on('p-fv', () => { S.fv = !S.fv; commit(); renderAll(); });
  bindSlider('p-zoom', v => S.zoom = v / 100); bindSlider('p-br', v => S.br = v); bindSlider('p-co', v => S.co = v); bindSlider('p-sa', v => S.sa = v);
  on('p-reset', () => { S.br = S.co = S.sa = 100; S.filter = 'none'; commit(); renderAll(); });
  document.querySelectorAll('#p-fl button').forEach(b => b.onclick = () => { S.filter = b.dataset.f; commit(); renderAll(); });
  on('p-addt', () => { const l = L({ text: 'Your text', size: .08 }); S.layers.push(l); selected = l.id; commit(); renderAll(); });
  const tx = $('#p-tx'); if (tx) { tx.oninput = () => { selLayer().text = tx.value; renderCanvas(); }; tx.onchange = commit; }
  const tc = $('#p-tc'); if (tc) { tc.oninput = () => { selLayer().color = tc.value; renderCanvas(); }; tc.onchange = commit; }
  const tf = $('#p-tf'); if (tf) tf.onchange = () => { selLayer().font = tf.value; commit(); renderCanvas(); };
  bindSlider('p-ts', v => selLayer().size = v / 100);
  on('p-hdh', async () => { try { const r = await fetch('images/logo.png'); const b = await r.blob(); const c = await loadFile(new File([b], 'logo.png', { type: 'image/png' }), true); addLogo(c); } catch (e) { toast(e.message, true); } });
  on('p-addwm', () => { const t = ($('#p-wmt').value || '').trim(); if (!t) return toast('Type the watermark text.', true); const l = L({ type: 'wm', text: t, size: .04, op: .25, color: '#ffffff' }); S.layers.push(l); selected = l.id; commit(); tab = 'layer'; renderAll(); });
  document.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { const l = L({ type: 'emoji', text: b.dataset.s, size: .15 }); S.layers.push(l); selected = l.id; commit(); renderAll(); });
  bindSlider('p-lo', v => selLayer().op = v / 100); bindSlider('p-lr', v => selLayer().rot = v); bindSlider('p-lz', v => selLayer().size = v / 100);
  on('p-front', () => { const l = selLayer(); S.layers = S.layers.filter(x => x !== l).concat(l); commit(); renderAll(); });
  on('p-dup', () => { const l = selLayer(); const c = Object.assign({}, JSON.parse(JSON.stringify(l)), { id: 'l' + Math.random().toString(36).slice(2, 8), x: Math.min(.95, l.x + .05), y: Math.min(.95, l.y + .05) }); S.layers.push(c); selected = c.id; commit(); renderAll(); });
  on('p-del', () => { S.layers = S.layers.filter(x => x.id !== selected); selected = null; commit(); renderAll(); });
}
function addLogo(c) { const l = L({ type: 'image', imgId: newImg(c), size: .25, op: 1, x: .8, y: .12 }); S.layers.push(l); selected = l.id; commit(); tab = 'layer'; renderAll(); }

// ---------- pointer interaction (move layers / pan photo / pinch) ----------
const pts = new Map(); let drag = null, pinch0 = null;
function pos(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
function hit(p) {
  for (let i = S.layers.length - 1; i >= 0; i--) {
    const l = S.layers[i]; if (l.type === 'wm' || !l._box) continue; const W = cv.width, H = cv.height;
    const a = -l.rot * Math.PI / 180, dx = p.x * W - l._box.cx, dy = p.y * H - l._box.cy; const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(rx) <= l._box.w / 2 + 12 && Math.abs(ry) <= l._box.h / 2 + 12) return l;
  } return null;
}
cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, pos(e));
  if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: S.zoom, size: selLayer() ? selLayer().size : 0 }; drag = null; return; }
  const p = pos(e), l = hit(p);
  if (l) { selected = l.id; drag = { kind: 'layer', l, dx: l.x - p.x, dy: l.y - p.y }; if (tab !== 'layer' && tab !== 'text') { /* keep tab */ } renderCanvas(); renderPanel(); }
  else { selected = null; drag = { kind: 'photo', sx: p.x, sy: p.y, px: S.px, py: S.py }; renderCanvas(); }
});
cv.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, pos(e));
  if (pts.size === 2 && pinch0) { const [a, b] = [...pts.values()]; const k = Math.hypot(a.x - b.x, a.y - b.y) / (pinch0.d || 1); if (selLayer() && selLayer().type !== 'wm') selLayer().size = Math.max(.02, Math.min(1, pinch0.size * k)); else S.zoom = Math.max(.5, Math.min(4, pinch0.zoom * k)); renderCanvas(); return; }
  if (!drag) return; const p = pos(e);
  if (drag.kind === 'layer') { drag.l.x = Math.max(0, Math.min(1, p.x + drag.dx)); drag.l.y = Math.max(0, Math.min(1, p.y + drag.dy)); }
  else { S.px = drag.px + (p.x - drag.sx); S.py = drag.py + (p.y - drag.sy); }
  renderCanvas();
});
const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null; if (pts.size === 0 && (drag || true)) { if (drag) { commit(); } drag = null; renderPanel(); } };
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);

// ---------- upload handlers ----------
$('#f-photo').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const c = await loadFile(f, false); S.imgId = newImg(c); S.rot = 0; S.fh = S.fv = false; S.zoom = 1; S.px = S.py = 0; if (!S.layers.length && !projectId && !S.tplApplied) { const k = Math.min(1, MAX_SRC / Math.max(c.width, c.height)); S.w = c.width; S.h = c.height; } commit(); renderAll(); toast('Photo loaded'); } catch (err) { toast(err.message, true); } };
$('#f-logo').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { addLogo(await loadFile(f, true)); } catch (err) { toast(err.message, true); } };

// ---------- export / save ----------
function exportCanvas() {
  if (S.w * S.h > MAX_EXPORT_PX) throw new Error('This size is too large for your device. Reduce the width/height and try again.');
  const c = document.createElement('canvas'); c.width = S.w; c.height = S.h; drawScene(c.getContext('2d'), S.w, S.h, true); return c;
}
const blobOf = (c, type, q) => new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('Could not create the image (not enough memory). Try a smaller size.')), type, q));
function thumbOf(c) { const t = document.createElement('canvas'); const k = 120 / Math.max(c.width, c.height); t.width = Math.max(1, Math.round(c.width * k)); t.height = Math.max(1, Math.round(c.height * k)); t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); return t.toDataURL('image/jpeg', .7); }

async function download(kind) {
  const btn = $('#b-dl'); btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const c = exportCanvas(); const png = kind === 'png';
    const blob = await blobOf(c, png ? 'image/png' : 'image/jpeg', .92);
    const name = `hadejia-studio-${Date.now()}.${png ? 'png' : 'jpg'}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    try { await Studio.put('downloads', { id: Studio.uid(), name, updated: Date.now(), size: blob.size, thumb: thumbOf(c) }); } catch (e) { /* history is optional */ }
    toast('Downloaded ' + name);
  } catch (e) { toast(e.message, true); }
  btn.disabled = false; btn.textContent = '⬇ Download';
}
function chooseDownload() {
  const old = $('#dl-sheet'); if (old) old.remove();
  const d = document.createElement('div'); d.id = 'dl-sheet'; d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;z-index:70;';
  d.innerHTML = '<div style="background:var(--paper);width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:18px;"><h3 style="margin-bottom:10px;">Download as</h3><button class="btn btn-primary" data-k="jpg" style="margin-bottom:8px;">JPG (smaller file)</button><button class="btn btn-primary" data-k="png" style="margin-bottom:8px;">PNG (best quality)</button><button class="btn btn-ghost" data-k="x">Cancel</button></div>';
  d.onclick = (e) => { const k = e.target.dataset && e.target.dataset.k; if (e.target === d || k === 'x') d.remove(); else if (k) { d.remove(); download(k); } };
  document.body.appendChild(d);
}
async function save() {
  try {
    const name = prompt('Project name:', projectName); if (!name) return; projectName = name.slice(0, 60);
    projectId = projectId || Studio.uid();
    const images = {}; for (const id of Object.keys(imgs)) { if (JSON.stringify(S).includes(id)) images[id] = await blobOf(imgs[id], 'image/png'); }
    const c = document.createElement('canvas'); c.width = S.w; c.height = S.h; drawScene(c.getContext('2d'), S.w, S.h, true);
    const st = JSON.parse(snap()); st.layers.forEach(l => delete l._box);
    await Studio.put('projects', { id: projectId, name: projectName, updated: Date.now(), state: st, images, thumb: thumbOf(c) });
    toast('Saved on this device');
  } catch (e) { toast(e.message || 'Could not save', true); }
}
async function openProject(id) {
  const p = await Studio.get('projects', id); if (!p) throw new Error('Project not found on this device.');
  imgs = {}; for (const k of Object.keys(p.images || {})) { imgs[k] = await blobToCanvas(p.images[k]); }
  S = p.state; projectId = p.id; projectName = p.name;
}
function blobToCanvas(b) { return new Promise((ok, no) => { const u = URL.createObjectURL(b); const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0); URL.revokeObjectURL(u); ok(c); }; im.onerror = () => no(new Error('Could not open saved image')); im.src = u; }); }

$('#b-undo').onclick = undo; $('#b-redo').onclick = redo; $('#b-save').onclick = save; $('#b-dl').onclick = chooseDownload;

// ---------- boot ----------
(async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { location.href = 'index.html'; return; }
  const f = await Studio.flag('studio_photo_enabled', { enabled: true, max_mb: 10 });
  if (f.enabled === false) { const b = $('#blocked'); b.style.display = 'block'; b.textContent = 'The Photo Editor is currently unavailable. Please try again later.'; return; }
  limits.max_mb = Math.max(1, Number(f.max_mb) || 10);
  try { const t = document.createElement('canvas').getContext('2d'); t.filter = 'blur(1px)'; ctxFilterOK = t.filter === 'blur(1px)'; } catch (e) { ctxFilterOK = false; }
  const q = new URLSearchParams(location.search);
  try {
    if (q.get('project')) await openProject(q.get('project'));
    else { S = (TPL[q.get('tpl')] || (() => blank(1080, 1080, '#ffffff')))(); if (q.get('tpl')) S.tplApplied = true; }
  } catch (e) { toast(e.message, true); S = blank(); }
  $('#app').style.display = 'block'; pushHist(); renderAll();
  if (q.get('tpl') === 'idphoto') { const p = $('#panel'); p.insertAdjacentHTML('beforebegin', '<p class="hint warn">ID photo: only crop, rotate and adjust brightness. Do not change the face or details. Follow the rules of the office you will submit it to (size, background, no filters).</p>'); }
})();
