'use strict';

/**
 * api/manual-funding.js
 *
 * GET  /api/manual-funding   (public — no auth required)
 *   Returns the OPay account details customers should transfer to.
 *   Public because it's not sensitive — it's meant to be displayed —
 *   and because we can't assume an unauthenticated/newly-logged-in
 *   browser client can read admin_settings directly under RLS.
 *
 * POST /api/manual-funding   (requires login)
 *   Website counterpart of the WhatsApp "send your receipt" flow. The
 *   browser uploads the receipt image directly to Supabase Storage
 *   (bucket 'receipts', path `${userId}/${filename}` — matches the
 *   RLS policy in 15_manual_funding.sql) using the customer's own
 *   session, THEN calls this with the resulting path. This endpoint
 *   never handles the raw image bytes itself.
 *   Body: { amount_claimed?, receipt_path?, receipt_note? }
 *   (at least one of receipt_path / receipt_note is required)
 */

const { requireAuth } = require('../lib/auth');
const { withErrorHandling, sendSuccess, sendCreated } = require('../lib/response');
const { validateAmount, ValidationError } = require('../lib/validation');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const manualFunding = require('../lib/manualFunding');

async function handleGet(req, res) {
  const { data } = await supabaseAdmin
    .from('admin_settings')
    .select('setting_value')
    .eq('setting_key', 'opay_manual_account')
    .maybeSingle();

  const v = (data && data.setting_value) || {};
  return sendSuccess(res, {
    accountName: v.account_name || null,
    accountNumber: v.account_number || null,
    bankName: v.bank_name || 'OPay'
  });
}

const handlePost = requireAuth(async function (req, res) {
  const body = req.body || {};

  if (!body.receipt_path && !body.receipt_note) {
    throw new ValidationError('Please attach a receipt image or a note describing your transfer', {
      details: [{ field: 'receipt_path', message: 'receipt_path or receipt_note is required' }]
    });
  }

  const amountClaimed =
    body.amount_claimed !== undefined && body.amount_claimed !== null && body.amount_claimed !== ''
      ? validateAmount(body.amount_claimed, 'amount_claimed', { min: 1, max: 10000000 })
      : undefined;

  // Defense in depth: even though the storage RLS policy already
  // scopes uploads to the caller's own user id folder, double-check
  // the path prefix here too before trusting it.
  if (body.receipt_path && !String(body.receipt_path).startsWith(`${req.user.id}/`)) {
    throw new ValidationError('Invalid receipt path', {
      details: [{ field: 'receipt_path', message: 'receipt_path must belong to the authenticated user' }]
    });
  }

  const request = await manualFunding.createRequest({
    userId: req.user.id,
    source: 'website',
    amountClaimed,
    receiptPath: body.receipt_path || undefined,
    receiptNote: body.receipt_note ? String(body.receipt_note).trim().slice(0, 500) : undefined
  });

  return sendCreated(
    res,
    { id: request.id, status: request.status },
    'Your receipt has been received. We will credit your wallet after review.'
  );
});

module.exports = withErrorHandling(async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({
    success: false,
    error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed on this endpoint. Allowed: GET, POST`, details: null },
    timestamp: new Date().toISOString()
  });
});
