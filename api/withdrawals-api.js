'use strict';

/**
 * api/withdrawals.js
 * ---------------------------------------------------------------------
 * POST /api/withdrawals
 *
 * Handles every Customer Withdrawal action in ONE file/function
 * (banks list, account validation, saving bank info, reading it back,
 * and the withdrawal itself) — like api/airtime-to-cash.js, this
 * keeps us within Vercel Hobby's 12 serverless-function limit instead
 * of spending 5 separate files on one feature.
 *
 * Request body: { "action": "...", ...action-specific fields }
 *
 *   { "action": "banks" }
 *     -> { data: [{ id, name, bankCode }, ...] }
 *
 *   { "action": "validate-account", "bankCode": "...", "accountNumber": "..." }
 *     -> { data: { accountName, accountNumber } }
 *
 *   { "action": "save-bank-info", "bankName": "...", "accountName": "...",
 *     "bankCode": "...", "accountNumber": "..." }
 *     -> { data: { bankName, accountNumber, accountName, bankCode } }
 *
 *   { "action": "bank-info" }
 *     -> { data: {...} | null }
 *
 *   { "action": "withdraw", "pin": "1234", "amount": 500 }
 *     -> { data: { status: 'processing', amount, newBalance, ... } }
 * ---------------------------------------------------------------------
 */

const { requireAuth, verifyPin } = require('../lib/auth');
const { withErrorHandling, sendSuccess, sendError, methodNotAllowed } = require('../lib/response');
const { validateRequiredFields, validatePin, ValidationError } = require('../lib/validation');
const withdrawalService = require('../lib/withdrawalService');

async function banks(req, res) {
  const data = await withdrawalService.listBanks();
  return sendSuccess(res, data);
}

async function validateAccount(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['bankCode', 'accountNumber']);
  const data = await withdrawalService.validateAccount({
    bankCode: body.bankCode,
    accountNumber: body.accountNumber
  });
  return sendSuccess(res, data);
}

async function saveBankInfo(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['bankName', 'accountName', 'bankCode', 'accountNumber']);
  const data = await withdrawalService.saveBankInfo({
    userId: req.user.id,
    bankName: body.bankName,
    accountName: body.accountName,
    bankCode: body.bankCode,
    accountNumber: body.accountNumber
  });
  return sendSuccess(res, data, { message: 'Bank account saved' });
}

async function bankInfo(req, res) {
  const data = await withdrawalService.getBankInfo(req.user.id);
  return sendSuccess(res, data);
}

async function withdraw(req, res) {
  const body = req.body || {};
  validateRequiredFields(body, ['pin', 'amount']);

  const pin = validatePin(body.pin);
  await verifyPin(req.user.id, pin);

  const data = await withdrawalService.withdraw({ userId: req.user.id, amount: body.amount });
  return sendSuccess(res, data, { message: 'Withdrawal request received and is being processed' });
}

const ACTION_HANDLERS = {
  banks,
  'validate-account': validateAccount,
  'save-bank-info': saveBankInfo,
  'bank-info': bankInfo,
  withdraw
};

async function dispatch(req, res) {
  const action = req.body && req.body.action;
  const handler = ACTION_HANDLERS[action];

  if (!handler) {
    return sendError(
      res,
      new ValidationError('action must be one of: banks, validate-account, save-bank-info, bank-info, withdraw', {
        details: [{ field: 'action', message: 'Unknown or missing action' }]
      })
    );
  }

  return handler(req, res);
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return requireAuth(dispatch)(req, res);
});
