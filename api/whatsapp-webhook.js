'use strict';

/**
 * api/whatsapp-webhook.js
 *
 * GET  /api/whatsapp-webhook
 *      Meta webhook verification handshake.
 *
 * POST /api/whatsapp-webhook
 *      Incoming WhatsApp webhook events.
 *
 * ARCHITECTURE (per approved architecture report):
 *   WhatsApp -> this file -> lib/orderService.js#executeOrder()
 *            -> lib/wallet.js + lib/transactions.js + AutosyncNG
 *   Funding  -> lib/securewave.js (same as fund-wallet-init.js)
 *   Auth     -> Supabase Auth + public.users (same schema as the rest
 *               of the app; NOT lib/auth2.js, which is stale/unused)
 *   State    -> public.whatsapp_sessions (existing table, reused)
 *   Dedup    -> public.whatsapp_messages (new — see 13_whatsapp_messages.sql)
 *
 * No wallet, transaction, VTU, or customer system is duplicated here.
 *
 * IMPORTANT:
 * Vercel must NOT parse the request body before we verify
 * X-Hub-Signature-256, so bodyParser is disabled below.
 */

const crypto = require('crypto');
const axios = require('axios');

const { supabaseAdmin } = require('../lib/supabaseAdmin');
const transactions = require('../lib/transactions');
const securewave = require('../lib/securewave');
const orderService = require('../lib/orderService');
const validation = require('../lib/validation');
const wallet = require('../lib/wallet');
const referral = require('../lib/referral');
const manualFunding = require('../lib/manualFunding');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

const GRAPH_API_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID || !APP_SECRET) {
  throw new Error(
    'Missing required env vars: WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and/or WHATSAPP_APP_SECRET'
  );
}

module.exports.config = {
  api: {
    bodyParser: false
  }
};

// ---------------------------------------------------------------------
// NUMBER LABELS
// ---------------------------------------------------------------------

const NUM_EMOJI = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function numLabel(n) {
  return n <= 10 ? NUM_EMOJI[n] : `${n}.`;
}

// ---------------------------------------------------------------------
// RAW BODY + SIGNATURE VERIFICATION (unchanged from existing webhook)
// ---------------------------------------------------------------------

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error) => reject(error));
  });
}

function isValidSignature(rawBody, signatureHeader) {
  if (!signatureHeader) {
    console.error('[WEBHOOK] Missing X-Hub-Signature-256 header');
    return false;
  }
  if (!signatureHeader.startsWith('sha256=')) {
    console.error('[WEBHOOK] Invalid signature format');
    return false;
  }

  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');

  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (error) {
    console.error('[WEBHOOK] Signature comparison error:', error);
    return false;
  }
}

// ---------------------------------------------------------------------
// SEND WHATSAPP MESSAGE
// ---------------------------------------------------------------------

async function sendMessage(toNumber, text) {
  try {
    const response = await axios.post(
      GRAPH_API_URL,
      { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return response.data;
  } catch (error) {
    console.error(
      '[WHATSAPP] FAILED TO SEND MESSAGE:',
      error.response ? JSON.stringify(error.response.data) : error.message
    );
    throw error;
  }
}

// ---------------------------------------------------------------------
// PHONE NUMBER HELPERS
// ---------------------------------------------------------------------

/**
 * Canonical WhatsApp-side key, e.g. "2348032059714". Meta's own
 * `message.from` is already reported in this format, but we
 * normalize defensively in case a local ("0...") or "+234..." form
 * ever reaches this function from another code path.
 */
function toWhatsAppCanonical(raw) {
  let cleaned = String(raw || '').replace(/[\s+()-]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = `234${cleaned.slice(1)}`;
  }
  return cleaned;
}

/**
 * Convert a WhatsApp-format number to the EXACT format already used
 * by users.phone ("08032059714"). Reuses the existing normalizer from
 * lib/validation.js rather than duplicating the logic — per decision,
 * users.phone is NOT being migrated to a 234-prefixed format.
 */
function toLocalPhone(waNumber) {
  return validation.normalizeNigerianPhone(waNumber);
}

// ---------------------------------------------------------------------
// DUPLICATE MESSAGE PROTECTION
// ---------------------------------------------------------------------

/**
 * Atomically records a WhatsApp message id. Returns true the first
 * time a given message id is seen, false on every subsequent
 * (duplicate) delivery. Safe under concurrent requests: relies on the
 * unique constraint on whatsapp_messages.message_id rather than a
 * separate check-then-insert.
 */
async function claimMessage(messageId, waNumber) {
  const { error } = await supabaseAdmin
    .from('whatsapp_messages')
    .insert({ message_id: messageId, wa_number: waNumber });

  if (!error) return true;

  if (error.code === '23505') {
    // Unique violation — another (or the same) request already
    // claimed this message id. This is the expected, safe outcome
    // for a duplicate delivery.
    return false;
  }

  throw new Error(`Failed to record WhatsApp message id: ${error.message}`);
}

// ---------------------------------------------------------------------
// SESSION HELPERS
// ---------------------------------------------------------------------

async function getOrCreateSession(waNumber) {
  const { data: existing, error: findErr } = await supabaseAdmin
    .from('whatsapp_sessions')
    .select('*')
    .eq('wa_number', waNumber)
    .maybeSingle();

  if (findErr) throw new Error(`Session lookup failed: ${findErr.message}`);
  if (existing) return existing;

  const { data: created, error: createErr } = await supabaseAdmin
    .from('whatsapp_sessions')
    .insert({ wa_number: waNumber, state: 'awaiting_verification' })
    .select()
    .single();

  if (createErr) throw new Error(`Session creation failed: ${createErr.message}`);
  return created;
}

async function setState(session, state, context) {
  const patch = { state, last_message_at: new Date().toISOString() };
  if (context !== undefined) patch.context = context;

  const { error } = await supabaseAdmin.from('whatsapp_sessions').update(patch).eq('id', session.id);
  if (error) throw new Error(`Session state update failed: ${error.message}`);

  session.state = state;
  if (context !== undefined) session.context = context;
}

async function linkUser(session, userId) {
  const { error } = await supabaseAdmin.from('whatsapp_sessions').update({ user_id: userId }).eq('id', session.id);
  if (error) throw new Error(`Session user link failed: ${error.message}`);
  session.user_id = userId;
}

// ---------------------------------------------------------------------
// MAIN MENU
// ---------------------------------------------------------------------

const MAIN_MENU_TEXT =
  '🏠 *Hadejia Data Hub*\n\n' +
  'What would you like to do?\n\n' +
  `${numLabel(1)} Buy Data\n` +
  `${numLabel(2)} Buy Voice\n` +
  `${numLabel(3)} Buy Airtime\n` +
  `${numLabel(4)} Fund Wallet\n` +
  `${numLabel(5)} Check Balance\n` +
  `${numLabel(6)} Transaction History\n` +
  `${numLabel(7)} My Account\n` +
  `${numLabel(8)} Help\n\n` +
  'Reply with a number. You can type *menu* anytime to come back here.';

async function goToMainMenu(session, greeting) {
  await setState(session, 'main_menu', {});
  const message = greeting ? `${greeting}\n\n${MAIN_MENU_TEXT}` : MAIN_MENU_TEXT;
  await sendMessage(session.wa_number, message);
}

// ---------------------------------------------------------------------
// CUSTOMER IDENTIFICATION (replaces the old email/phone "verification"
// step — the customer never types their own number)
// ---------------------------------------------------------------------

const WELCOME_NEW_CUSTOMER_TEXT =
  '👋 *Welcome to Hadejia Data Hub!*\n\n' +
  "You don't have an account yet.\n\n" +
  "Let's create your account in less than 2 minutes.\n\n" +
  'Reply:\n\n' +
  '*YES* — Create Account\n' +
  '*CANCEL* — Stop';

const IDLE_PROMPT = 'Whenever you\'re ready, send *Hi* to get started.';

async function identifyOrStartRegistration(session) {
  // Already linked to an account from a previous session — just
  // re-verify the account is still active before showing the menu.
  if (session.user_id) {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('full_name, status')
      .eq('id', session.user_id)
      .maybeSingle();

    if (!error && user) {
      if (user.status === 'suspended' || user.status === 'banned') {
        await setState(session, 'idle', {});
        await sendMessage(
          session.wa_number,
          'Your Hadejia Data Hub account is currently inactive. Please contact support.'
        );
        return;
      }
      await goToMainMenu(session, `Welcome back, ${user.full_name || 'there'}! 👋`);
      return;
    }
    // Fall through to a fresh lookup if the linked user vanished somehow.
  }

  const localPhone = toLocalPhone(session.wa_number);

  if (!localPhone) {
    // Can't map this WhatsApp number to a Nigerian local phone format
    // at all — nothing more we can safely automate.
    await setState(session, 'idle', {});
    await sendMessage(
      session.wa_number,
      "We couldn't recognize this WhatsApp number format. Please contact support."
    );
    return;
  }

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('id, full_name, status')
    .eq('phone', localPhone)
    .maybeSingle();

  if (error) throw new Error(`Customer lookup failed: ${error.message}`);

  if (user) {
    if (user.status === 'suspended' || user.status === 'banned') {
      await setState(session, 'idle', {});
      await sendMessage(
        session.wa_number,
        'Your Hadejia Data Hub account is currently inactive. Please contact support.'
      );
      return;
    }

    await linkUser(session, user.id);
    await goToMainMenu(session, `Welcome back, ${user.full_name || 'there'}! 👋`);
    return;
  }

  await setState(session, 'awaiting_registration_confirmation', {});
  await sendMessage(session.wa_number, WELCOME_NEW_CUSTOMER_TEXT);
}

// ---------------------------------------------------------------------
// REGISTRATION — orphaned-auth-user cleanup helper
// ---------------------------------------------------------------------

/**
 * The Supabase Auth account is created as soon as the customer
 * supplies a password (see handleAwaitingPassword below) so that the
 * plaintext password is never persisted anywhere, including
 * whatsapp_sessions.context — it only ever exists in this function's
 * memory for the single request that creates the Auth account.
 *
 * That means between the password step and final CONFIRM, an Auth
 * user can exist with no matching public.users row yet. If the
 * customer cancels, abandons, or account creation fails at the final
 * step, we clean that orphaned Auth user up rather than leaving a
 * dangling account nobody can use or retry with.
 */
async function cleanupOrphanedAuthUser(pendingUserId) {
  if (!pendingUserId) return;
  try {
    await supabaseAdmin.auth.admin.deleteUser(pendingUserId);
  } catch (err) {
    console.error('[REGISTRATION] Failed to clean up orphaned auth user:', err.message);
  }
}

async function cancelRegistration(session, customMessage) {
  const pendingUserId = session.context && session.context.pending_user_id;
  await cleanupOrphanedAuthUser(pendingUserId);

  await setState(session, 'idle', {});
  await sendMessage(
    session.wa_number,
    customMessage ||
      '❌ Registration cancelled.\n\nNo account has been created.\n\nWhenever you\'re ready, send "Hi" to start again.'
  );
}

// ---------------------------------------------------------------------
// REGISTRATION STEPS
// ---------------------------------------------------------------------

async function handleAwaitingRegistrationConfirmation(session, text) {
  const choice = text.trim().toUpperCase();

  if (choice === 'YES') {
    await setState(session, 'awaiting_full_name', {});
    await sendMessage(session.wa_number, '📝 *Step 1 of 6*\n\nPlease enter your full name.\n\nExample: "Muhammad Ibrahim"');
    return;
  }

  await sendMessage(
    session.wa_number,
    `Reply *YES* to create your account, or *CANCEL* to stop.\n\n${WELCOME_NEW_CUSTOMER_TEXT}`
  );
}

async function handleAwaitingFullName(session, text) {
  const name = text.trim();

  if (name.length < 2 || name.length > 100) {
    await sendMessage(session.wa_number, '⚠️ Please enter your full name (e.g. "Muhammad Ibrahim").');
    return;
  }

  await setState(session, 'awaiting_email', { ...session.context, full_name: name });
  await sendMessage(session.wa_number, '📧 *Step 2 of 6*\n\nPlease enter your email address.\n\nExample: "customer@example.com"');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleAwaitingEmail(session, text) {
  const raw = text.trim();

  if (raw.toUpperCase() === 'BACK') {
    await setState(session, 'awaiting_full_name', session.context);
    await sendMessage(session.wa_number, '📝 *Step 1 of 6*\n\nPlease enter your full name.');
    return;
  }

  const email = raw.toLowerCase();

  if (!EMAIL_REGEX.test(email)) {
    await sendMessage(session.wa_number, "⚠️ That doesn't look like a valid email address.\n\nPlease enter a valid email address.");
    return;
  }

  const { data: existing, error } = await supabaseAdmin.from('users').select('id').eq('email', email).maybeSingle();
  if (error) throw new Error(`Email lookup failed: ${error.message}`);

  if (existing) {
    await sendMessage(
      session.wa_number,
      '⚠️ An account with this email already exists.\n\nPlease enter a different email address, or reply CANCEL.'
    );
    return;
  }

  await setState(session, 'awaiting_password', { ...session.context, email });
  await sendMessage(
    session.wa_number,
    '🔐 *Step 3 of 6*\n\nCreate a strong password for your Hadejia Data Hub account.\n\n(At least 6 characters.)'
  );
}

async function handleAwaitingPassword(session, text) {
  // NEVER log `text` in this function — it is the customer's plaintext
  // password. It is used exactly once, right here, to create the
  // Supabase Auth account, and is never written to whatsapp_sessions
  // or anywhere else.
  const password = text;

  if (typeof password !== 'string' || password.length < 6) {
    await sendMessage(session.wa_number, '⚠️ Password must be at least 6 characters. Please try again.');
    return;
  }

  const email = session.context.email;

  let authUser;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) {
      if (/already.*registered|already.*exists/i.test(error.message || '')) {
        await setState(session, 'awaiting_email', { ...session.context, email: undefined });
        await sendMessage(
          session.wa_number,
          '⚠️ An account with this email already exists.\n\nPlease enter a different email address.'
        );
        return;
      }
      throw error;
    }

    authUser = data.user;
  } catch (err) {
    console.error('[REGISTRATION] Failed to create auth account:', err.message);
    await sendMessage(session.wa_number, '⚠️ Sorry, we couldn\'t continue your registration right now. Please try again in a moment.');
    return;
  }

  await setState(session, 'awaiting_pin', { ...session.context, pending_user_id: authUser.id });
  await sendMessage(
    session.wa_number,
    '🔢 *Step 4 of 6*\n\nCreate your 4-digit transaction PIN.\n\nExample: "1234"'
  );
}

async function handleAwaitingPin(session, text) {
  // NEVER log `text` here either — it is the customer's plaintext PIN.
  const pin = text.trim();

  if (!/^\d{4}$/.test(pin)) {
    await sendMessage(session.wa_number, '⚠️ PIN must be exactly 4 digits. Please try again.');
    return;
  }

  // Hash immediately, using the exact same approach already used by
  // lib/auth.js#verifyPin and js/profile.js#savePin (SHA-256). Only
  // the hash — never the plaintext PIN — is stored in session context.
  const pinHash = crypto.createHash('sha256').update(pin).digest('hex');

  await setState(session, 'awaiting_referral', { ...session.context, pin_hash: pinHash });
  await sendMessage(
    session.wa_number,
    '🎁 *Step 5 of 6*\n\nEnter your referral code.\n\nIf you don\'t have one, reply "SKIP".'
  );
}

async function handleAwaitingReferral(session, text) {
  const input = text.trim();

  if (/^skip$/i.test(input)) {
    await setState(session, 'awaiting_confirmation', {
      ...session.context,
      referral_code: null,
      referring_user_id: null
    });
    await sendRegistrationSummary(session);
    return;
  }

  let referrer;
  try {
    referrer = await referral.findUserByReferralCode(input);
  } catch (err) {
    console.error('[REGISTRATION] Referral lookup failed:', err.message);
    await sendMessage(session.wa_number, '⚠️ Sorry, we couldn\'t check that referral code right now. Please try again or reply SKIP.');
    return;
  }

  if (!referrer) {
    await sendMessage(session.wa_number, '⚠️ Referral code not found.\n\nPlease enter a valid referral code or reply SKIP.');
    return;
  }

  await setState(session, 'awaiting_confirmation', {
    ...session.context,
    referral_code: input.trim().toUpperCase(),
    referring_user_id: referrer.id
  });
  await sendRegistrationSummary(session);
}

async function sendRegistrationSummary(session) {
  const { full_name, email, referral_code } = session.context;
  const localPhone = toLocalPhone(session.wa_number);

  const summary =
    '📋 *Step 6 of 6 — Confirm Your Details*\n\n' +
    `Name: ${full_name}\n` +
    `Email: ${email}\n` +
    `Phone: ${localPhone}\n` +
    `Referral: ${referral_code || 'None'}\n\n` +
    'Reply:\n\n' +
    '1️⃣ *CONFIRM*\n' +
    '2️⃣ *CANCEL*';

  await sendMessage(session.wa_number, summary);
}

async function handleAwaitingConfirmation(session, text) {
  const choice = text.trim().toUpperCase();

  if (choice === '2' || choice === 'CANCEL') {
    await cancelRegistration(session);
    return;
  }

  if (choice === '1' || choice === 'CONFIRM') {
    await finalizeRegistration(session);
    return;
  }

  await sendMessage(session.wa_number, 'Please reply *CONFIRM* to create your account, or *CANCEL* to stop.');
}

async function finalizeRegistration(session) {
  const { full_name, email, pin_hash, pending_user_id, referring_user_id } = session.context;
  const localPhone = toLocalPhone(session.wa_number);

  await sendMessage(session.wa_number, '⏳ Creating your Hadejia Data Hub account...');

  try {
    // Re-check the phone right before insert to guard against a race
    // (e.g. two concurrent registrations for the same number).
    const { data: existingPhone, error: phoneCheckErr } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('phone', localPhone)
      .maybeSingle();

    if (phoneCheckErr) throw new Error(`Phone check failed: ${phoneCheckErr.message}`);
    if (existingPhone) throw new Error('PHONE_ALREADY_REGISTERED');

    const referralCode = await referral.generateUniqueReferralCode();

    // NOTE: a database trigger on auth.users apparently already
    // creates a stub public.users row as soon as the Auth user is
    // created (confirmed via a users_pkey duplicate-key error hit by
    // the website registration flow, which uses this same pattern).
    // UPSERT on id overwrites that stub with our real registration
    // data instead of colliding with it.
    const { data: newUser, error: insertErr } = await supabaseAdmin
      .from('users')
      .upsert(
        {
          id: pending_user_id,
          full_name,
          email,
          phone: localPhone,
          role: 'user',
          status: 'active',
          wallet_balance: 0,
          referral_code: referralCode,
          referred_by: referring_user_id || null,
          pin_hash
        },
        { onConflict: 'id' }
      )
      .select()
      .single();

    if (insertErr) throw new Error(`Profile creation failed: ${insertErr.message}`);

    await linkUser(session, newUser.id);
    await setState(session, 'main_menu', {}); // clears pin_hash/pending_user_id from context

    await sendMessage(
      session.wa_number,
      `🎉 *Account Created Successfully!*\n\nWelcome to Hadejia Data Hub, ${full_name}! 👋\n\n` +
        'Your account is now ready.\n\n' +
        'You can now buy data, airtime and voice bundles, fund your wallet and manage your account directly through WhatsApp.'
    );
    await sendMessage(session.wa_number, MAIN_MENU_TEXT);
  } catch (err) {
    console.error('[REGISTRATION] Account finalization failed:', err.message);

    // The Auth user may already exist even though the profile insert
    // failed — clean it up so the customer isn't left with a
    // half-registered, unusable account, and can safely retry.
    await cleanupOrphanedAuthUser(pending_user_id);

    await setState(session, 'idle', {});
    await sendMessage(
      session.wa_number,
      '⚠️ Sorry, we couldn\'t complete your registration right now.\n\nPlease try again in a moment by sending "Hi".'
    );
  }
}

// ---------------------------------------------------------------------
// CHECK BALANCE
// ---------------------------------------------------------------------

async function checkBalance(session) {
  const balance = await wallet.getBalance(session.user_id);

  await goToMainMenu(
    session,
    `💰 Your wallet balance is *₦${balance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}*.`
  );
}

// ---------------------------------------------------------------------
// MY ACCOUNT
// ---------------------------------------------------------------------

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '—';
  const [local, domain] = email.split('@');
  const maskedLocal = local.length <= 1 ? `${local}***` : `${local[0]}***`;
  return `${maskedLocal}@${domain}`;
}

async function myAccount(session) {
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('full_name, phone, email, wallet_balance')
    .eq('id', session.user_id)
    .maybeSingle();

  if (error || !user) {
    await goToMainMenu(session, '⚠️ Unable to load your account details right now.');
    return;
  }

  const balance = Number(user.wallet_balance);

  const summary =
    '👤 *My Account*\n\n' +
    `Name: ${user.full_name || '—'}\n` +
    `Phone: ${user.phone || '—'}\n` +
    `Email: ${maskEmail(user.email)}\n` +
    `Balance: ₦${balance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

  await goToMainMenu(session, summary);
}

// ---------------------------------------------------------------------
// HELP
// ---------------------------------------------------------------------

async function helpMenu(session) {
  const waSupport = process.env.SUPPORT_WHATSAPP;
  const emailSupport = process.env.SUPPORT_EMAIL;

  const lines = ['🆘 *Hadejia Data Hub Support*', '', 'How can we help?', '', '1️⃣ Data Purchase', '2️⃣ Airtime', '3️⃣ Voice', '4️⃣ Wallet Funding', '5️⃣ Failed Transaction', '6️⃣ Account Problem', '7️⃣ Talk to Support', ''];

  if (waSupport) lines.push(`💬 WhatsApp: wa.me/${waSupport}`);
  if (emailSupport) lines.push(`✉️ Email: ${emailSupport}`);
  if (!waSupport && !emailSupport) lines.push('Support contact details have not been set up yet.');

  await goToMainMenu(session, lines.join('\n'));
}

// ---------------------------------------------------------------------
// TRANSACTION HISTORY
// ---------------------------------------------------------------------

async function showTransactionHistory(session) {
  const txns = await transactions.listUserTransactions(session.user_id, { limit: 5 });

  if (!txns || txns.length === 0) {
    await goToMainMenu(session, 'You have no transactions yet.');
    return;
  }

  const lines = txns.map((t) => {
    const date = new Date(t.created_at).toLocaleDateString('en-NG', { day: '2-digit', month: 'short' });
    const sub = [t.network, t.recipient].filter(Boolean).join(' · ');
    return `• ${date} — ${t.type} ${sub ? `(${sub}) ` : ''}— ₦${Number(t.amount).toLocaleString('en-NG')} [${t.status}]`;
  });

  await goToMainMenu(session, `🧾 Your last ${txns.length} transactions:\n\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------------
// BUY DATA (unchanged logic — reuses lib/orderService.js#executeOrder)
// ---------------------------------------------------------------------

async function startBuyData(session) {
  const { data: plans, error } = await supabaseAdmin.from('data_plans').select('*').eq('status', 'active');

  if (error || !plans || plans.length === 0) {
    await goToMainMenu(session, 'Sorry, no data plans are available right now.');
    return;
  }

  const networks = [...new Set(plans.map((p) => p.network))];
  const list = networks.map((n, i) => `${numLabel(i + 1)} ${n}`).join('\n');

  await setState(session, 'data_network', { networks });
  await sendMessage(session.wa_number, `📶 *Buy Data*\n\nChoose a network:\n\n${list}\n\nType *menu* to cancel.`);
}

async function handleDataNetwork(session, text) {
  const idx = parseInt(text.trim(), 10) - 1;
  const networks = session.context.networks || [];

  if (isNaN(idx) || !networks[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const network = networks[idx];
  return offerDataTypes(session, network);
}

async function offerDataTypes(session, network) {
  const { data: plans } = await supabaseAdmin.from('data_plans').select('*').eq('status', 'active').eq('network', network);
  const types = [...new Set((plans || []).map((p) => p.plan_type || 'Other'))];

  if (types.length <= 1) {
    return offerDataCategories(session, network, types[0] || 'Other');
  }

  const list = types.map((t, i) => `${numLabel(i + 1)} ${t}`).join('\n');
  await setState(session, 'data_type', { network, types });
  await sendMessage(session.wa_number, `Choose a data type for *${network}*:\n\n${list}\n\nType *menu* to cancel, or *BACK* to change network.`);
}

async function handleDataType(session, text) {
  if (text.trim().toUpperCase() === 'BACK') return startBuyData(session);

  const idx = parseInt(text.trim(), 10) - 1;
  const types = session.context.types || [];

  if (isNaN(idx) || !types[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  return offerDataCategories(session, session.context.network, types[idx]);
}

async function offerDataCategories(session, network, planType) {
  const { data: plans } = await supabaseAdmin
    .from('data_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network);
  const filteredPlans = (plans || []).filter((p) => (p.plan_type || 'Other') === planType);
  const categories = [...new Set(filteredPlans.map((p) => p.duration_category || 'Other'))];

  if (categories.length <= 1) {
    return offerDataPlans(session, network, planType, categories[0] || 'Other', filteredPlans);
  }

  const list = categories.map((c, i) => `${numLabel(i + 1)} ${c}`).join('\n');
  await setState(session, 'data_category', { network, planType, categories });
  await sendMessage(session.wa_number, `Choose a plan category for *${network} ${planType}*:\n\n${list}\n\nType *menu* to cancel, or *BACK* to go back.`);
}

async function handleDataCategory(session, text) {
  if (text.trim().toUpperCase() === 'BACK') return offerDataTypes(session, session.context.network);

  const idx = parseInt(text.trim(), 10) - 1;
  const categories = session.context.categories || [];

  if (isNaN(idx) || !categories[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const category = categories[idx];
  const { network, planType } = session.context;
  const { data: plans } = await supabaseAdmin
    .from('data_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network)
    .eq('duration_category', category);
  const filteredPlans = (plans || []).filter((p) => (p.plan_type || 'Other') === planType);

  return offerDataPlans(session, network, planType, category, filteredPlans);
}

async function offerDataPlans(session, network, planType, category, plans) {
  if (plans.length === 0) {
    await goToMainMenu(session, `No plans available for ${network} in that category right now.`);
    return;
  }

  const list = plans
    .map((p, i) => `${numLabel(i + 1)} ${p.plan_name} — ${p.data_size} · ${p.validity} — ₦${Number(p.selling_price).toLocaleString('en-NG')}`)
    .join('\n');

  const planSummaries = plans.map((p) => ({ id: p.id, label: `${p.plan_name} (₦${Number(p.selling_price).toLocaleString('en-NG')})` }));

  await setState(session, 'data_plan', { network, planType, category, plans: planSummaries });
  await sendMessage(session.wa_number, `Choose a plan:\n\n${list}\n\nType *menu* to cancel, or *BACK* to go back.`);
}

async function handleDataPlan(session, text) {
  if (text.trim().toUpperCase() === 'BACK') return handleDataNetworkBack(session);

  const idx = parseInt(text.trim(), 10) - 1;
  const plans = session.context.plans || [];

  if (isNaN(idx) || !plans[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const chosen = plans[idx];
  await setState(session, 'data_phone', { ...session.context, planId: chosen.id, planLabel: chosen.label });
  await sendMessage(session.wa_number, `Which phone number should receive *${chosen.label}*? (e.g. 08012345678)`);
}

// Re-derives the category screen when the customer goes BACK from the
// plan list — a pure re-query, safe to repeat.
async function handleDataNetworkBack(session) {
  return offerDataCategories(session, session.context.network, session.context.planType);
}

async function handleDataPhone(session, text) {
  if (text.trim().toUpperCase() === 'BACK') {
    // The plan list is already cached in context from offerDataPlans —
    // just re-show it rather than re-querying.
    const plans = session.context.plans || [];
    const list = plans.map((p, i) => `${numLabel(i + 1)} ${p.label}`).join('\n');
    await setState(session, 'data_plan', session.context);
    await sendMessage(session.wa_number, `Choose a plan:\n\n${list}\n\nType *menu* to cancel, or *BACK* to go back.`);
    return;
  }

  const phone = text.trim();
  if (!/^0[7-9][01]\d{8}$/.test(phone)) {
    await sendMessage(session.wa_number, "That doesn't look like a valid Nigerian phone number. Please try again.");
    return;
  }

  await setState(session, 'data_pin', { ...session.context, phone });
  await sendMessage(session.wa_number, `🔒 Enter your transaction PIN to confirm *${session.context.planLabel}* for ${phone}.`);
}

async function handleDataPin(session, text) {
  const pin = text.trim();
  const { planId, phone, planLabel } = session.context;

  await sendMessage(session.wa_number, '⏳ Processing your order...');

  try {
    const result = await orderService.executeOrder({ userId: session.user_id, type: 'data', pin, planId, phone });

    if (result.pending) {
      await goToMainMenu(session, `⏳ Your order for *${planLabel}* is being processed. It should arrive shortly.`);
    } else {
      await goToMainMenu(session, `✅ Success! *${planLabel}* has been sent to ${phone}.`);
    }
  } catch (err) {
    await goToMainMenu(session, `⚠️ ${err.message || 'Purchase failed.'}`);
  }
}

// ---------------------------------------------------------------------
// BUY VOICE (unchanged logic — reuses lib/orderService.js#executeOrder)
// ---------------------------------------------------------------------

async function startBuyVoice(session) {
  const { data: plans, error } = await supabaseAdmin.from('voice_plans').select('*').eq('status', 'active');

  if (error || !plans || plans.length === 0) {
    await goToMainMenu(session, 'Sorry, no voice bundles are available right now.');
    return;
  }

  const networks = [...new Set(plans.map((p) => p.network))];
  const list = networks.map((n, i) => `${numLabel(i + 1)} ${n}`).join('\n');

  await setState(session, 'voice_network', { networks });
  await sendMessage(session.wa_number, `☎️ *Buy Voice Bundle*\n\nChoose a network:\n\n${list}\n\nType *menu* to cancel.`);
}

async function handleVoiceNetwork(session, text) {
  const idx = parseInt(text.trim(), 10) - 1;
  const networks = session.context.networks || [];

  if (isNaN(idx) || !networks[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const network = networks[idx];
  const { data: plans } = await supabaseAdmin.from('voice_plans').select('*').eq('status', 'active').eq('network', network);
  const categories = [...new Set((plans || []).map((p) => p.duration_category || 'Other'))];

  if (categories.length <= 1) {
    return offerVoicePlans(session, network, categories[0] || 'Other', plans || []);
  }

  const list = categories.map((c, i) => `${numLabel(i + 1)} ${c}`).join('\n');
  await setState(session, 'voice_category', { network, categories });
  await sendMessage(session.wa_number, `Choose a plan category for *${network}*:\n\n${list}\n\nType *menu* to cancel, or *BACK* to change network.`);
}

async function handleVoiceCategory(session, text) {
  if (text.trim().toUpperCase() === 'BACK') return startBuyVoice(session);

  const idx = parseInt(text.trim(), 10) - 1;
  const categories = session.context.categories || [];

  if (isNaN(idx) || !categories[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const category = categories[idx];
  const network = session.context.network;
  const { data: plans } = await supabaseAdmin
    .from('voice_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network)
    .eq('duration_category', category);

  return offerVoicePlans(session, network, category, plans || []);
}

async function offerVoicePlans(session, network, category, plans) {
  if (plans.length === 0) {
    await goToMainMenu(session, `No voice bundles available for ${network} in that category right now.`);
    return;
  }

  const list = plans
    .map((p, i) => `${numLabel(i + 1)} ${p.plan_name} — ${p.minutes} mins · ${p.validity} — ₦${Number(p.selling_price).toLocaleString('en-NG')}`)
    .join('\n');

  const planSummaries = plans.map((p) => ({ id: p.id, label: `${p.plan_name} (₦${Number(p.selling_price).toLocaleString('en-NG')})` }));

  await setState(session, 'voice_plan', { network, category, plans: planSummaries });
  await sendMessage(session.wa_number, `Choose a plan:\n\n${list}\n\nType *menu* to cancel.`);
}

async function handleVoicePlan(session, text) {
  const idx = parseInt(text.trim(), 10) - 1;
  const plans = session.context.plans || [];

  if (isNaN(idx) || !plans[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const chosen = plans[idx];
  await setState(session, 'voice_phone', { ...session.context, planId: chosen.id, planLabel: chosen.label });
  await sendMessage(session.wa_number, `Which phone number should receive *${chosen.label}*? (e.g. 08012345678)`);
}

async function handleVoicePhone(session, text) {
  const phone = text.trim();
  if (!/^0[7-9][01]\d{8}$/.test(phone)) {
    await sendMessage(session.wa_number, "That doesn't look like a valid Nigerian phone number. Please try again.");
    return;
  }

  await setState(session, 'voice_pin', { ...session.context, phone });
  await sendMessage(session.wa_number, `🔒 Enter your transaction PIN to confirm *${session.context.planLabel}* for ${phone}.`);
}

async function handleVoicePin(session, text) {
  const pin = text.trim();
  const { planId, phone, planLabel } = session.context;

  await sendMessage(session.wa_number, '⏳ Processing your order...');

  try {
    const result = await orderService.executeOrder({ userId: session.user_id, type: 'voice', pin, planId, phone });

    if (result.pending) {
      await goToMainMenu(session, `⏳ Your order for *${planLabel}* is being processed. It should arrive shortly.`);
    } else {
      await goToMainMenu(session, `✅ Success! *${planLabel}* has been sent to ${phone}.`);
    }
  } catch (err) {
    await goToMainMenu(session, `⚠️ ${err.message || 'Purchase failed.'}`);
  }
}

// ---------------------------------------------------------------------
// BUY AIRTIME (unchanged logic — reuses lib/orderService.js#executeOrder)
// ---------------------------------------------------------------------

async function startBuyAirtime(session) {
  const { data: plans, error } = await supabaseAdmin.from('airtime_plans').select('*').eq('status', 'active');

  if (error || !plans || plans.length === 0) {
    await goToMainMenu(session, 'Sorry, airtime purchases are not available right now.');
    return;
  }

  const networks = plans.map((p) => ({ network: p.network, min: Number(p.min_amount), max: Number(p.max_amount) }));
  const list = networks.map((n, i) => `${numLabel(i + 1)} ${n.network}`).join('\n');

  await setState(session, 'airtime_network', { networks });
  await sendMessage(session.wa_number, `📱 *Buy Airtime*\n\nChoose a network:\n\n${list}\n\nType *menu* to cancel.`);
}

async function handleAirtimeNetwork(session, text) {
  const idx = parseInt(text.trim(), 10) - 1;
  const networks = session.context.networks || [];

  if (isNaN(idx) || !networks[idx]) {
    await sendMessage(session.wa_number, 'Please reply with a valid number from the list, or type *menu*.');
    return;
  }

  const chosen = networks[idx];
  await setState(session, 'airtime_amount', { network: chosen.network, min: chosen.min, max: chosen.max });
  await sendMessage(
    session.wa_number,
    `How much ${chosen.network} airtime? (Min ₦${chosen.min.toLocaleString('en-NG')} — Max ₦${chosen.max.toLocaleString('en-NG')})`
  );
}

async function handleAirtimeAmount(session, text) {
  if (text.trim().toUpperCase() === 'BACK') return startBuyAirtime(session);

  const amount = Number(text.trim());
  const { min, max } = session.context;

  if (!amount || amount < min || amount > max) {
    await sendMessage(session.wa_number, `Please enter a valid amount between ₦${min} and ₦${max}.`);
    return;
  }

  await setState(session, 'airtime_phone', { ...session.context, amount });
  await sendMessage(session.wa_number, 'Which phone number should receive the airtime? (e.g. 08012345678)');
}

async function handleAirtimePhone(session, text) {
  const phone = text.trim();
  if (!/^0[7-9][01]\d{8}$/.test(phone)) {
    await sendMessage(session.wa_number, "That doesn't look like a valid Nigerian phone number. Please try again.");
    return;
  }

  await setState(session, 'airtime_pin', { ...session.context, phone });
  await sendMessage(
    session.wa_number,
    `🔒 Enter your transaction PIN to confirm ₦${session.context.amount} ${session.context.network} airtime for ${phone}.`
  );
}

async function handleAirtimePin(session, text) {
  const pin = text.trim();
  const { network, amount, phone } = session.context;

  await sendMessage(session.wa_number, '⏳ Processing your order...');

  try {
    const result = await orderService.executeOrder({ userId: session.user_id, type: 'airtime', pin, network, amount, phone });

    if (result.pending) {
      await goToMainMenu(session, `⏳ Your ₦${amount} ${network} airtime order is being processed.`);
    } else {
      await goToMainMenu(session, `✅ Success! ₦${amount} ${network} airtime sent to ${phone}.`);
    }
  } catch (err) {
    await goToMainMenu(session, `⚠️ ${err.message || 'Purchase failed.'}`);
  }
}

// ---------------------------------------------------------------------
// FUND WALLET — Manual OPay transfer.
//
// SecureWave's dynamic account API is currently blocked pending BVN
// verification on the business account (see api/fund-wallet-init.js
// for the website's equivalent note). Per decision, SecureWave is
// hidden (not removed) here until that's resolved — this flow shows
// customers a static OPay account instead, then collects their
// receipt for admin approval via lib/manualFunding.js.
// ---------------------------------------------------------------------

async function getOpayAccountDetails() {
  const { data } = await supabaseAdmin.from('admin_settings').select('setting_value').eq('setting_key', 'opay_manual_account').maybeSingle();
  const v = (data && data.setting_value) || {};
  return {
    accountName: v.account_name || '(not set — ask admin to configure this in Settings)',
    accountNumber: v.account_number || '(not set)',
    bankName: v.bank_name || 'OPay'
  };
}

async function startFundWallet(session) {
  const { data: existingStatic } = await supabaseAdmin
    .from('dynamic_accounts')
    .select('account_number, bank_name, account_name')
    .eq('user_id', session.user_id)
    .eq('provider', 'securewaveng')
    .eq('account_type', 'static')
    .eq('is_active', true)
    .maybeSingle();

  if (existingStatic) {
    await setState(session, 'fund_method_choice_with_permanent', {});
    await sendMessage(
      session.wa_number,
      `💰 *Fund Wallet*\n\n` +
        `📌 Your Permanent Account Number:\n` +
        `🏦 ${existingStatic.bank_name}\n` +
        `🔢 ${existingStatic.account_number}\n` +
        `👤 ${existingStatic.account_name}\n` +
        `Transfer any amount here, anytime — it lands in your wallet automatically.\n\n` +
        `Or choose another way to fund:\n\n` +
        `1️⃣ Instant Bank Transfer (auto-credited)\n` +
        `2️⃣ Manual OPay Transfer (reviewed by admin)\n\n` +
        `Reply with a number, or just transfer to the account above.`
    );
    return;
  }

  await setState(session, 'fund_method_choice', {});
  await sendMessage(
    session.wa_number,
    `💰 *Fund Wallet*\n\n` +
      `How would you like to fund your wallet?\n\n` +
      `1️⃣ Instant Bank Transfer (auto-credited)\n` +
      `2️⃣ Manual OPay Transfer (reviewed by admin)\n` +
      `3️⃣ Permanent Account Number (one-time BVN setup)\n\n` +
      `Reply with a number.`
  );
}

async function promptManualOpay(session) {
  const account = await getOpayAccountDetails();
  await setState(session, 'awaiting_manual_amount', {});
  await sendMessage(
    session.wa_number,
    `💰 *Manual OPay Transfer*\n\n` +
      `Please transfer to:\n\n` +
      `🏦 ${account.bankName}\n` +
      `🔢 ${account.accountNumber}\n` +
      `👤 ${account.accountName}\n\n` +
      `Once you've sent the money, reply here with the amount you transferred (e.g. "500").`
  );
}

async function handleFundMethodChoiceWithPermanent(session, text) {
  const choice = text.trim();

  if (choice === '1') {
    return startFundWalletSecureWave(session);
  }
  if (choice === '2') {
    return promptManualOpay(session);
  }

  await sendMessage(session.wa_number, 'Please reply with 1 or 2, or just transfer to your permanent account number above.');
}

async function handleFundMethodChoice(session, text) {
  const choice = text.trim();

  if (choice === '1') {
    return startFundWalletSecureWave(session);
  }
  if (choice === '2') {
    return promptManualOpay(session);
  }
  if (choice === '3') {
    return startPermanentAccount(session);
  }

  await sendMessage(session.wa_number, 'Please reply with 1, 2, or 3.');
}

// ---------------------------------------------------------------------
// Permanent Account Number (Static Account) — mirrors
// api/static-account-init.js exactly, including its privacy handling:
// the BVN is used ONCE, in-memory, for this single SecureWaveNG call,
// and is never written to whatsapp_sessions.context, never logged,
// and never stored anywhere in our database.
// ---------------------------------------------------------------------

async function startPermanentAccount(session) {
  const { data: existing } = await supabaseAdmin
    .from('dynamic_accounts')
    .select('account_number, bank_name, account_name')
    .eq('user_id', session.user_id)
    .eq('provider', 'securewaveng')
    .eq('account_type', 'static')
    .eq('is_active', true)
    .maybeSingle();

  if (existing) {
    await goToMainMenu(
      session,
      `You already have a Permanent Account Number:\n\n` +
        `🏦 ${existing.bank_name}\n` +
        `🔢 ${existing.account_number}\n` +
        `👤 ${existing.account_name}\n\n` +
        `Transfer any amount here, anytime — it lands in your wallet automatically.`
    );
    return;
  }

  await setState(session, 'awaiting_bvn', {});
  await sendMessage(
    session.wa_number,
    `🔐 *Set Up Permanent Account*\n\n` +
      `We use your BVN to verify your identity with our banking partner and create your dedicated account number. ` +
      `Your BVN is sent securely and is never stored on our servers.\n\n` +
      `Please enter your 11-digit BVN.`
  );
}

async function handleAwaitingBvn(session, text) {
  // NEVER log `text` here — it is the customer's BVN.
  const bvn = text.trim();

  if (!/^\d{11}$/.test(bvn)) {
    await sendMessage(session.wa_number, '⚠️ BVN must be exactly 11 digits. Please try again.');
    return;
  }

  const { data: user } = await supabaseAdmin.from('users').select('email, phone, full_name').eq('id', session.user_id).maybeSingle();
  if (!user) {
    await goToMainMenu(session, 'Unable to find your account details.');
    return;
  }

  const fullName = (user.full_name || 'Customer User').trim();
  const [firstName, ...rest] = fullName.split(' ');
  const lastName = rest.join(' ') || 'User';

  await sendMessage(session.wa_number, '⏳ Verifying your BVN and creating your account...');

  try {
    const accounts = await securewave.generateStaticAccount({
      email: user.email,
      firstName: firstName || 'Customer',
      lastName,
      phone: user.phone || '08000000000',
      bvn
      // bvn used here only — never returned, logged, or stored below.
    });

    const account = accounts[0];

    const { error: insertErr } = await supabaseAdmin.from('dynamic_accounts').insert({
      user_id: session.user_id,
      provider: 'securewaveng',
      account_type: 'static',
      bank_name: account.bankName,
      account_number: account.accountNumber,
      account_name: account.accountName,
      provider_ref: account.reference,
      is_active: true
    });

    if (insertErr) throw new Error(`Failed to save static account: ${insertErr.message}`);

    await goToMainMenu(
      session,
      `🎉 *Permanent Account Created!*\n\n` +
        `🏦 ${account.bankName}\n` +
        `🔢 ${account.accountNumber}\n` +
        `👤 ${account.accountName}\n\n` +
        `Transfer any amount here, anytime — it lands in your wallet automatically.`
    );
  } catch (err) {
    console.error('[PermanentAccount] Failed to create static account:', err.message);
    await goToMainMenu(session, '⚠️ We could not verify that BVN right now. Please double-check it and try again from the Fund Wallet menu, or contact support.');
  }
}

async function startFundWalletSecureWave(session) {
  await setState(session, 'fund_amount', {});
  await sendMessage(session.wa_number, '💰 *Instant Bank Transfer*\n\nHow much would you like to fund? (Min ₦100)');
}

async function handleFundAmount(session, text) {
  const amount = Number(text.trim());

  if (!amount || amount < 100) {
    await sendMessage(session.wa_number, 'Please enter a valid amount of at least ₦100.');
    return;
  }

  const { data: user } = await supabaseAdmin.from('users').select('email, phone, full_name').eq('id', session.user_id).maybeSingle();

  if (!user) {
    await goToMainMenu(session, 'Unable to find your account details.');
    return;
  }

  const fullName = user.full_name || 'Customer User';
  const [firstName, ...rest] = fullName.split(' ');
  const lastName = rest.join(' ') || 'User';

  try {
    const account = await securewave.generateDynamicAccount({
      email: user.email,
      firstName: firstName || 'Customer',
      lastName,
      phone: user.phone || '08000000000',
      amount
    });

    await transactions.createPendingTransaction({
      userId: session.user_id,
      type: 'wallet_funding',
      amount: account.amountToPay,
      idempotencyKey: account.reference,
      requestPayload: {
        provider: 'securewaveng',
        account_reference: account.reference,
        account_number: account.accountNumber
      }
    });

    await supabaseAdmin.from('dynamic_accounts').insert({
      user_id: session.user_id,
      provider: 'securewaveng',
      account_type: 'dynamic',
      bank_name: account.bankName,
      account_number: account.accountNumber,
      account_name: account.accountName,
      provider_ref: account.reference,
      is_active: true
    });

    const minutes = Math.round((account.expiresInSeconds || 900) / 60);

    await goToMainMenu(
      session,
      `Transfer *₦${account.amountToPay.toLocaleString('en-NG')}* to:\n\n` +
        `🏦 ${account.bankName}\n` +
        `🔢 ${account.accountNumber}\n` +
        `👤 ${account.accountName}\n\n` +
        `This account expires in ${minutes} minutes. Your wallet will be credited automatically once payment is received.`
    );
  } catch (err) {
    await goToMainMenu(session, `⚠️ Could not generate a payment account. Please try Manual OPay Transfer instead, or contact support.`);
  }
}

async function handleAwaitingManualAmount(session, text) {
  const amount = Number(text.trim());

  if (!amount || amount < 1) {
    await sendMessage(session.wa_number, 'Please enter a valid amount (numbers only), e.g. "500".');
    return;
  }

  await setState(session, 'awaiting_manual_receipt', { amountClaimed: amount });
  await sendMessage(
    session.wa_number,
    '📸 Thanks! Now please send a photo of your transfer receipt.\n\n' +
      '(If you can\'t send a photo right now, just type a short note instead, e.g. the transaction reference.)'
  );
}

/**
 * Handles a TEXT message arriving while we're waiting for a receipt —
 * treated as a note rather than a dead end, since not everyone can
 * send a photo easily.
 */
async function handleAwaitingManualReceiptText(session, text) {
  const note = text.trim().slice(0, 500);
  if (!note) {
    await sendMessage(session.wa_number, 'Please send a photo of your receipt, or type a short note (e.g. the transaction reference).');
    return;
  }

  try {
    await manualFunding.createRequest({
      userId: session.user_id,
      source: 'whatsapp',
      amountClaimed: session.context.amountClaimed,
      receiptNote: note
    });
    await goToMainMenu(session, '✅ Got it! Your request has been sent for review — we\'ll credit your wallet once confirmed.');
  } catch (err) {
    console.error('[FundWallet] Failed to create manual funding request:', err.message);
    await goToMainMenu(session, '⚠️ Sorry, something went wrong recording your request. Please try again or contact support.');
  }
}

/**
 * Handles an IMAGE message arriving while we're waiting for a
 * receipt — downloads it from WhatsApp, re-uploads it to Supabase
 * Storage (WhatsApp's media URLs expire), and creates the request.
 */
async function handleAwaitingManualReceiptImage(session, mediaId) {
  try {
    const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
    const receiptPath = await uploadReceiptToStorage(session.user_id, buffer, mimeType);

    await manualFunding.createRequest({
      userId: session.user_id,
      source: 'whatsapp',
      amountClaimed: session.context.amountClaimed,
      receiptPath
    });

    await goToMainMenu(session, '✅ Receipt received! Your request has been sent for review — we\'ll credit your wallet once confirmed.');
  } catch (err) {
    console.error('[FundWallet] Failed to process receipt image:', err.message);
    await goToMainMenu(session, '⚠️ Sorry, we couldn\'t process that image. Please try again or contact support.');
  }
}

async function downloadWhatsAppMedia(mediaId) {
  const metaResponse = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    timeout: 15000
  });

  const { url, mime_type: mimeType } = metaResponse.data;
  if (!url) throw new Error('WhatsApp did not return a media URL');

  const fileResponse = await axios.get(url, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    responseType: 'arraybuffer',
    timeout: 20000
  });

  return { buffer: Buffer.from(fileResponse.data), mimeType: mimeType || 'image/jpeg' };
}

async function uploadReceiptToStorage(userId, buffer, mimeType) {
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const path = `${userId}/whatsapp-${Date.now()}.${ext}`;

  const { error } = await supabaseAdmin.storage.from('receipts').upload(path, buffer, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  return path;
}


// ---------------------------------------------------------------------
// MAIN MENU ROUTER
// ---------------------------------------------------------------------

async function handleMainMenu(session, text) {
  switch (text.trim()) {
    case '1':
      return startBuyData(session);
    case '2':
      return startBuyVoice(session);
    case '3':
      return startBuyAirtime(session);
    case '4':
      return startFundWallet(session);
    case '5':
      return checkBalance(session);
    case '6':
      return showTransactionHistory(session);
    case '7':
      return myAccount(session);
    case '8':
      return helpMenu(session);
    default:
      await sendMessage(session.wa_number, `Sorry, I didn't understand that.\n\n${MAIN_MENU_TEXT}`);
  }
}

// ---------------------------------------------------------------------
// STATE ROUTER
// ---------------------------------------------------------------------

const REGISTRATION_STATES = new Set([
  'awaiting_registration_confirmation',
  'awaiting_full_name',
  'awaiting_email',
  'awaiting_password',
  'awaiting_pin',
  'awaiting_referral',
  'awaiting_confirmation'
]);

const ORDER_STATES = new Set([
  'data_network', 'data_type', 'data_category', 'data_plan', 'data_phone', 'data_pin',
  'voice_network', 'voice_category', 'voice_plan', 'voice_phone', 'voice_pin',
  'airtime_network', 'airtime_amount', 'airtime_phone', 'airtime_pin',
  'fund_method_choice', 'fund_method_choice_with_permanent', 'fund_amount', 'awaiting_manual_amount', 'awaiting_manual_receipt', 'awaiting_bvn'
]);

const STATE_HANDLERS = {
  awaiting_registration_confirmation: handleAwaitingRegistrationConfirmation,
  awaiting_full_name: handleAwaitingFullName,
  awaiting_email: handleAwaitingEmail,
  awaiting_password: handleAwaitingPassword,
  awaiting_pin: handleAwaitingPin,
  awaiting_referral: handleAwaitingReferral,
  awaiting_confirmation: handleAwaitingConfirmation,

  main_menu: handleMainMenu,

  data_network: handleDataNetwork,
  data_type: handleDataType,
  data_category: handleDataCategory,
  data_plan: handleDataPlan,
  data_phone: handleDataPhone,
  data_pin: handleDataPin,

  voice_network: handleVoiceNetwork,
  voice_category: handleVoiceCategory,
  voice_plan: handleVoicePlan,
  voice_phone: handleVoicePhone,
  voice_pin: handleVoicePin,

  airtime_network: handleAirtimeNetwork,
  airtime_amount: handleAirtimeAmount,
  airtime_phone: handleAirtimePhone,
  airtime_pin: handleAirtimePin,

  awaiting_manual_amount: handleAwaitingManualAmount,
  awaiting_manual_receipt: handleAwaitingManualReceiptText,
  fund_method_choice: handleFundMethodChoice,
  fund_method_choice_with_permanent: handleFundMethodChoiceWithPermanent,
  fund_amount: handleFundAmount,
  awaiting_bvn: handleAwaitingBvn
};

// ---------------------------------------------------------------------
// INCOMING MESSAGE
// ---------------------------------------------------------------------

async function handleIncomingMessage(waNumberRaw, text) {
  const waNumber = toWhatsAppCanonical(waNumberRaw);
  const session = await getOrCreateSession(waNumber);
  const trimmed = (text || '').trim();

  if (!trimmed) {
    await sendMessage(session.wa_number, '⚠️ I currently process text messages for this step.\n\nPlease reply with the requested information.');
    return;
  }

  // ---- Global CANCEL -------------------------------------------------
  if (/^cancel$/i.test(trimmed)) {
    if (REGISTRATION_STATES.has(session.state)) {
      await cancelRegistration(session);
      return;
    }
    if (ORDER_STATES.has(session.state)) {
      if (session.user_id) {
        await setState(session, 'main_menu', {});
        await sendMessage(session.wa_number, `❌ Operation cancelled.\n\n${MAIN_MENU_TEXT}`);
      } else {
        await setState(session, 'idle', {});
        await sendMessage(session.wa_number, `❌ Operation cancelled.\n\n${IDLE_PROMPT}`);
      }
      return;
    }
    if (session.user_id) {
      await goToMainMenu(session, 'Nothing in progress to cancel.');
    } else {
      await sendMessage(session.wa_number, IDLE_PROMPT);
    }
    return;
  }

  // ---- Global greeting / home -----------------------------------------
  if (/^(menu|hi|hello|hey|start)$/i.test(trimmed)) {
    if (REGISTRATION_STATES.has(session.state) && session.context) {
      await cleanupOrphanedAuthUser(session.context.pending_user_id);
    }
    await identifyOrStartRegistration(session);
    return;
  }

  // ---- State-specific handling -----------------------------------------
  const handler = STATE_HANDLERS[session.state];

  if (!handler) {
    // Covers 'idle', legacy 'awaiting_verification', and any unknown
    // state — always safe to fall back to identification.
    await identifyOrStartRegistration(session);
    return;
  }

  await handler(session, trimmed);
}

// ---------------------------------------------------------------------
// HTTP WEBHOOK HANDLER
// ---------------------------------------------------------------------

async function webhookHandler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }

    console.error('[WEBHOOK] Verification FAILED');
    res.status(403).send('Verification failed');
    return;
  }

  if (req.method === 'POST') {
    try {
      const rawBodyBuffer = await readRawBody(req);
      const rawBody = rawBodyBuffer.toString('utf8');
      const signature = req.headers['x-hub-signature-256'];

      if (!isValidSignature(rawBodyBuffer, signature)) {
        console.error('[WEBHOOK] Signature verification FAILED');
        res.status(401).send('Invalid signature');
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch (error) {
        console.error('[WEBHOOK] JSON parse failed:', error.message);
        res.status(400).send('Invalid JSON');
        return;
      }

      const entry = payload.entry && payload.entry[0];
      const change = entry && entry.changes && entry.changes[0];
      const value = change && change.value;
      const messages = value && value.messages;
      const message = messages && messages[0];

      if (!message) {
        // Status/update event — not an incoming message.
        res.status(200).json({ received: true });
        return;
      }

      const waNumberRaw = message.from;
      const messageId = message.id;

      if (!waNumberRaw || !messageId) {
        res.status(200).json({ received: true });
        return;
      }

      const waNumber = toWhatsAppCanonical(waNumberRaw);

      // ---- Concurrency-safe duplicate protection --------------------
      // This MUST happen before any other processing, and covers every
      // action the bot can take — registration, purchases, funding,
      // everything — not just orders.
      const isFirstDelivery = await claimMessage(messageId, waNumber);
      if (!isFirstDelivery) {
        console.log('[WEBHOOK] Duplicate message id, skipping:', messageId);
        res.status(200).json({ received: true });
        return;
      }

      const preSession = await getOrCreateSession(waNumber);

      if (message.type === 'image' && preSession.state === 'awaiting_manual_receipt') {
        const mediaId = message.image && message.image.id;
        if (!mediaId) {
          await sendMessage(preSession.wa_number, '⚠️ We could not read that image. Please try sending it again.');
          res.status(200).json({ received: true });
          return;
        }
        await handleAwaitingManualReceiptImage(preSession, mediaId);
        res.status(200).json({ received: true });
        return;
      }

      if (message.type !== 'text') {
        await sendMessage(
          preSession.wa_number,
          '⚠️ I currently process text messages for this step.\n\nPlease reply with the requested information.'
        );
        res.status(200).json({ received: true });
        return;
      }

      const text = message.text && message.text.body;

      await handleIncomingMessage(waNumberRaw, text);

      res.status(200).json({ received: true });
      return;
    } catch (error) {
      console.error('[WEBHOOK] FATAL ERROR:', error.message);
      if (error.stack) console.error('[WEBHOOK] STACK:', error.stack);

      // Meta should still receive 200 for webhook delivery after we've
      // safely logged the error.
      if (!res.headersSent) {
        res.status(200).json({ received: true });
      }
      return;
    }
  }

  res.status(405).send('Method not allowed');
}

module.exports = webhookHandler;
