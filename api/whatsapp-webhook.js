'use strict';

/**
 * api/whatsapp-webhook.js
 * ---------------------------------------------------------------------
 * GET  /api/whatsapp-webhook  — Meta's one-time webhook verification handshake.
 * POST /api/whatsapp-webhook  — incoming WhatsApp messages.
 *
 * STAGE 1 of the WhatsApp bot: sets up the connection to Meta and
 * implements just the account-verification step (customer sends their
 * email or phone, we link their WhatsApp number to their
 * public.users row). The full ordering flow (Stage 3-5) builds on top
 * of this in later files — this file is intentionally the foundation,
 * not the finished bot.
 *
 * Required environment variables:
 *   WHATSAPP_VERIFY_TOKEN    — a string you choose (used only for the
 *                               GET handshake below)
 *   WHATSAPP_ACCESS_TOKEN    — from Meta for Developers
 *   WHATSAPP_PHONE_NUMBER_ID — from Meta for Developers
 * ---------------------------------------------------------------------
 */

const axios = require('axios');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { withErrorHandling } = require('../lib/response');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_API_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
  throw new Error(
    'Missing required env vars: WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, and/or WHATSAPP_PHONE_NUMBER_ID'
  );
}

/**
 * Send a plain text WhatsApp message via the Cloud API.
 */
async function sendMessage(toNumber, text) {
  try {
    await axios.post(
      GRAPH_API_URL,
      {
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'text',
        text: { body: text }
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, timeout: 10000 }
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[whatsapp] Failed to send message:', error.response ? error.response.data : error.message);
  }
}

/**
 * Get (or create) the session row for a WhatsApp number.
 */
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

async function updateSession(id, patch) {
  await supabaseAdmin.from('whatsapp_sessions').update(patch).eq('id', id);
}

/**
 * STAGE 1 conversation logic: verify identity, then a placeholder
 * main menu. Stage 3 replaces the placeholder with real service
 * selection wired to place-order.js's resolver logic.
 */
async function handleIncomingMessage(waNumber, text) {
  const session = await getOrCreateSession(waNumber);
  const trimmed = (text || '').trim();

  if (session.state === 'awaiting_verification') {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, status')
      .or(`email.eq.${trimmed},phone.eq.${trimmed}`)
      .maybeSingle();

    if (error || !user) {
      await sendMessage(
        waNumber,
        "We couldn't find an account with that email/phone. Please check and try again, or sign up first in the Hadejia Data Hub app."
      );
      return;
    }

    if (user.status !== 'active') {
      await sendMessage(waNumber, 'This account is not currently active. Please contact support.');
      return;
    }

    await updateSession(session.id, { user_id: user.id, state: 'main_menu' });
    await sendMessage(
      waNumber,
      `Welcome back, ${user.full_name || 'there'}! 👋\n\nYour account is now linked. Full ordering via WhatsApp is coming very soon — for now, please use the app for purchases: https://hadejia-data-hub.vercel.app`
    );
    return;
  }

  // Stage 1 placeholder for an already-verified session — Stage 3
  // replaces this with the real menu/order flow.
  await sendMessage(
    waNumber,
    "You're verified! Full ordering via WhatsApp is coming very soon. For now, please use the app: https://hadejia-data-hub.vercel.app"
  );
}

async function webhookHandler(req, res) {
  // ---- GET: Meta's one-time verification handshake ----
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Verification failed');
    return;
  }

  // ---- POST: incoming message events ----
  if (req.method === 'POST') {
    try {
      const entry = req.body && req.body.entry && req.body.entry[0];
      const change = entry && entry.changes && entry.changes[0];
      const value = change && change.value;
      const message = value && value.messages && value.messages[0];

      if (message && message.type === 'text') {
        const waNumber = message.from;
        const text = message.text.body;
        // Acknowledge Meta immediately; process the reply without
        // blocking the webhook response (Meta expects a fast 200).
        res.status(200).json({ received: true });
        await handleIncomingMessage(waNumber, text);
        return;
      }

      res.status(200).json({ received: true });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[whatsapp-webhook] Error handling message:', error);
      // Still 200 — Meta retries aggressively on non-2xx, which we
      // don't want for a processing error on our side.
      if (!res.headersSent) res.status(200).json({ received: true });
    }
    return;
  }

  res.status(405).send('Method not allowed');
}

// No requireAuth — Meta calls this directly, verified via the
// hub.verify_token handshake (GET) and app secret (recommended to add
// in Stage 2: X-Hub-Signature-256 verification on POST, same pattern
// as the AutosyncNG/SecureWaveNG webhooks).
module.exports = withErrorHandling(webhookHandler);
