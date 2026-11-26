// js/studio.js — Creative Studio hub
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtD = (t) => new Date(t).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });

const TEMPLATES = [
  ['business', '📣', 'Business Advert', '1080×1080'], ['vtu', '📱', 'VTU Advert', '1080×1350'],
  ['birthday', '🎂', 'Birthday Design', '1080×1080'], ['social', '📲', 'Social Media Post', '1080×1080'],
  ['status', '💬', 'WhatsApp Status', '1080×1920'], ['product', '🛍️', 'Product Advert', '1080×1350'],
  ['idphoto', '🪪', 'ID Photo (35×45)', '413×531']
];

async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { location.href = 'index.html'; return; }
  const photo = await Studio.flag('studio_photo_enabled', { enabled: true });
  const video = await Studio.flag('studio_video_enabled', { enabled: false });
  if (photo.enabled === false) { const c = $('#c-photo'); c.classList.add('off'); c.removeAttribute('href'); c.querySelector('.ds').textContent = 'Currently unavailable'; }
  if (video.enabled === true) { const v = $('#c-video'); v.classList.remove('off'); v.onclick = () => location.href = 'video-editor.html'; v.querySelector('.ds').textContent = 'Trim, merge, text, music, story video'; }
  document.querySelectorAll('[data-sec]').forEach(el => el.onclick = () => show(el.dataset.sec));
  show('projects');
}

async function show(sec) {
  const box = $('#sec');
  if (sec === 'templates') {
    $('#sec-title').textContent = 'Templates';
    box.innerHTML = '<div class="st-grid">' + TEMPLATES.map(t => `<a class="st-card" href="photo-editor.html?tpl=${t[0]}"><div class="ic">${t[1]}</div><div class="nm">${esc(t[2])}</div><div class="ds">${esc(t[3])}</div></a>`).join('') + '</div>';
    return;
  }
  const store = sec === 'downloads' ? 'downloads' : 'projects';
  $('#sec-title').textContent = sec === 'downloads' ? 'Downloaded Files' : 'My Projects';
  box.innerHTML = '<div class="card">Loading…</div>';
  let rows = [];
  try { rows = await Studio.all(store); } catch (e) { box.innerHTML = '<div class="card">' + esc(e.message) + '</div>'; return; }
  if (!rows.length) { box.innerHTML = `<div class="card">${sec === 'downloads' ? 'No downloads yet.' : 'No saved projects yet. Open the Photo Editor and tap Save.'}</div>`; return; }
  box.innerHTML = '';
  rows.forEach(r => {
    const d = document.createElement('div'); d.className = 'list-row';
    d.innerHTML = `<img src="${esc(r.thumb || '')}" alt=""><div class="t"><b>${esc(r.name)}</b><span>${esc(fmtD(r.updated))}${r.size ? ' · ' + (r.size / 1024).toFixed(0) + ' KB' : ''}</span></div>
      ${sec === 'projects' ? '<button class="btn btn-primary sm" data-a="open">Open</button>' : ''}<button class="btn btn-ghost sm" data-a="del">Delete</button>`;
    d.querySelector('[data-a=del]').onclick = async () => { if (!confirm('Delete from this device?')) return; await Studio.del(store, r.id); show(sec); };
    const o = d.querySelector('[data-a=open]'); if (o) o.onclick = () => location.href = 'photo-editor.html?project=' + encodeURIComponent(r.id);
    box.appendChild(d);
  });
}
init();
