'use strict';

/**
 * lib/identityProvider.js — provider adapter for identity verification.
 *
 * A service is "configured" ONLY if an endpoint spec exists for it AND every
 * ${ENV_VAR} that spec uses is set in Vercel. Otherwise the site shows
 * "NOT CONFIGURED" and nothing is ever faked.
 *
 * Built-in specs (Dojah, from its public docs — test with YOUR keys/sandbox):
 *   nin       -> GET  {base}/api/v1/kyc/nin?nin=
 *   bvn       -> GET  {base}/api/v1/kyc/bvn/full?bvn=
 *   vnin      -> GET  {base}/api/v1/kyc/vnin?vnin=
 *   nin_slip  -> GET  {base}/api/v1/kyc/nin/nin_slip?nin=
 *   env: IDV_DOJAH_APP_ID, IDV_DOJAH_SECRET_KEY, (optional) IDV_DOJAH_BASE_URL
 *
 * Any other provider / service: IDV_ENDPOINTS_JSON (env), e.g.
 *   {"cac_registration":{"method":"POST","url":"https://x.com/cac",
 *     "headers":{"Authorization":"Bearer ${IDV_X_KEY}"},
 *     "body":{"name":"{{business_name}}"},"entityPath":"data"}}
 * Optional keys: documentPath (where the slip PDF base64 is), okPath+okValue (success flag).
 * {{field}} = customer input, ${NAME} = environment variable. Secrets never
 * leave the server. An entry in IDV_ENDPOINTS_JSON overrides a built-in one.
 *
 * call() returns { outcome: 'success'|'failed'|'uncertain', message, entity, result, documents, photo, providerRef }
 *   success   - real record returned
 *   failed    - provider definitely returned nothing -> caller refunds
 *   uncertain - timeout/network: we do NOT know -> caller keeps it pending (no refund)
 */

const axios = require('axios');

function dojah(path, param) {
  const base = () => (process.env.IDV_DOJAH_BASE_URL || 'https://api.dojah.io').replace(/\/+$/, '');
  return {
    provider: 'dojah',
    method: 'GET',
    url: () => base() + path,
    headers: { AppId: '${IDV_DOJAH_APP_ID}', Authorization: '${IDV_DOJAH_SECRET_KEY}' },
    query: { [param]: `{{${param}}}` },
    entityPath: 'entity'
  };
}

const BUILTIN = {
  nin: dojah('/api/v1/kyc/nin', 'nin'),
  bvn: dojah('/api/v1/kyc/bvn/full', 'bvn'),
  vnin: dojah('/api/v1/kyc/vnin', 'vnin'),
  nin_slip: dojah('/api/v1/kyc/nin/nin_slip', 'nin')
};

function customSpecs() {
  const raw = process.env.IDV_ENDPOINTS_JSON;
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    console.error('[identity] IDV_ENDPOINTS_JSON is not valid JSON');
    return {};
  }
}

function getSpec(code) {
  const c = customSpecs()[code];
  if (c && typeof c === 'object' && c.url) return Object.assign({ provider: 'custom', method: 'GET' }, c);
  return BUILTIN[code] || null;
}

const ENV_RE = /\$\{([A-Z0-9_]+)\}/g;

function envNames(str) {
  const out = [];
  String(str || '').replace(ENV_RE, (_, n) => { out.push(n); return ''; });
  return out;
}

function specStrings(spec) {
  const url = typeof spec.url === 'function' ? spec.url() : spec.url;
  return [url].concat(Object.values(spec.headers || {}), Object.values(spec.query || {}), JSON.stringify(spec.body || {}));
}

/** true only when a spec exists and all its env vars are present */
function isConfigured(code) {
  const spec = getSpec(code);
  if (!spec) return false;
  return specStrings(spec).every(s => envNames(s).every(n => !!process.env[n]));
}

function fill(str, input) {
  return String(str)
    .replace(ENV_RE, (_, n) => process.env[n] || '')
    .replace(/\{\{([a-z_0-9]+)\}\}/gi, (_, k) => (input[k] == null ? '' : String(input[k])));
}

function fillDeep(v, input) {
  if (typeof v === 'string') return fill(v, input);
  if (Array.isArray(v)) return v.map(x => fillDeep(x, input));
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach(k => { o[k] = fillDeep(v[k], input); });
    return o;
  }
  return v;
}

function pick(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

// ---- normalising the provider's real response --------------------------
const PHOTO_KEYS = ['photo', 'image', 'picture', 'passport', 'base64image'];
const DOC_KEYS = ['nin_id', 'slip', 'pdf', 'document', 'slip_pdf'];
const ID_KEYS = /^(nin|bvn|vnin|id_number)$/i;

function label(k) {
  return String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase());
}

function mask(v) {
  const s = String(v);
  if (s.length <= 4) return s;
  return s.slice(0, 3) + '*'.repeat(Math.max(s.length - 5, 1)) + s.slice(-2);
}

const isB64 = (s) => typeof s === 'string' && s.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(s.slice(0, 200));

function normalise(entity) {
  const e = entity || {};
  const get = (...keys) => { for (const k of keys) { if (e[k]) return String(e[k]); } return ''; };
  const first = get('first_name', 'firstname', 'firstName');
  const middle = get('middle_name', 'middlename', 'middleName');
  const last = get('last_name', 'surname', 'lastname', 'lastName');
  const name = [last || null, first || null, middle || null].filter(Boolean).join(' ') || get('name', 'full_name', 'name_on_card');

  let photo = null;
  const documents = [];
  const fields = [];
  let idMasked = '';

  Object.keys(e).forEach((k) => {
    const v = e[k];
    const lk = k.toLowerCase();
    if (PHOTO_KEYS.includes(lk) && isB64(v)) { photo = String(v).replace(/^data:[^,]+,/, '').replace(/\s/g, ''); return; }
    if (DOC_KEYS.includes(lk) && isB64(v)) {
      const b = String(v).replace(/\s/g, '');
      if (b.startsWith('JVBERi0')) documents.push({ kind: 'slip', mime: 'application/pdf', ext: 'pdf', base64: b });
      return;
    }
    if (v == null || v === '' || typeof v === 'object') return;
    const s = String(v);
    if (s.length > 300) return;
    if (ID_KEYS.test(k)) { const m = mask(s); if (!idMasked) idMasked = m; fields.push({ label: label(k), value: m }); return; }
    fields.push({ label: label(k), value: s });
  });

  return { name, fields, photo, documents, idMasked };
}

// ---- the call -------------------------------------------------------------
async function call(code, input) {
  const spec = getSpec(code);
  if (!spec || !isConfigured(code)) {
    return { outcome: 'failed', message: 'This service is not configured yet', notConfigured: true };
  }
  const url = fill(typeof spec.url === 'function' ? spec.url() : spec.url, input);
  const headers = fillDeep(spec.headers || {}, input);
  const params = spec.query ? fillDeep(spec.query, input) : undefined;
  const data = spec.body ? fillDeep(spec.body, input) : undefined;

  let res;
  try {
    res = await axios({
      method: (spec.method || 'GET').toUpperCase(),
      url, headers, params, data,
      timeout: spec.timeoutMs || 25000,
      validateStatus: () => true,
      maxContentLength: 15 * 1024 * 1024
    });
  } catch (err) {
    // no HTTP answer at all (timeout / DNS / reset): we cannot know if it was processed
    return { outcome: 'uncertain', message: 'The provider did not answer in time' };
  }

  const body = res.data;
  const providerMsg = (body && (body.message || body.error || body.detail)) ? String(body.message || body.error || body.detail).slice(0, 200) : '';

  if (res.status >= 200 && res.status < 300) {
    const entity = pick(body, spec.entityPath === undefined ? 'entity' : spec.entityPath) || null;
    // optional: provider says "ok" in a field (e.g. response_code === "00")
    if (spec.okPath && String(pick(body, spec.okPath)) !== String(spec.okValue)) {
      return { outcome: 'failed', message: providerMsg || 'No record found for this number' };
    }
    if (entity && typeof entity === 'object' && Object.keys(entity).length > 0) {
      const n = normalise(entity);
      // optional: provider sends the slip PDF outside the entity (e.g. "pdf_base64")
      const pdf = spec.documentPath ? pick(body, spec.documentPath) : null;
      if (isB64(pdf) && String(pdf).replace(/\s/g, '').startsWith('JVBERi0')) {
        n.documents.push({ kind: 'slip', mime: 'application/pdf', ext: 'pdf', base64: String(pdf).replace(/\s/g, '') });
      }
      return {
        outcome: 'success',
        message: 'Verified',
        result: { name: n.name, fields: n.fields },
        photo: n.photo,
        documents: n.documents,
        idMasked: n.idMasked,
        providerRef: String(pick(body, spec.referencePath || 'reference') || pick(entity, 'reference') || '') || null
      };
    }
    return { outcome: 'failed', message: providerMsg || 'No record found for this number' };
  }

  if (res.status === 400 || res.status === 404 || res.status === 422) {
    return { outcome: 'failed', message: providerMsg || 'No record found for this number' };
  }
  // our own key rejected / provider wallet empty / rate limit / provider down: nothing was delivered
  console.error('[identity] provider error', code, res.status, providerMsg);
  return { outcome: 'failed', message: 'Service temporarily unavailable. Please try again later.', providerError: true };
}

module.exports = { isConfigured, call, getSpec };
