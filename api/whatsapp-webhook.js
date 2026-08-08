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

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;

const GRAPH_API_URL =
  `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID || !APP_SECRET) {
  throw new Error(
    'Missing required env vars: WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and/or WHATSAPP_APP_SECRET'
  );
}

/**
 * Vercel configuration.
 *
 * We need the raw request body for Meta's
 * X-Hub-Signature-256 verification.
 */
module.exports.config = {
  api: {
    bodyParser: false
  }
};

// ---------------------------------------------------------------------
// NUMBER LABELS
// ---------------------------------------------------------------------

const NUM_EMOJI = [
  '0️⃣',
  '1️⃣',
  '2️⃣',
  '3️⃣',
  '4️⃣',
  '5️⃣',
  '6️⃣',
  '7️⃣',
  '8️⃣',
  '9️⃣',
  '🔟'
];

function numLabel(n) {
  return n <= 10 ? NUM_EMOJI[n] : `${n}.`;
}

// ---------------------------------------------------------------------
// RAW BODY
// ---------------------------------------------------------------------

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

// ---------------------------------------------------------------------
// SIGNATURE VERIFICATION
// ---------------------------------------------------------------------

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

  const expected = crypto
    .createHmac('sha256', APP_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');

    if (a.length !== b.length) {
      return false;
    }

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
  console.log('[WHATSAPP] Sending message to:', toNumber);
  console.log('[WHATSAPP] Message:', text);

  try {
    const response = await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'text',
        text: {
          body: text
        }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log(
      '[WHATSAPP] Message sent successfully:',
      JSON.stringify(response.data)
    );

    return response.data;
  } catch (error) {
    console.error('[WHATSAPP] FAILED TO SEND MESSAGE');

    if (error.response) {
      console.error(
        '[WHATSAPP] Meta status:',
        error.response.status
      );

      console.error(
        '[WHATSAPP] Meta response:',
        JSON.stringify(error.response.data)
      );
    } else {
      console.error(
        '[WHATSAPP] Error:',
        error.message
      );
    }

    throw error;
  }
}

// ---------------------------------------------------------------------
// SESSION HELPERS
// ---------------------------------------------------------------------

async function getOrCreateSession(waNumber) {
  console.log('[SESSION] Looking up:', waNumber);

  const {
    data: existing,
    error: findErr
  } = await supabaseAdmin
    .from('whatsapp_sessions')
    .select('*')
    .eq('wa_number', waNumber)
    .maybeSingle();

  if (findErr) {
    throw new Error(
      `Session lookup failed: ${findErr.message}`
    );
  }

  if (existing) {
    console.log(
      '[SESSION] Existing session:',
      existing.state
    );

    return existing;
  }

  console.log('[SESSION] Creating new session');

  const {
    data: created,
    error: createErr
  } = await supabaseAdmin
    .from('whatsapp_sessions')
    .insert({
      wa_number: waNumber,
      state: 'awaiting_verification'
    })
    .select()
    .single();

  if (createErr) {
    throw new Error(
      `Session creation failed: ${createErr.message}`
    );
  }

  return created;
}

async function setState(session, state, context) {
  const patch = {
    state,
    last_message_at: new Date().toISOString()
  };

  if (context !== undefined) {
    patch.context = context;
  }

  const { error } = await supabaseAdmin
    .from('whatsapp_sessions')
    .update(patch)
    .eq('id', session.id);

  if (error) {
    throw new Error(
      `Session state update failed: ${error.message}`
    );
  }

  session.state = state;

  if (context !== undefined) {
    session.context = context;
  }
}

// ---------------------------------------------------------------------
// MAIN MENU
// ---------------------------------------------------------------------

const MAIN_MENU_TEXT =
  'What would you like to do?\n\n' +
  `${numLabel(1)} Buy Data\n` +
  `${numLabel(2)} Buy Voice Bundle\n` +
  `${numLabel(3)} Buy Airtime\n` +
  `${numLabel(4)} Check Balance\n` +
  `${numLabel(5)} Fund Wallet\n` +
  `${numLabel(6)} Transaction History\n` +
  `${numLabel(7)} Contact Support\n\n` +
  'Reply with a number. You can type *menu* anytime to come back here.';

async function goToMainMenu(session, greeting) {
  await setState(session, 'main_menu', {});

  const message =
    greeting
      ? `${greeting}\n\n${MAIN_MENU_TEXT}`
      : MAIN_MENU_TEXT;

  await sendMessage(
    session.wa_number,
    message
  );
}

// ---------------------------------------------------------------------
// VERIFICATION
// ---------------------------------------------------------------------

async function handleVerification(session, text) {
  const trimmed = text.trim();

  console.log(
    '[VERIFICATION] User entered:',
    trimmed
  );

  const {
    data: user,
    error
  } = await supabaseAdmin
    .from('users')
    .select('id, full_name, status')
    .or(`email.eq.${trimmed},phone.eq.${trimmed}`)
    .maybeSingle();

  if (error) {
    console.error(
      '[VERIFICATION] Database error:',
      error.message
    );
  }

  if (error || !user) {
    await sendMessage(
      session.wa_number,
      "We couldn't find an account with that email/phone. Please check and try again, or sign up first in the Hadejia Data Hub app."
    );

    return;
  }

  if (user.status !== 'active') {
    await sendMessage(
      session.wa_number,
      'This account is not currently active. Please contact support.'
    );

    return;
  }

  await supabaseAdmin
    .from('whatsapp_sessions')
    .update({
      user_id: user.id
    })
    .eq('id', session.id);

  session.user_id = user.id;

  await goToMainMenu(
    session,
    `Welcome back, ${user.full_name || 'there'}! 👋 Your account is now linked.`
  );
}

// ---------------------------------------------------------------------
// MAIN MENU ROUTER
// ---------------------------------------------------------------------

async function handleMainMenu(session, text) {
  const choice = text.trim();

  console.log(
    '[MENU] Choice:',
    choice
  );

  switch (choice) {
    case '1':
      return startBuyData(session);

    case '2':
      return startBuyVoice(session);

    case '3':
      return startBuyAirtime(session);

    case '4':
      return checkBalance(session);

    case '5':
      return startFundWallet(session);

    case '6':
      return showTransactionHistory(session);

    case '7':
      return contactSupport(session);

    default:
      await sendMessage(
        session.wa_number,
        `Sorry, I didn't understand that.\n\n${MAIN_MENU_TEXT}`
      );
  }
}

// ---------------------------------------------------------------------
// CHECK BALANCE
// ---------------------------------------------------------------------

async function checkBalance(session) {
  const {
    data: user
  } = await supabaseAdmin
    .from('users')
    .select('wallet_balance')
    .eq('id', session.user_id)
    .maybeSingle();

  const balance = user
    ? Number(user.wallet_balance)
    : 0;

  await goToMainMenu(
    session,
    `💰 Your wallet balance is *₦${balance.toLocaleString(
      'en-NG',
      {
        minimumFractionDigits: 2
      }
    )}*.`
  );
}

// ---------------------------------------------------------------------
// CONTACT SUPPORT
// ---------------------------------------------------------------------

async function contactSupport(session) {
  const waSupport = process.env.SUPPORT_WHATSAPP;
  const emailSupport = process.env.SUPPORT_EMAIL;

  const lines = [
    'Need help? Reach us here:'
  ];

  if (waSupport) {
    lines.push(`💬 WhatsApp: wa.me/${waSupport}`);
  }

  if (emailSupport) {
    lines.push(`✉️ Email: ${emailSupport}`);
  }

  if (!waSupport && !emailSupport) {
    lines.push(
      'Support contact details have not been set up yet.'
    );
  }

  await goToMainMenu(
    session,
    lines.join('\n')
  );
}

// ---------------------------------------------------------------------
// TRANSACTION HISTORY
// ---------------------------------------------------------------------

async function showTransactionHistory(session) {
  const {
    data: txns
  } = await supabaseAdmin
    .from('transactions')
    .select(
      'type, amount, status, network, recipient, created_at'
    )
    .eq('user_id', session.user_id)
    .order('created_at', {
      ascending: false
    })
    .limit(5);

  if (!txns || txns.length === 0) {
    await goToMainMenu(
      session,
      'You have no transactions yet.'
    );

    return;
  }

  const lines = txns.map((t) => {
    const date = new Date(
      t.created_at
    ).toLocaleDateString(
      'en-NG',
      {
        day: '2-digit',
        month: 'short'
      }
    );

    const sub = [
      t.network,
      t.recipient
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      `• ${date} — ${t.type} ` +
      `${sub ? `(${sub}) ` : ''}` +
      `— ₦${Number(t.amount).toLocaleString(
        'en-NG'
      )} [${t.status}]`
    );
  });

  await goToMainMenu(
    session,
    `🧾 Your last ${txns.length} transactions:\n\n${lines.join(
      '\n'
    )}`
  );
}

// ---------------------------------------------------------------------
// BUY DATA
// ---------------------------------------------------------------------

async function startBuyData(session) {
  const {
    data: plans,
    error
  } = await supabaseAdmin
    .from('data_plans')
    .select('*')
    .eq('status', 'active');

  if (
    error ||
    !plans ||
    plans.length === 0
  ) {
    await goToMainMenu(
      session,
      'Sorry, no data plans are available right now.'
    );

    return;
  }

  const networks = [
    ...new Set(
      plans.map((p) => p.network)
    )
  ];

  const list = networks
    .map(
      (n, i) =>
        `${numLabel(i + 1)} ${n}`
    )
    .join('\n');

  await setState(
    session,
    'data_network',
    {
      networks
    }
  );

  await sendMessage(
    session.wa_number,
    `📶 *Buy Data*\n\nChoose a network:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleDataNetwork(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const networks =
    session.context.networks || [];

  if (
    isNaN(idx) ||
    !networks[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const network = networks[idx];

  const {
    data: plans
  } = await supabaseAdmin
    .from('data_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network);

  const categories = [
    ...new Set(
      (plans || []).map(
        (p) =>
          p.duration_category ||
          'Other'
      )
    )
  ];

  if (categories.length <= 1) {
    return offerDataPlans(
      session,
      network,
      categories[0] || 'Other',
      plans || []
    );
  }

  const list = categories
    .map(
      (c, i) =>
        `${numLabel(i + 1)} ${c}`
    )
    .join('\n');

  await setState(
    session,
    'data_category',
    {
      network,
      categories
    }
  );

  await sendMessage(
    session.wa_number,
    `Choose a plan category for *${network}*:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleDataCategory(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const categories =
    session.context.categories || [];

  if (
    isNaN(idx) ||
    !categories[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const category =
    categories[idx];

  const network =
    session.context.network;

  const {
    data: plans
  } = await supabaseAdmin
    .from('data_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network)
    .eq(
      'duration_category',
      category
    );

  return offerDataPlans(
    session,
    network,
    category,
    plans || []
  );
}

async function offerDataPlans(
  session,
  network,
  category,
  plans
) {
  if (plans.length === 0) {
    await goToMainMenu(
      session,
      `No plans available for ${network} in that category right now.`
    );

    return;
  }

  const list = plans
    .map(
      (p, i) =>
        `${numLabel(i + 1)} ${p.plan_name} — ${p.data_size} · ${p.validity} — ₦${Number(
          p.selling_price
        ).toLocaleString('en-NG')}`
    )
    .join('\n');

  const planSummaries =
    plans.map((p) => ({
      id: p.id,
      label: `${p.plan_name} (₦${Number(
        p.selling_price
      ).toLocaleString('en-NG')})`
    }));

  await setState(
    session,
    'data_plan',
    {
      network,
      category,
      plans: planSummaries
    }
  );

  await sendMessage(
    session.wa_number,
    `Choose a plan:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleDataPlan(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const plans =
    session.context.plans || [];

  if (
    isNaN(idx) ||
    !plans[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const chosen = plans[idx];

  await setState(
    session,
    'data_phone',
    {
      ...session.context,
      planId: chosen.id,
      planLabel: chosen.label
    }
  );

  await sendMessage(
    session.wa_number,
    `Which phone number should receive *${chosen.label}*? (e.g. 08012345678)`
  );
}

async function handleDataPhone(session, text) {
  const phone = text.trim();

  if (!/^0[7-9][01]\d{8}$/.test(phone)) {
    await sendMessage(
      session.wa_number,
      "That doesn't look like a valid Nigerian phone number. Please try again."
    );

    return;
  }

  await setState(
    session,
    'data_pin',
    {
      ...session.context,
      phone
    }
  );

  await sendMessage(
    session.wa_number,
    `🔒 Enter your transaction PIN to confirm *${session.context.planLabel}* for ${phone}.`
  );
}

async function handleDataPin(session, text) {
  const pin = text.trim();

  const {
    planId,
    phone,
    planLabel
  } = session.context;

  await sendMessage(
    session.wa_number,
    '⏳ Processing your order...'
  );

  try {
    const result =
      await orderService.executeOrder({
        userId: session.user_id,
        type: 'data',
        pin,
        planId,
        phone
      });

    if (result.pending) {
      await goToMainMenu(
        session,
        `⏳ Your order for *${planLabel}* is being processed. It should arrive shortly.`
      );
    } else {
      await goToMainMenu(
        session,
        `✅ Success! *${planLabel}* has been sent to ${phone}.`
      );
    }
  } catch (err) {
    await goToMainMenu(
      session,
      `⚠️ ${err.message || 'Purchase failed.'}`
    );
  }
}

// ---------------------------------------------------------------------
// BUY VOICE
// ---------------------------------------------------------------------

async function startBuyVoice(session) {
  const {
    data: plans,
    error
  } = await supabaseAdmin
    .from('voice_plans')
    .select('*')
    .eq('status', 'active');

  if (
    error ||
    !plans ||
    plans.length === 0
  ) {
    await goToMainMenu(
      session,
      'Sorry, no voice bundles are available right now.'
    );

    return;
  }

  const networks = [
    ...new Set(
      plans.map((p) => p.network)
    )
  ];

  const list = networks
    .map(
      (n, i) =>
        `${numLabel(i + 1)} ${n}`
    )
    .join('\n');

  await setState(
    session,
    'voice_network',
    {
      networks
    }
  );

  await sendMessage(
    session.wa_number,
    `☎️ *Buy Voice Bundle*\n\nChoose a network:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleVoiceNetwork(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const networks =
    session.context.networks || [];

  if (
    isNaN(idx) ||
    !networks[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const network =
    networks[idx];

  const {
    data: plans
  } = await supabaseAdmin
    .from('voice_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network);

  const categories = [
    ...new Set(
      (plans || []).map(
        (p) =>
          p.duration_category ||
          'Other'
      )
    )
  ];

  if (categories.length <= 1) {
    return offerVoicePlans(
      session,
      network,
      categories[0] || 'Other',
      plans || []
    );
  }

  const list = categories
    .map(
      (c, i) =>
        `${numLabel(i + 1)} ${c}`
    )
    .join('\n');

  await setState(
    session,
    'voice_category',
    {
      network,
      categories
    }
  );

  await sendMessage(
    session.wa_number,
    `Choose a plan category for *${network}*:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleVoiceCategory(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const categories =
    session.context.categories || [];

  if (
    isNaN(idx) ||
    !categories[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const category =
    categories[idx];

  const network =
    session.context.network;

  const {
    data: plans
  } = await supabaseAdmin
    .from('voice_plans')
    .select('*')
    .eq('status', 'active')
    .eq('network', network)
    .eq(
      'duration_category',
      category
    );

  return offerVoicePlans(
    session,
    network,
    category,
    plans || []
  );
}

async function offerVoicePlans(
  session,
  network,
  category,
  plans
) {
  if (plans.length === 0) {
    await goToMainMenu(
      session,
      `No voice bundles available for ${network} in that category right now.`
    );

    return;
  }

  const list = plans
    .map(
      (p, i) =>
        `${numLabel(i + 1)} ${p.plan_name} — ${p.minutes} mins · ${p.validity} — ₦${Number(
          p.selling_price
        ).toLocaleString('en-NG')}`
    )
    .join('\n');

  const planSummaries =
    plans.map((p) => ({
      id: p.id,
      label: `${p.plan_name} (₦${Number(
        p.selling_price
      ).toLocaleString('en-NG')})`
    }));

  await setState(
    session,
    'voice_plan',
    {
      network,
      category,
      plans: planSummaries
    }
  );

  await sendMessage(
    session.wa_number,
    `Choose a plan:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleVoicePlan(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const plans =
    session.context.plans || [];

  if (
    isNaN(idx) ||
    !plans[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const chosen = plans[idx];

  await setState(
    session,
    'voice_phone',
    {
      ...session.context,
      planId: chosen.id,
      planLabel: chosen.label
    }
  );

  await sendMessage(
    session.wa_number,
    `Which phone number should receive *${chosen.label}*? (e.g. 08012345678)`
  );
}

async function handleVoicePhone(session, text) {
  const phone = text.trim();

  if (!/^0[7-9][01]\d{8}$/.test(phone)) {
    await sendMessage(
      session.wa_number,
      "That doesn't look like a valid Nigerian phone number. Please try again."
    );

    return;
  }

  await setState(
    session,
    'voice_pin',
    {
      ...session.context,
      phone
    }
  );

  await sendMessage(
    session.wa_number,
    `🔒 Enter your transaction PIN to confirm *${session.context.planLabel}* for ${phone}.`
  );
}

async function handleVoicePin(session, text) {
  const pin = text.trim();

  const {
    planId,
    phone,
    planLabel
  } = session.context;

  await sendMessage(
    session.wa_number,
    '⏳ Processing your order...'
  );

  try {
    const result =
      await orderService.executeOrder({
        userId: session.user_id,
        type: 'voice',
        pin,
        planId,
        phone
      });

    if (result.pending) {
      await goToMainMenu(
        session,
        `⏳ Your order for *${planLabel}* is being processed. It should arrive shortly.`
      );
    } else {
      await goToMainMenu(
        session,
        `✅ Success! *${planLabel}* has been sent to ${phone}.`
      );
    }
  } catch (err) {
    await goToMainMenu(
      session,
      `⚠️ ${err.message || 'Purchase failed.'}`
    );
  }
}

// ---------------------------------------------------------------------
// BUY AIRTIME
// ---------------------------------------------------------------------

async function startBuyAirtime(session) {
  const {
    data: plans,
    error
  } = await supabaseAdmin
    .from('airtime_plans')
    .select('*')
    .eq('status', 'active');

  if (
    error ||
    !plans ||
    plans.length === 0
  ) {
    await goToMainMenu(
      session,
      'Sorry, airtime purchases are not available right now.'
    );

    return;
  }

  const networks =
    plans.map((p) => ({
      network: p.network,
      min: Number(p.min_amount),
      max: Number(p.max_amount)
    }));

  const list = networks
    .map(
      (n, i) =>
        `${numLabel(i + 1)} ${n.network}`
    )
    .join('\n');

  await setState(
    session,
    'airtime_network',
    {
      networks
    }
  );

  await sendMessage(
    session.wa_number,
    `📱 *Buy Airtime*\n\nChoose a network:\n\n${list}\n\nType *menu* to cancel.`
  );
}

async function handleAirtimeNetwork(session, text) {
  const idx =
    parseInt(text.trim(), 10) - 1;

  const networks =
    session.context.networks || [];

  if (
    isNaN(idx) ||
    !networks[idx]
  ) {
    await sendMessage(
      session.wa_number,
      'Please reply with a valid number from the list, or type *menu*.'
    );

    return;
  }

  const chosen =
    networks[idx];

  await setState(
    session,
    'airtime_amount',
    {
      network: chosen.network,
      min: chosen.min,
      max: chosen.max
    }
  );

  await sendMessage(
    session.wa_number,
    `How much ${chosen.network} airtime? (Min ₦${chosen.min.toLocaleString(
      'en-NG'
    )} — Max ₦${chosen.max.toLocaleString(
      'en-NG'
    )})`
  );
}

async function handleAirtimeAmount(session, text) {
  const amount =
    Number(text.trim());

  const {
    min,
    max
  } = session.context;

  if (
    !amount ||
    amount < min ||
    amount > max
  ) {
    await sendMessage(
      session.wa_number,
      `Please enter a valid amount between ₦${min} and ₦${max}.`
    );

    return;
  }

  await setState(
    session,
    'airtime_phone',
    {
      ...session.context,
      amount
    }
  );

  await sendMessage(
    session.wa_number,
    'Which phone number should receive the airtime? (e.g. 08012345678)'
  );
}

async function handleAirtimePhone(session, text) {
  const phone = text.trim();

  if (!/^0[7-9][01]\d{8}$/.test(phone)) {
    await sendMessage(
      session.wa_number,
      "That doesn't look like a valid Nigerian phone number. Please try again."
    );

    return;
  }

  await setState(
    session,
    'airtime_pin',
    {
      ...session.context,
      phone
    }
  );

  await sendMessage(
    session.wa_number,
    `🔒 Enter your transaction PIN to confirm ₦${session.context.amount} ${session.context.network} airtime for ${phone}.`
  );
}

async function handleAirtimePin(session, text) {
  const pin = text.trim();

  const {
    network,
    amount,
    phone
  } = session.context;

  await sendMessage(
    session.wa_number,
    '⏳ Processing your order...'
  );

  try {
    const result =
      await orderService.executeOrder({
        userId: session.user_id,
        type: 'airtime',
        pin,
        network,
        amount,
        phone
      });

    if (result.pending) {
      await goToMainMenu(
        session,
        `⏳ Your ₦${amount} ${network} airtime order is being processed.`
      );
    } else {
      await goToMainMenu(
        session,
        `✅ Success! ₦${amount} ${network} airtime sent to ${phone}.`
      );
    }
  } catch (err) {
    await goToMainMenu(
      session,
      `⚠️ ${err.message || 'Purchase failed.'}`
    );
  }
}

// ---------------------------------------------------------------------
// FUND WALLET
// ---------------------------------------------------------------------

async function startFundWallet(session) {
  await setState(
    session,
    'fund_amount',
    {}
  );

  await sendMessage(
    session.wa_number,
    '💰 *Fund Wallet*\n\nHow much would you like to fund? (Min ₦100)'
  );
}

async function handleFundAmount(session, text) {
  const amount =
    Number(text.trim());

  if (
    !amount ||
    amount < 100
  ) {
    await sendMessage(
      session.wa_number,
      'Please enter a valid amount of at least ₦100.'
    );

    return;
  }

  const {
    data: user
  } = await supabaseAdmin
    .from('users')
    .select(
      'email, phone, full_name'
    )
    .eq(
      'id',
      session.user_id
    )
    .maybeSingle();

  if (!user) {
    await goToMainMenu(
      session,
      'Unable to find your account details.'
    );

    return;
  }

  const fullName =
    user.full_name ||
    'Customer User';

  const [
    firstName,
    ...rest
  ] = fullName.split(' ');

  const lastName =
    rest.join(' ') || 'User';

  try {
    const account =
      await securewave.generateDynamicAccount({
        email: user.email,
        firstName:
          firstName || 'Customer',
        lastName,
        phone:
          user.phone ||
          '08000000000',
        amount
      });

    await transactions.createPendingTransaction({
      userId: session.user_id,
      type: 'wallet_funding',
      amount: account.amountToPay,
      idempotencyKey:
        account.reference,
      requestPayload: {
        provider:
          'securewaveng',
        account_reference:
          account.reference,
        account_number:
          account.accountNumber
      }
    });

    await supabaseAdmin
      .from('dynamic_accounts')
      .insert({
        user_id:
          session.user_id,
        provider:
          'securewaveng',
        account_type:
          'dynamic',
        bank_name:
          account.bankName,
        account_number:
          account.accountNumber,
        account_name:
          account.accountName,
        provider_ref:
          account.reference,
        is_active: true
      });

    const minutes =
      Math.round(
        (account.expiresInSeconds ||
          900) / 60
      );

    await goToMainMenu(
      session,
      `Transfer *₦${account.amountToPay.toLocaleString(
        'en-NG'
      )}* to:\n\n` +
        `🏦 ${account.bankName}\n` +
        `🔢 ${account.accountNumber}\n` +
        `👤 ${account.accountName}\n\n` +
        `This account expires in ${minutes} minutes. Your wallet will be credited automatically once payment is received.`
    );
  } catch (err) {
    await goToMainMenu(
      session,
      `⚠️ Could not generate a payment account: ${
        err.message
      }`
    );
  }
}

// ---------------------------------------------------------------------
// STATE ROUTER
// ---------------------------------------------------------------------

const STATE_HANDLERS = {
  main_menu:
    handleMainMenu,

  data_network:
    handleDataNetwork,

  data_category:
    handleDataCategory,

  data_plan:
    handleDataPlan,

  data_phone:
    handleDataPhone,

  data_pin:
    handleDataPin,

  voice_network:
    handleVoiceNetwork,

  voice_category:
    handleVoiceCategory,

  voice_plan:
    handleVoicePlan,

  voice_phone:
    handleVoicePhone,

  voice_pin:
    handleVoicePin,

  airtime_network:
    handleAirtimeNetwork,

  airtime_amount:
    handleAirtimeAmount,

  airtime_phone:
    handleAirtimePhone,

  airtime_pin:
    handleAirtimePin,

  fund_amount:
    handleFundAmount
};

// ---------------------------------------------------------------------
// INCOMING MESSAGE
// ---------------------------------------------------------------------

async function handleIncomingMessage(
  waNumber,
  text
) {
  console.log(
    '[MESSAGE] From:',
    waNumber
  );

  console.log(
    '[MESSAGE] Text:',
    text
  );

  const session =
    await getOrCreateSession(
      waNumber
    );

  const trimmed =
    (text || '').trim();

  if (
    session.state ===
    'awaiting_verification'
  ) {
    return handleVerification(
      session,
      trimmed
    );
  }

  // Global escape hatch.
  if (
    /^(menu|cancel|hi|hello|start)$/i.test(
      trimmed
    )
  ) {
    return goToMainMenu(
      session
    );
  }

  const handler =
    STATE_HANDLERS[
      session.state
    ];

  if (!handler) {
    console.log(
      '[MESSAGE] Unknown state:',
      session.state
    );

    return goToMainMenu(
      session
    );
  }

  return handler(
    session,
    trimmed
  );
}

// ---------------------------------------------------------------------
// HTTP WEBHOOK HANDLER
// ---------------------------------------------------------------------

async function webhookHandler(
  req,
  res
) {
  console.log(
    '[WEBHOOK] ==========================='
  );

  console.log(
    '[WEBHOOK] Method:',
    req.method
  );

  console.log(
    '[WEBHOOK] Query:',
    req.query
  );

  // ---------------------------------------------------------------
  // GET — META VERIFICATION
  // ---------------------------------------------------------------

  if (req.method === 'GET') {
    const mode =
      req.query['hub.mode'];

    const token =
      req.query[
        'hub.verify_token'
      ];

    const challenge =
      req.query[
        'hub.challenge'
      ];

    console.log(
      '[WEBHOOK] Verification request'
    );

    if (
      mode === 'subscribe' &&
      token === VERIFY_TOKEN
    ) {
      console.log(
        '[WEBHOOK] Verification SUCCESS'
      );

      res
        .status(200)
        .send(challenge);

      return;
    }

    console.error(
      '[WEBHOOK] Verification FAILED'
    );

    res
      .status(403)
      .send(
        'Verification failed'
      );

    return;
  }

  // ---------------------------------------------------------------
  // POST — META WEBHOOK
  // ---------------------------------------------------------------

  if (req.method === 'POST') {
    console.log(
      '[WEBHOOK] POST RECEIVED'
    );

    try {
      // -----------------------------------------------------------
      // Read RAW body.
      // Required for signature verification.
      // -----------------------------------------------------------

      const rawBodyBuffer =
        await readRawBody(req);

      const rawBody =
        rawBodyBuffer.toString(
          'utf8'
        );

      console.log(
        '[WEBHOOK] Raw body length:',
        rawBodyBuffer.length
      );

      const signature =
        req.headers[
          'x-hub-signature-256'
        ];

      console.log(
        '[WEBHOOK] Signature present:',
        !!signature
      );

      // -----------------------------------------------------------
      // Verify Meta signature.
      // -----------------------------------------------------------

      if (
        !isValidSignature(
          rawBodyBuffer,
          signature
        )
      ) {
        console.error(
          '[WEBHOOK] Signature verification FAILED'
        );

        res
          .status(401)
          .send(
            'Invalid signature'
          );

        return;
      }

      console.log(
        '[WEBHOOK] Signature verification SUCCESS'
      );

      // -----------------------------------------------------------
      // Parse JSON.
      // -----------------------------------------------------------

      let payload;

      try {
        payload =
          JSON.parse(rawBody);
      } catch (error) {
        console.error(
          '[WEBHOOK] JSON parse failed:',
          error
        );

        res
          .status(400)
          .send(
            'Invalid JSON'
          );

        return;
      }

      console.log(
        '[WEBHOOK] Payload received:',
        JSON.stringify(
          payload
        )
      );

      // -----------------------------------------------------------
      // Extract Meta event.
      // -----------------------------------------------------------

      const entry =
        payload.entry &&
        payload.entry[0];

      const change =
        entry &&
        entry.changes &&
        entry.changes[0];

      const value =
        change &&
        change.value;

      const messages =
        value &&
        value.messages;

      const message =
        messages &&
        messages[0];

      // -----------------------------------------------------------
      // IMPORTANT:
      // Meta can send statuses, account updates, etc.
      // Those are NOT incoming messages.
      // -----------------------------------------------------------

      if (
        !message
      ) {
        console.log(
          '[WEBHOOK] No incoming message in this event.'
        );

        console.log(
          '[WEBHOOK] Event may be a status/update event.'
        );

        res
          .status(200)
          .json({
            received: true
          });

        return;
      }

      console.log(
        '[WEBHOOK] Message type:',
        message.type
      );

      // -----------------------------------------------------------
      // We currently process text messages.
      // -----------------------------------------------------------

      if (
        message.type !== 'text'
      ) {
        console.log(
          '[WEBHOOK] Unsupported message type:',
          message.type
        );

        res
          .status(200)
          .json({
            received: true
          });

        return;
      }

      const waNumber =
        message.from;

      const text =
        message.text &&
        message.text.body;

      console.log(
        '[WEBHOOK] Incoming WhatsApp number:',
        waNumber
      );

      console.log(
        '[WEBHOOK] Incoming text:',
        text
      );

      if (
        !waNumber ||
        !text
      ) {
        console.log(
          '[WEBHOOK] Missing sender number or message text.'
        );

        res
          .status(200)
          .json({
            received: true
          });

        return;
      }

      // -----------------------------------------------------------
      // IMPORTANT CHANGE:
      //
      // Process the incoming message BEFORE returning 200.
      // This ensures Vercel does not finish the function before
      // sendMessage() / Supabase calls have completed.
      // -----------------------------------------------------------

      console.log(
        '[WEBHOOK] Starting message handler...'
      );

      await handleIncomingMessage(
        waNumber,
        text
      );

      console.log(
        '[WEBHOOK] Message handler completed.'
      );

      // -----------------------------------------------------------
      // Now tell Meta we successfully handled it.
      // -----------------------------------------------------------

      res
        .status(200)
        .json({
          received: true
        });

      console.log(
        '[WEBHOOK] Response 200 sent.'
      );

      return;

    } catch (error) {
      console.error(
        '[WEBHOOK] FATAL ERROR:',
        error
      );

      if (
        error &&
        error.stack
      ) {
        console.error(
          '[WEBHOOK] STACK:',
          error.stack
        );
      }

      // Meta should still receive 200 for webhook delivery
      // after we've safely logged the error.
      if (
        !res.headersSent
      ) {
        res
          .status(200)
          .json({
            received: true
          });
      }

      return;
    }
  }

  // ---------------------------------------------------------------
  // OTHER HTTP METHODS
  // ---------------------------------------------------------------

  res
    .status(405)
    .send(
      'Method not allowed'
    );
}

// ---------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------

module.exports =
  webhookHandler;
