'use strict';

/**
 * api/airtime-to-cash.js
 * ---------------------------------------------------------------------
 * POST /api/airtime-to-cash
 *
 * Handles all 3 steps of the Airtime-to-Cash flow in ONE file/function
 * (instead of 3 separate files) to stay within Vercel Hobby's 12
 * serverless-function limit. Which step runs is picked by body.step.
 *
 * Request body:
 *   { "step": "initiate", "pin": "1234", "productId": "mtn",
 *     "phone": "08012345678", "amount": 2000, "sharePin": "1234" }
 *
 *   { "step": "complete", "reference": "...", "otp": "123456" }
 *
 *   { "step": "resend-otp", "reference": "..." }
 * ---------------------------------------------------------------------
 */

const { requireAuth, verifyPin } = require('../lib/auth');
const { withErrorHandling, sendSuccess, sendError, methodNotAllowed } = require('../lib/response');
const { validateRequiredFields, validatePin, ValidationError } = require('../lib/validation');
const airtimeCashService = require('../lib/airtimeCashService');

async function initiate(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['pin', 'productId', 'phone', 'amount', 'sharePin']);

  const pin = validatePin(body.pin);
  await verifyPin(req.user.id, pin);

  const result = await airtimeCashService.initiateRequest({
    userId: req.user.id,
    productId: body.productId,
    phone: body.phone,
    amount: body.amount,
    sharePin: body.sharePin
  });

  return sendSuccess(res, result, { statusCode: 202, message: result.message });
}

async function complete(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['reference', 'otp']);

  const result = await airtimeCashService.completeRequest({
    userId: req.user.id,
    reference: body.reference,
    otp: body.otp
  });

  return sendSuccess(res, result, {
    message: result.alreadyProcessed ? 'Already completed' : 'Airtime converted to cash successfully'
  });
}

async function resend(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['reference']);

  const result = await airtimeCashService.resendOtp({
    userId: req.user.id,
    reference: body.reference
  });

  return sendSuccess(res, result, { message: result.message });
}

const STEP_HANDLERS = { initiate, complete, 'resend-otp': resend };

async function dispatch(req, res) {
  const step = req.body && req.body.step;
  const handler = STEP_HANDLERS[step];

  if (!handler) {
    return sendError(
      res,
      new ValidationError('step must be one of: initiate, complete, resend-otp', {
        details: [{ field: 'step', message: 'step must be one of: initiate, complete, resend-otp' }]
      })
    );
  }

  return handler(req, res);
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAuth(dispatch)(req, res);
});
