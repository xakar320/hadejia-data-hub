'use strict';

/**
 * lib/manualFunding.js
 * ---------------------------------------------------------------------
 * Core logic for "manual OPay funding": the customer transfers to a
 * static OPay account shown to them, then submits a receipt (image or
 * note). This creates a 'pending' row for an admin to review — no
 * money moves automatically. Approval (which actually credits the
 * wallet, via lib/wallet.js#creditWallet) happens only in
 * api/admin.js, using the service-role client, exactly once per
 * request (enforced both by a status check AND a wallet reference
 * derived from the request id, so even a double-click can't
 * double-credit).
 *
 * Used by:
 *   - api/manual-funding.js   (website: customer uploads a receipt
 *                               image to Supabase Storage first, then
 *                               calls this with the resulting path)
 *   - api/whatsapp-webhook.js (WhatsApp: downloads the customer's
 *                               receipt image from Meta's servers,
 *                               re-uploads it to the same Storage
 *                               bucket, then calls this)
 * ---------------------------------------------------------------------
 */

const axios = require('axios');
const { supabaseAdmin } = require('./supabaseAdmin');

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ADMIN_WHATSAPP_NUMBER = process.env.ADMIN_WHATSAPP_NUMBER;

/**
 * Create a pending manual funding request.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {'website'|'whatsapp'} params.source
 * @param {number} [params.amountClaimed]
 * @param {string} [params.receiptPath]  - path within the 'receipts' storage bucket
 * @param {string} [params.receiptNote]  - free-text note, if no image was provided
 */
async function createRequest({ userId, source, amountClaimed, receiptPath, receiptNote }) {
  if (!userId) throw new Error('userId is required');
  if (source !== 'website' && source !== 'whatsapp') throw new Error('source must be "website" or "whatsapp"');
  if (!receiptPath && !receiptNote) throw new Error('Either receiptPath or receiptNote is required');

  const { data, error } = await supabaseAdmin
    .from('manual_funding_requests')
    .insert({
      user_id: userId,
      source,
      amount_claimed: amountClaimed || null,
      receipt_path: receiptPath || null,
      receipt_note: receiptNote || null,
      status: 'pending'
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create manual funding request: ${error.message}`);

  // Best-effort notification — a failure here must never block the
  // customer's request from being recorded. The request is already
  // safely in the 'pending' queue regardless of whether this succeeds.
  try {
    await notifyAdmin(data);
  } catch (err) {
    console.error('[manualFunding] Failed to notify admin:', err.message);
  }

  return data;
}

async function notifyAdmin(request) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID || !ADMIN_WHATSAPP_NUMBER) {
    console.error('[manualFunding] Admin WhatsApp notification skipped — missing WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, or ADMIN_WHATSAPP_NUMBER env var.');
    return;
  }

  const { data: user } = await supabaseAdmin.from('users').select('full_name, phone').eq('id', request.user_id).maybeSingle();

  const amountLine = request.amount_claimed
    ? `Claimed amount: ₦${Number(request.amount_claimed).toLocaleString('en-NG')}`
    : 'No amount stated';

  const text =
    `🔔 New manual funding request\n\n` +
    `From: ${(user && user.full_name) || 'Unknown'} (${(user && user.phone) || '—'})\n` +
    `Source: ${request.source}\n` +
    `${amountLine}\n` +
    `${request.receipt_note ? `Note: ${request.receipt_note}\n` : ''}` +
    `\nReview and approve in the admin panel → Wallet tab.`;

  await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to: ADMIN_WHATSAPP_NUMBER, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
}

module.exports = { createRequest };
