// js/video-editor.js — 100% in the browser (Canvas + MediaRecorder + WebAudio). Nothing is uploaded.
// Export records the timeline in REAL TIME (a 1-minute video takes ~1 minute). Keep the screen on.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, err) { const w = $('#toast-wrap'); const t = document.createElement('div'); t.className = 'toast ' + (err ? 'err' : 'ok'); t.textContent = msg; w.appendChild(t); setTimeout(() => t.remove(), 5000); }
const fmt = (s) => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const uid = () => Math.random().toString(36).slice(2, 9);

const cv = $('#cv'), g = cv.getContext('2d'), vid = $('#vid');
let limits = { max_mb: 100, max_minutes: 5 };
const P = { clips: [], texts: [], logo: null, wm: '', musicVol: 0.6, voiceVol: 1, muteOrig: false, W: 720, H: 1280, fit: 'contain', bg: '#000000' };
const srcs = {};                 // srcId -> { url, dur, name }
let music = null, voice = null;  // { el, url, name }
let sel = -1, tab = 'clips', t = 0, playing = false, last = 0, raf = 0, curSrc = null, exporting = false, speakOn = false, speakLang = '';
let actx = null, gV = null, gM = null, gO = null, dest = null, vSrcNode = null;

// ---------- timeline helpers ----------
const clipDur = (c) => c.type === 'scene' ? c.dur : Math.max(0.1, (c.end - c.start) / c.speed);
const total = () => P.clips.reduce((a, c) => a + clipDur(c), 0);
function locate(time) {
  let a = 0;
  for (let i = 0; i < P.clips.length; i++) { const d = clipDur(P.clips[i]); if (time < a + d || i === P.clips.length - 1) return { i, clip: P.clips[i], local: Math.min(Math.max(0, time - a), d), start: a, dur: d }; a += d; }
  return null;
}

// ---------- audio graph ----------
function audio() {
  if (actx) return;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  actx = new AC(); dest = actx.createMediaStreamDestination();
  gV = actx.createGain(); gM = actx.createGain(); gO = actx.createGain();
  [gV, gM, gO].forEach(n => { n.connect(dest); n.connect(actx.destination); });
  try { vSrcNode = actx.createMediaElementSource(vid); vSrcNode.connect(gV); } catch (e) { vSrcNode = null; }
  vid.muted = false;
}
function attachEl(obj, gain) { if (!actx || obj.node) return; try { obj.node = actx.createMediaElementSource(obj.el); obj.node.connect(gain); } catch (e) { /* already attached */ } }
function applyGains(c) {
  if (!actx) return;
  gV.gain.value = (P.muteOrig || !c || c.type !== 'video') ? 0 : c.vol;
  gM.gain.value = P.musicVol; gO.gain.value = P.voiceVol;
}

// ---------- drawing ----------
function wrapText(text, maxW, px) {
  g.font = `bold ${px}px Arial, sans-serif`; const out = [];
  String(text).split('\n').forEach(par => { let line = ''; par.split(' ').forEach(w => { const test = line ? line + ' ' + w : w; if (g.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test; }); out.push(line); });
  return out;
}
function drawText(txt, color, size, x, y, alpha, shadow) {
  const px = Math.max(10, size * P.W); const lines = wrapText(txt, P.W * 0.9, px);
  g.save(); g.globalAlpha = alpha == null ? 1 : alpha; g.font = `bold ${px}px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color;
  if (shadow !== false) { g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = px * .12; }
  lines.forEach((ln, i) => g.fillText(ln, x * P.W, y * P.H + (i - (lines.length - 1) / 2) * px * 1.2)); g.restore();
}
const THEMES = { Day: ['#7ec8ff', '#d9f1ff'], Night: ['#0b1f3a', '#3a2a6b'], Green: ['#0f3d2e', '#2f8f5b'], Sunset: ['#ff9966', '#ff5e62'], Fun: ['#7c2d92', '#ff7eb3'] };
function drawScene(c, local, dur) {
  const [a, b] = THEMES[c.theme] || THEMES.Green; const gr = g.createLinearGradient(0, 0, 0, P.H); gr.addColorStop(0, a); gr.addColorStop(1, b); g.fillStyle = gr; g.fillRect(0, 0, P.W, P.H);
  const em = c.emoji && c.emoji.length ? c.emoji : ['📖']; const n = em.length; const base = P.W * (n > 2 ? 0.26 : 0.34);
  const pop = Math.min(1, local / 0.5); const ease = 1 - Math.pow(1 - pop, 3);
  em.forEach((e, i) => {
    const bx = P.W * ((i + 1) / (n + 1)), by = P.H * 0.38 + Math.sin(local * 2.2 + i * 1.7) * P.H * 0.018;
    g.save(); g.translate(bx, by); g.rotate(Math.sin(local * 1.6 + i) * 0.06); g.scale(ease, ease); g.font = `${base}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e, 0, 0); g.restore();
  });
  const fade = Math.min(1, local / 0.4, (dur - local) / 0.3 + 0.01);
  g.save(); g.fillStyle = 'rgba(0,0,0,.35)'; const bh = P.H * 0.24; g.fillRect(0, P.H * 0.68, P.W, bh); g.restore();
  drawText(c.text, '#ffffff', 0.05, 0.5, 0.8, Math.max(0, fade), true);
}
function drawFrame() {
  g.fillStyle = P.bg; g.fillRect(0, 0, P.W, P.H);
  const loc = locate(t);
  if (loc) {
    const c = loc.clip;
    if (c.type === 'scene') drawScene(c, loc.local, c.dur);
    else if (vid.videoWidth) {
      const odd = c.rot % 2 === 1, iw = odd ? vid.videoHeight : vid.videoWidth, ih = odd ? vid.videoWidth : vid.videoHeight;
      const k = (P.fit === 'cover' ? Math.max : Math.min)(P.W / iw, P.H / ih) * c.zoom;
      g.save(); g.translate(P.W / 2 + c.px * P.W, P.H / 2 + c.py * P.H); g.rotate(c.rot * Math.PI / 2); g.scale(k, k); try { g.drawImage(vid, -vid.videoWidth / 2, -vid.videoHeight / 2); } catch (e) { /* frame not ready */ } g.restore();
    }
  }
  P.texts.forEach(x => { if (t >= x.from && t <= x.to) drawText(x.text, x.color, x.size, x.x, x.y, 1, true); });
  if (P.logo && P.logo.img) { const w = P.logo.size * P.W, h = w * P.logo.img.height / P.logo.img.width; g.save(); g.globalAlpha = P.logo.op; g.drawImage(P.logo.img, P.logo.x * P.W - w / 2, P.logo.y * P.H - h / 2, w, h); g.restore(); }
  if (P.wm) drawText(P.wm, '#ffffff', 0.035, 0.5, 0.95, 0.5, false);
}

// ---------- playback ----------
function setSrc(c) {
  if (curSrc === c.src) return;
  curSrc = c.src; vid.src = srcs[c.src].url; vid.load();
}
function sync(force) {
  const loc = locate(t); if (!loc) return; const c = loc.clip;
  applyGains(c);
  if (c.type === 'video') {
    setSrc(c); const want = c.start + loc.local * c.speed; vid.playbackRate = c.speed;
    if (force || Math.abs(vid.currentTime - want) > 0.35) { try { vid.currentTime = want; } catch (e) { /* not seekable yet */ } }
    if (playing && vid.paused) vid.play().catch(() => { });
    if (!playing && !vid.paused) vid.pause();
  } else { if (!vid.paused) vid.pause(); }
}
function syncAudio(force) {
  [[music, 'musicVol'], [voice, 'voiceVol']].forEach(([a]) => {
    if (!a) return; const d = a.el.duration || 0;
    if (playing) { if (force || Math.abs((a.el.currentTime) - (d ? t % d : t)) > 0.4) { try { a.el.currentTime = d ? t % d : t; } catch (e) { /* ignore */ } } if (a.el.paused) a.el.play().catch(() => { }); }
    else if (!a.el.paused) a.el.pause();
  });
}
let lastSpoken = -1;
function maybeSpeak(loc) {
  if (!speakOn || exporting || !playing || !window.speechSynthesis || !loc || loc.clip.type !== 'scene') return;
  if (lastSpoken === loc.i) return; lastSpoken = loc.i;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(loc.clip.text); if (speakLang) u.lang = speakLang; speechSynthesis.speak(u); } catch (e) { /* preview only */ }
}
function tick(ts) {
  raf = requestAnimationFrame(tick);
  if (playing) {
    const dt = Math.min(0.25, (ts - last) / 1000); last = ts;
    const loc = locate(t);
    const stalled = loc && loc.clip.type === 'video' && (vid.readyState < 2 || vid.seeking);
    if (!stalled) t += dt;
    if (t >= total()) { t = total(); pause(); if (exporting) finishExport(); }
    else { const l2 = locate(t); if (l2 && (l2.i !== (loc && loc.i))) sync(true); else sync(false); maybeSpeak(l2); }
    $('#scrub').value = t;
  }
  drawFrame(); $('#tl').textContent = fmt(t) + ' / ' + fmt(total());
}
function play() { if (!P.clips.length) return toast('Add a video or create a story first.', true); audio(); if (actx && actx.state === 'suspended') actx.resume(); if (music) attachEl(music, gM); if (voice) attachEl(voice, gO); if (t >= total()) t = 0; playing = true; last = performance.now(); lastSpoken = -1; sync(true); syncAudio(true); $('#b-play').textContent = '⏸ Pause'; }
function pause() { playing = false; vid.pause(); syncAudio(false); try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } $('#b-play').textContent = '▶ Play'; }
$('#b-play').onclick = () => { if (exporting) return; playing ? pause() : play(); };
$('#scrub').oninput = (e) => { if (exporting) return; t = +e.target.value; sync(true); syncAudio(true); drawFrame(); };

// ---------- files ----------
function sizeOK(f) { if (f.size > limits.max_mb * 1024 * 1024) { toast(`${f.name} is too large. Maximum is ${limits.max_mb} MB per file.`, true); return false; } return true; }
function probe(f) {
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(f); const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => { if (!isFinite(v.duration) || !v.videoWidth) { URL.revokeObjectURL(url); return no(new Error(`${f.name}: this browser cannot read this video. Try an MP4 (H.264) or WebM file.`)); } ok({ url, dur: v.duration, name: f.name }); };
    v.onerror = () => { URL.revokeObjectURL(url); no(new Error(`${f.name}: this video format is not supported on this device. Try an MP4 (H.264) or WebM file.`)); };
    v.src = url;
  });
}
$('#f-vid').onchange = async (e) => {
  const files = [...e.target.files]; e.target.value = '';
  for (const f of files) {
    if (!/^video\//.test(f.type) && !/\.(mp4|webm|mov|m4v|3gp|mkv)$/i.test(f.name)) { toast(`${f.name} is not a video.`, true); continue; }
    if (!sizeOK(f)) continue;
    try {
      const m = await probe(f); if (total() + m.dur > limits.max_minutes * 60) { URL.revokeObjectURL(m.url); toast(`Total length limit is ${limits.max_minutes} minutes.`, true); break; }
      const id = uid(); srcs[id] = m;
      P.clips.push({ id: uid(), type: 'video', src: id, start: 0, end: m.dur, speed: 1, vol: 1, rot: 0, zoom: 1, px: 0, py: 0, name: m.name }); sel = P.clips.length - 1;
    } catch (err) { toast(err.message, true); }
  }
  afterChange(true);
};
$('#f-logo').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (!/^image\//.test(f.type)) return toast('Choose an image.', true); if (!sizeOK(f)) return; const u = URL.createObjectURL(f), im = new Image(); im.onload = () => { P.logo = { img: im, x: .85, y: .08, size: .2, op: 1 }; renderPanel(); }; im.onerror = () => toast('Could not open that image.', true); im.src = u; };
function loadAudio(file, which) {
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg|webm)$/i.test(file.name)) return toast('Choose an audio file (MP3, WAV, M4A…).', true);
  if (!sizeOK(file)) return; const url = URL.createObjectURL(file); const el = new Audio(); el.preload = 'auto'; el.loop = true; el.src = url;
  el.onerror = () => toast('This audio format is not supported on this device.', true);
  el.onloadedmetadata = () => { const o = { el, url, name: file.name }; if (which === 'music') music = o; else voice = o; renderPanel(); toast((which === 'music' ? 'Music' : 'Voice-over') + ' added'); };
}
$('#f-music').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadAudio(f, 'music'); };
$('#f-voice').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadAudio(f, 'voice'); };

// ---------- UI ----------
const TABS = [['clips', '🎞 Clips'], ['edit', '✂️ Edit'], ['text', '🔤 Text'], ['logo', '🏷 Logo'], ['audio', '🎵 Audio'], ['story', '📖 Story'], ['export', '⬇ Export']];
const slider = (id, label, min, max, val, step) => `<label>${label}: <span id="${id}-v">${val}</span></label><input type="range" id="${id}" min="${min}" max="${max}" step="${step || 1}" value="${val}">`;
function bindSlider(id, fn) { const e = $('#' + id); if (!e) return; e.oninput = () => { fn(+e.value); $('#' + id + '-v').textContent = e.value; if (!playing) { sync(true); drawFrame(); } }; }
const selClip = () => P.clips[sel];
function afterChange(resetT) { const tt = total(); $('#scrub').max = tt; if (t > tt) t = tt; if (resetT && sel >= 0) { let a = 0; for (let i = 0; i < sel; i++) a += clipDur(P.clips[i]); t = a; $('#scrub').value = t; } curSrc = null; sync(true); renderAll(); }
function renderStrip() {
  $('#strip').innerHTML = P.clips.map((c, i) => `<button data-i="${i}" class="${i === sel ? 'on' : ''}">${c.type === 'scene' ? '🎭' : '🎬'} ${i + 1} · ${fmt(clipDur(c))}</button>`).join('') || '<span class="hint">No clips yet.</span>';
  $('#strip').querySelectorAll('button').forEach(b => b.onclick = () => { sel = +b.dataset.i; let a = 0; for (let i = 0; i < sel; i++) a += clipDur(P.clips[i]); t = a; curSrc = null; sync(true); renderAll(); });
}
function renderTabs() { $('#tabs').innerHTML = TABS.map(x => `<button data-t="${x[0]}" class="${tab === x[0] ? 'on' : ''}">${x[1]}</button>`).join(''); $('#tabs').querySelectorAll('button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderTabs(); renderPanel(); }); }
function renderAll() { renderStrip(); renderTabs(); renderPanel(); }

function renderPanel() {
  const p = $('#panel'); let h = ''; const c = selClip();
  if (tab === 'clips') {
    h = `<button class="btn btn-primary" id="p-add">🎬 Add video(s)</button><p class="hint">Up to ${limits.max_mb} MB per file and ${limits.max_minutes} minutes in total. MP4 (H.264) and WebM work best. Clips play one after another (merge).</p>`;
    if (c) h += `<div class="chips" style="margin-top:8px;"><button id="p-left">◀ Move earlier</button><button id="p-right">Move later ▶</button><button id="p-del" style="color:#c0392b;">Delete clip</button></div>`;
  } else if (tab === 'edit') {
    if (!c) h = '<p class="hint">Select a clip first.</p>';
    else if (c.type === 'scene') h = `<label>Scene text</label><textarea id="p-st" rows="3">${esc(c.text)}</textarea>${slider('p-sd', 'Seconds', 1, 20, c.dur, 0.5)}<div class="chips" style="margin-top:8px;"><button id="p-del" style="color:#c0392b;">Delete scene</button></div>`;
    else { const s = srcs[c.src]; h = `<p class="hint">${esc(c.name)} — ${fmt(s.dur)}</p>` + slider('p-ts', 'Trim: start (s)', 0, +(s.dur - 0.2).toFixed(1), +c.start.toFixed(1), 0.1) + slider('p-te', 'Trim: end (s)', 0.2, +s.dur.toFixed(1), +c.end.toFixed(1), 0.1) +
      `<label>Speed</label><div class="chips" id="p-sp">${[0.5, 0.75, 1, 1.5, 2, 3].map(x => `<button data-s="${x}" class="${c.speed === x ? 'on' : ''}">${x}×</button>`).join('')}</div>` + slider('p-vo', 'Volume %', 0, 100, Math.round(c.vol * 100)) +
      `<label>Rotate</label><div class="chips"><button id="p-rl">⟲ 90°</button><button id="p-rr">⟳ 90°</button></div>` + slider('p-zm', 'Crop zoom %', 100, 300, Math.round(c.zoom * 100)) + slider('p-px', 'Crop move ←→', -50, 50, Math.round(c.px * 100)) + slider('p-py', 'Crop move ↑↓', -50, 50, Math.round(c.py * 100)) +
      `<div class="chips" style="margin-top:10px;"><button id="p-split">✂️ Split at playhead</button><button id="p-del" style="color:#c0392b;">Delete clip</button></div><p class="hint">To cut out a middle part: Split twice, then Delete the middle piece.</p>`; }
  } else if (tab === 'text') {
    h = `<label>Text</label><input type="text" id="p-tx" placeholder="Type here"><div class="row2"><div><label>Color</label><input type="color" id="p-tc" value="#ffffff"></div><div><label>Size</label><select id="p-tz"><option value="0.05">Small</option><option value="0.07" selected>Medium</option><option value="0.1">Large</option></select></div></div>
      <div class="row2"><div><label>From (s)</label><input type="text" inputmode="decimal" id="p-tf" value="0"></div><div><label>To (s)</label><input type="text" inputmode="decimal" id="p-tt" value="${total().toFixed(1)}"></div></div>
      <label>Position (top → bottom)</label><input type="range" id="p-ty" min="5" max="95" value="50"><button class="btn btn-primary" id="p-addt" style="margin-top:10px;">＋ Add text</button>
      <div style="margin-top:10px;">${P.texts.map((x, i) => `<div class="list-row"><div class="t"><b>${esc(x.text)}</b><span>${fmt(x.from)}–${fmt(x.to)}</span></div><button class="btn btn-ghost sm" data-dt="${i}">Remove</button></div>`).join('')}</div>`;
  } else if (tab === 'logo') {
    h = `<button class="btn btn-primary" id="p-lg">🏷 Upload logo</button>` + (P.logo ? slider('p-ls', 'Logo size %', 5, 60, Math.round(P.logo.size * 100)) + slider('p-lo', 'Logo opacity %', 10, 100, Math.round(P.logo.op * 100)) + slider('p-lx', 'Left ↔ right', 0, 100, Math.round(P.logo.x * 100)) + slider('p-ly', 'Top ↕ bottom', 0, 100, Math.round(P.logo.y * 100)) + '<button class="btn btn-ghost" id="p-lrm" style="margin-top:8px;">Remove logo</button>' : '') +
      `<label>Watermark text (bottom)</label><input type="text" id="p-wm" value="${esc(P.wm)}" placeholder="e.g. Hadejia Data Hub">`;
  } else if (tab === 'audio') {
    h = `<label class="chips"><button id="p-mute" class="${P.muteOrig ? 'on' : ''}">${P.muteOrig ? '🔇 Original sound muted' : '🔊 Original sound on'}</button></label>` +
      `<button class="btn btn-primary" id="p-mu" style="margin-top:10px;">🎵 Add music (your own file)</button>${music ? `<p class="hint">${esc(music.name)}</p>` + slider('p-mv', 'Music volume %', 0, 100, Math.round(P.musicVol * 100)) + '<button class="btn btn-ghost" id="p-murm">Remove music</button>' : ''}` +
      `<p class="hint">Only use music you own or are allowed to use.</p><hr style="margin:12px 0;border:0;border-top:1px solid var(--line);">` +
      `<button class="btn btn-primary" id="p-vf">🎤 Add voice-over file</button><button class="btn btn-ghost" id="p-rec" style="margin-top:8px;">${recorder ? '⏹ Stop recording' : '⏺ Record voice with microphone'}</button>${voice ? `<p class="hint">${esc(voice.name)}</p>` + slider('p-vv', 'Voice volume %', 0, 100, Math.round(P.voiceVol * 100)) + '<button class="btn btn-ghost" id="p-vrm">Remove voice-over</button>' : ''}` +
      `<p class="hint">The microphone is only used when you tap Record, and the recording stays on your phone.</p>`;
  } else if (tab === 'story') {
    h = `<label>Write your story (max 1500 characters)</label><textarea id="p-story" rows="6" maxlength="1500" placeholder="Wata rana, wani yaro ya tafi gona da rana…&#10;Once upon a time, a boy went to the farm…"></textarea>
      <label>Look</label><div class="chips" id="p-th">${Object.keys(THEMES).map((k, i) => `<button data-th="${k}" class="${i === 2 ? 'on' : ''}">${k}</button>`).join('')}</div>
      <button class="btn btn-primary" id="p-gen" style="margin-top:10px;">✨ Create story video</button>
      <p class="hint warn">This builds simple animated scenes: emoji characters picked from the words in your story, moving captions, and your music/voice. It is not an AI-drawn cartoon. Add your own voice in the Audio tab.</p>
      <label>Computer voice (preview only — not saved in the exported video)</label><div class="row2"><select id="p-lang"></select><button class="btn btn-ghost" id="p-sp-on">${speakOn ? 'Voice: ON' : 'Voice: OFF'}</button></div>`;
  } else if (tab === 'export') {
    const mt = pickMime();
    h = `<label>Video size</label><div class="chips" id="p-sz">${[['9:16 (720×1280)', 720, 1280], ['16:9 (1280×720)', 1280, 720], ['1:1 (720×720)', 720, 720]].map(x => `<button data-w="${x[1]}" data-h="${x[2]}" class="${P.W === x[1] && P.H === x[2] ? 'on' : ''}">${x[0]}</button>`).join('')}</div>
      <label>Picture fit</label><div class="chips" id="p-ft"><button data-f="contain" class="${P.fit === 'contain' ? 'on' : ''}">Fit inside</button><button data-f="cover" class="${P.fit === 'cover' ? 'on' : ''}">Fill frame</button></div>
      <p class="hint">Total length: <b>${fmt(total())}</b>. Export runs in real time, so it takes about the same time as the video. Keep this screen open and awake.</p>
      <p class="hint">${mt ? 'Format: ' + (mt.ext === 'mp4' ? 'MP4' : 'WebM') + ' (what this browser can create).' : '<b style="color:#c0392b;">This browser cannot export video. Use Chrome.</b>'}</p>
      <button class="btn btn-primary" id="p-exp" ${mt ? '' : 'disabled'}>⬇ Export video</button><div id="prog" style="margin-top:10px;"></div>`;
  }
  p.innerHTML = h; bindPanel();
  if (tab === 'story') fillVoices();
}
function fillVoices() {
  const sl = $('#p-lang'); if (!sl) return;
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : []; const langs = [...new Set(vs.map(v => v.lang))].sort();
  sl.innerHTML = langs.length ? langs.map(l => `<option ${l === speakLang ? 'selected' : ''}>${l}</option>`).join('') : '<option value="">No computer voices on this device</option>';
  sl.onchange = () => { speakLang = sl.value; };
  if (!speakLang && langs.length) speakLang = sl.value;
}
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { if (tab === 'story') fillVoices(); };

let recorder = null, recChunks = [];
async function toggleRec() {
  if (recorder) { recorder.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return toast('This browser does not support voice recording.', true);
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true }); recChunks = []; recorder = new MediaRecorder(st);
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => { st.getTracks().forEach(x => x.stop()); const type = recorder.mimeType || 'audio/webm'; recorder = null; const blob = new Blob(recChunks, { type }); if (blob.size) loadAudio(new File([blob], 'voice-over.' + (type.includes('mp4') ? 'm4a' : 'webm'), { type }), 'voice'); renderPanel(); };
    recorder.start(); renderPanel(); toast('Recording… tap Stop when done');
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser settings.' : 'Could not use the microphone.', true); }
}

function bindPanel() {
  const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; }; const c = selClip();
  on('p-add', () => $('#f-vid').click());
  on('p-left', () => { if (sel > 0) { [P.clips[sel - 1], P.clips[sel]] = [P.clips[sel], P.clips[sel - 1]]; sel--; afterChange(); } });
  on('p-right', () => { if (sel < P.clips.length - 1) { [P.clips[sel + 1], P.clips[sel]] = [P.clips[sel], P.clips[sel + 1]]; sel++; afterChange(); } });
  on('p-del', () => { P.clips.splice(sel, 1); sel = Math.min(sel, P.clips.length - 1); t = 0; afterChange(); });
  bindSlider('p-ts', v => { c.start = Math.min(v, c.end - 0.2); afterChange2(); }); bindSlider('p-te', v => { c.end = Math.max(v, c.start + 0.2); afterChange2(); });
  document.querySelectorAll('#p-sp button').forEach(b => b.onclick = () => { c.speed = +b.dataset.s; afterChange(); });
  bindSlider('p-vo', v => c.vol = v / 100); on('p-rl', () => { c.rot = (c.rot + 3) % 4; drawFrame(); }); on('p-rr', () => { c.rot = (c.rot + 1) % 4; drawFrame(); });
  bindSlider('p-zm', v => c.zoom = v / 100); bindSlider('p-px', v => c.px = v / 100); bindSlider('p-py', v => c.py = v / 100);
  on('p-split', () => {
    const loc = locate(t); if (!loc || loc.clip.type !== 'video') return toast('Move the playhead over a video clip first.', true);
    const k = loc.clip; const at = k.start + loc.local * k.speed; if (at - k.start < 0.2 || k.end - at < 0.2) return toast('Move the playhead further from the clip edge.', true);
    const b = Object.assign({}, k, { id: uid(), start: at }); k.end = at; P.clips.splice(loc.i + 1, 0, b); sel = loc.i; afterChange();
  });
  const st = $('#p-st'); if (st) st.oninput = () => { c.text = st.value; drawFrame(); }; bindSlider('p-sd', v => { c.dur = v; afterChange2(); });
  on('p-addt', () => { const x = ($('#p-tx').value || '').trim(); if (!x) return toast('Type some text.', true); const f = parseFloat($('#p-tf').value) || 0, to = parseFloat($('#p-tt').value) || total(); P.texts.push({ text: x, color: $('#p-tc').value, size: +$('#p-tz').value, x: .5, y: (+$('#p-ty').value) / 100, from: f, to: Math.max(to, f + .1) }); renderPanel(); drawFrame(); });
  document.querySelectorAll('[data-dt]').forEach(b => b.onclick = () => { P.texts.splice(+b.dataset.dt, 1); renderPanel(); drawFrame(); });
  on('p-lg', () => $('#f-logo').click()); on('p-lrm', () => { P.logo = null; renderPanel(); });
  bindSlider('p-ls', v => P.logo.size = v / 100); bindSlider('p-lo', v => P.logo.op = v / 100); bindSlider('p-lx', v => P.logo.x = v / 100); bindSlider('p-ly', v => P.logo.y = v / 100);
  const wm = $('#p-wm'); if (wm) wm.oninput = () => { P.wm = wm.value; drawFrame(); };
  on('p-mute', () => { P.muteOrig = !P.muteOrig; sync(false); renderPanel(); });
  on('p-mu', () => $('#f-music').click()); on('p-murm', () => { music.el.pause(); music = null; renderPanel(); }); bindSlider('p-mv', v => { P.musicVol = v / 100; applyGains(selClip()); });
  on('p-vf', () => $('#f-voice').click()); on('p-rec', toggleRec); on('p-vrm', () => { voice.el.pause(); voice = null; renderPanel(); }); bindSlider('p-vv', v => { P.voiceVol = v / 100; applyGains(selClip()); });
  let theme = 'Green'; document.querySelectorAll('#p-th button').forEach(b => b.onclick = () => { theme = b.dataset.th; document.querySelectorAll('#p-th button').forEach(x => x.classList.toggle('on', x === b)); });
  on('p-gen', () => makeStory($('#p-story').value, theme)); on('p-sp-on', () => { speakOn = !speakOn; renderPanel(); });
  document.querySelectorAll('#p-sz button').forEach(b => b.onclick = () => { P.W = +b.dataset.w; P.H = +b.dataset.h; cv.width = P.W; cv.height = P.H; drawFrame(); renderPanel(); });
  document.querySelectorAll('#p-ft button').forEach(b => b.onclick = () => { P.fit = b.dataset.f; renderPanel(); drawFrame(); });
  on('p-exp', startExport);
}
function afterChange2() { $('#scrub').max = total(); renderStrip(); if (!playing) { sync(true); drawFrame(); } }

// ---------- story -> scenes ----------
const EMO = [['sarki|king', '👑'], ['sarauniya|queen', '👸'], ['yaro|boy', '👦'], ['yarinya|girl', '👧'], ['kare|dog', '🐶'], ['kyanwa|cat', '🐱'], ['zaki|lion', '🦁'], ['gida|house|home', '🏠'], ['rana|sun', '☀️'], ['ruwan sama|rain', '🌧️'], ['ruwa|water|river', '💧'], ['mota|car', '🚗'], ['kudi|money', '💰'], ['gona|farm', '🌾'], ['dare|night|moon|wata', '🌙'], ['abinci|food|eat|ci', '🍲'], ['makaranta|school', '🏫'], ['malami|teacher', '👨‍🏫'], ['mutum|man', '🧑'], ['mace|woman', '👩'], ['kifi|fish', '🐟'], ['saniya|shanu|cow', '🐄'], ['tsuntsu|bird', '🐦'], ['bishiya|itace|tree', '🌳'], ['waya|phone', '📱'], ['soyayya|love', '❤️'], ['farin ciki|murna|happy', '😀'], ['bakin ciki|kuka|sad|cry', '😢'], ['wuta|fire', '🔥'], ['jirgi|plane|jirgin sama', '✈️'], ['kasuwa|market', '🛒'], ['masallaci|mosque', '🕌'], ['littafi|book', '📖'], ['biri|monkey', '🐒'], ['kaza|chicken', '🐔'], ['akuya|goat', '🐐'], ['doki|horse', '🐴'], ['fure|flower', '🌸'], ['tauraro|star', '⭐'], ['wasa|game|football|kwallo', '⚽'], ['hanya|road', '🛣️'], ['kyauta|gift', '🎁']];
function emojiFor(sentence, idx) {
  const s = ' ' + sentence.toLowerCase().replace(/[^\p{L}' ]/gu, ' ') + ' '; const out = [];
  EMO.forEach(([keys, e]) => { if (out.length < 3 && keys.split('|').some(k => s.includes(' ' + k + ' ') || (k.length > 4 && s.includes(k)))) out.push(e); });
  if (!out.length) out.push(['🌟', '📖', '✨', '🎈'][idx % 4]);
  return out;
}
function makeStory(text, theme) {
  text = String(text || '').trim(); if (text.length < 10) return toast('Write a longer story first.', true);
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?\n]+[.!?]*/g).map(x => x.trim()).filter(Boolean).slice(0, 25);
  const scenes = sentences.map((s, i) => ({ id: uid(), type: 'scene', text: s, emoji: emojiFor(s, i), theme, dur: Math.min(12, Math.max(2.5, s.split(' ').length * 0.5)) }));
  if (total() + scenes.reduce((a, c) => a + c.dur, 0) > limits.max_minutes * 60) return toast(`Too long: the limit is ${limits.max_minutes} minutes.`, true);
  P.clips.push(...scenes); sel = P.clips.length - scenes.length; afterChange(true); toast(scenes.length + ' scenes created. Press Play.');
}

// ---------- export ----------
function pickMime() {
  if (!window.MediaRecorder || !cv.captureStream) return null;
  const list = [['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm', 'webm']];
  for (const [m, ext] of list) { try { if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext }; } catch (e) { /* next */ } } return null;
}
let rec = null, chunks = [], wake = null, expInfo = null, progTimer = 0;
async function startExport() {
  if (!P.clips.length) return toast('Add a video or create a story first.', true);
  if (total() > limits.max_minutes * 60) return toast(`Maximum is ${limits.max_minutes} minutes.`, true);
  const mt = pickMime(); if (!mt) return toast('This browser cannot export video. Use Chrome.', true);
  pause(); audio(); if (actx.state === 'suspended') await actx.resume(); if (music) attachEl(music, gM); if (voice) attachEl(voice, gO);
  exporting = true; t = 0; expInfo = mt; chunks = [];
  const stream = cv.captureStream(30); dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  try { rec = new MediaRecorder(stream, { mimeType: mt.mime, videoBitsPerSecond: 2500000 }); } catch (e) { exporting = false; return toast('Could not start the export on this device.', true); }
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    clearInterval(progTimer); exporting = false; try { if (wake) wake.release(); } catch (e) { /* ignore */ } wake = null;
    const blob = new Blob(chunks, { type: mt.mime.split(';')[0] }); if (!blob.size) return toast('The export produced an empty file. Try a shorter or smaller video.', true);
    const name = `hadejia-video-${Date.now()}.${mt.ext}`; const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    try { Studio.put('downloads', { id: Studio.uid(), name, updated: Date.now(), size: blob.size, thumb: cv.toDataURL('image/jpeg', .5) }); } catch (e) { /* optional */ }
    const pr = $('#prog'); if (pr) pr.innerHTML = '<p class="hint">✅ Done — ' + esc(name) + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)</p>'; toast('Video exported');
  };
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  rec.start(1000); play();
  progTimer = setInterval(() => { const pr = $('#prog'); if (pr) pr.innerHTML = `<div style="background:var(--paper-dim);border-radius:8px;overflow:hidden;height:14px;"><div style="background:var(--teal);height:14px;width:${Math.min(100, t / total() * 100).toFixed(0)}%"></div></div><p class="hint">Exporting… ${Math.round(t / total() * 100)}% — keep this screen open.</p>`; }, 500);
}
function finishExport() { try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* ignore */ } }

window.addEventListener('beforeunload', (e) => { if (P.clips.length) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && exporting) toast('Export may stop if you leave this screen.', true); });
vid.onerror = () => { if (curSrc) toast('This video could not be played on this device.', true); };

// ---------- boot ----------
(async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { location.href = 'index.html'; return; }
  const f = await Studio.flag('studio_video_enabled', { enabled: false, max_mb: 100, max_minutes: 5 });
  if (f.enabled !== true) { const b = $('#blocked'); b.style.display = 'block'; b.textContent = 'The Video Editor is currently unavailable. Please try again later.'; return; }
  limits.max_mb = Math.max(5, Number(f.max_mb) || 100); limits.max_minutes = Math.max(1, Number(f.max_minutes) || 5);
  $('#app').style.display = 'block'; cv.width = P.W; cv.height = P.H; renderAll(); raf = requestAnimationFrame(tick);
})();
