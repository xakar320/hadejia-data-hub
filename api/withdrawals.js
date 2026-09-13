'use strict';

/**
 * api/withdrawals.js
 * ---------------------------------------------------------------------
 * POST /api/withdrawals
 *
 * Handles every Customer Withdrawal action in ONE file/function
 * (banks list, saving bank info, reading it back, and the withdrawal
 * itself) — like api/airtime-to-cash.js, this keeps us within Vercel
 * Hobby's 12 serverless-function limit instead of spending multiple
 * separate files on one feature.
 *
 * NOTE: bank info is stored in OUR OWN customer_bank_info table, not
 * on SecureWaveNG — their customer_withdrawals/bank-info and
 * validate-account-name endpoints are gated behind the same merchant
 * permission the withdraw endpoint needs, which isn't enabled for
 * this account. The customer types their own account name; since
 * payouts are manual, the admin double-checks it before paying.
 *
 * Request body: { "action": "...", ...action-specific fields }
 *
 *   { "action": "banks" }
 *     -> { data: [{ id, name, bankCode }, ...] }
 *
 *   { "action": "save-bank-info", "bankName": "...", "accountName": "...",
 *     "bankCode": "...", "accountNumber": "..." }
 *     -> { data: { bankName, accountNumber, accountName, bankCode } }
 *
 *   { "action": "bank-info" }
 *     -> { data: {...} | null }
 *
 *   { "action": "withdraw", "pin": "1234", "amount": 500 }
 *     -> { data: { status: 'pending', amount, newBalance, ... } }
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
  return sendSuccess(res, data, { message: 'Withdrawal request received and will be paid out manually' });
}

const ACTION_HANDLERS = {
  banks,
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
      new ValidationError('action must be one of: banks, save-bank-info, bank-info, withdraw', {
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
