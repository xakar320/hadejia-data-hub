'use strict';

/**
 * lib/validation.js
 * ---------------------------------------------------------------------
 * Reusable validation for Vercel serverless functions. Every check
 * here exists to reject a malformed request BEFORE it reaches
 * auth.js, wallet.js, transactions.js, or autosync.js — none of those
 * modules re-validate their inputs, so endpoints should run these
 * checks first.
 *
 * Every validator either returns a normalized value (for values worth
 * normalizing, like phone numbers) or throws a ValidationError with a
 * consistent shape. Use runValidators() to check several fields at
 * once and report every problem in a single response instead of one
 * round trip per mistake.
 * ---------------------------------------------------------------------
 */

class ValidationError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {Array<{field: string, message: string}>} [options.details]
   */
  constructor(message, { details } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_ERROR';
    this.details = details || [];
  }
}

function fail(field, message) {
  throw new ValidationError(message, { details: [{ field, message }] });
}

// -----------------------------------------------------------------------
// Required fields
// -----------------------------------------------------------------------

/**
 * Ensure every field in `requiredFields` is present on `payload` and
 * not null/undefined/empty-string. Collects ALL missing fields into a
 * single error instead of failing on the first one.
 *
 * @param {Object} payload
 * @param {string[]} requiredFields
 * @throws {ValidationError}
 */
function validateRequiredFields(payload, requiredFields) {
  const missing = [];

  for (const field of requiredFields) {
    const value = payload ? payload[field] : undefined;
    const isEmpty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    if (isEmpty) {
      missing.push({ field, message: `${field} is required` });
    }
  }

  if (missing.length > 0) {
    throw new ValidationError('Missing required field(s)', { details: missing });
  }
}

// -----------------------------------------------------------------------
// Nigerian phone numbers
// -----------------------------------------------------------------------

// Matches the 11-digit local format used by all Nigerian mobile
// networks (MTN, Glo, Airtel, 9mobile): 0 + [7-9] + [0-1] + 8 digits.
const NIGERIAN_LOCAL_PHONE_REGEX = /^0[7-9][01]\d{8}$/;

/**
 * Normalize a Nigerian phone number to local 11-digit format
 * (e.g. "08012345678"), accepting +234/234 country-code prefixes and
 * stripping spaces/dashes. Returns null if the input can't be
 * normalized into a valid Nigerian mobile number.
 *
 * @param {string} phone
 * @returns {string|null}
 */
function normalizeNigerianPhone(phone) {
  if (!phone || typeof phone !== 'string') return null;

  let cleaned = phone.replace(/[\s-()]/g, '');

  if (cleaned.startsWith('+234')) {
    cleaned = `0${cleaned.slice(4)}`;
  } else if (cleaned.startsWith('234') && cleaned.length === 13) {
    cleaned = `0${cleaned.slice(3)}`;
  } else if (/^[789]\d{9}$/.test(cleaned)) {
    // Bare 10-digit number missing its leading 0 (e.g. "8012345678")
    cleaned = `0${cleaned}`;
  }

  return NIGERIAN_LOCAL_PHONE_REGEX.test(cleaned) ? cleaned : null;
}

/**
 * @param {string} phone
 * @returns {boolean}
 */
function isValidNigerianPhone(phone) {
  return normalizeNigerianPhone(phone) !== null;
}

/**
 * Validate a Nigerian phone number field, throwing ValidationError if
 * invalid. Returns the normalized 11-digit local format on success.
 *
 * @param {string} phone
 * @param {string} [fieldName='phone']
 * @returns {string} normalized phone number
 */
function validatePhone(phone, fieldName = 'phone') {
  const normalized = normalizeNigerianPhone(phone);
  if (!normalized) {
    fail(fieldName, `${fieldName} must be a valid Nigerian mobile number`);
  }
  return normalized;
}

// -----------------------------------------------------------------------
// UUIDs
// -----------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Validate a UUID field (e.g. user id, plan id, transaction id),
 * throwing ValidationError if invalid.
 *
 * @param {string} value
 * @param {string} [fieldName='id']
 * @returns {string} the validated UUID, unchanged
 */
function validateUUID(value, fieldName = 'id') {
  if (!isValidUUID(value)) {
    fail(fieldName, `${fieldName} must be a valid UUID`);
  }
  return value;
}

// -----------------------------------------------------------------------
// request_ref (our/AutosyncNG idempotency key)
// -----------------------------------------------------------------------

// Alphanumeric plus dash/underscore, 6-64 chars. Matches the
// generateReference()/generateRequestRef() output shape from
// wallet.js/autosync.js and is safe as a unique DB column value and
// as a provider-facing request_ref.
const REQUEST_REF_REGEX = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidRequestRef(value) {
  return typeof value === 'string' && REQUEST_REF_REGEX.test(value);
}

/**
 * Validate a request_ref / idempotency key field.
 *
 * @param {string} value
 * @param {string} [fieldName='request_ref']
 * @returns {string} the validated request_ref, unchanged
 */
function validateRequestRef(value, fieldName = 'request_ref') {
  if (!isValidRequestRef(value)) {
    fail(
      fieldName,
      `${fieldName} must be 6-64 characters, using only letters, numbers, hyphens, and underscores`
    );
  }
  return value;
}

// -----------------------------------------------------------------------
// product_id / variation_code (AutosyncNG plan identifiers)
// -----------------------------------------------------------------------

// AutosyncNG product ids / variation codes appear as either short
// numeric strings or alphanumeric codes — accept both, disallow
// whitespace and punctuation that could break a downstream query.
const PLAN_IDENTIFIER_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Validate a product_id (network/disco/cable-provider identifier from
 * AutosyncNG's product catalog). Accepts numbers or strings, always
 * returns a string.
 *
 * @param {string|number} value
 * @param {string} [fieldName='product_id']
 * @returns {string}
 */
function validateProductId(value, fieldName = 'product_id') {
  if (value === null || value === undefined) {
    fail(fieldName, `${fieldName} is required`);
  }
  const str = String(value);
  if (!PLAN_IDENTIFIER_REGEX.test(str)) {
    fail(fieldName, `${fieldName} must be a valid product identifier`);
  }
  return str;
}

/**
 * Validate a variation_code (specific data/cable plan variation from
 * AutosyncNG). The literal value "none" is explicitly allowed since
 * AutosyncNG requires it for cable renewals/free-entry/box-office
 * purchases that have no variation.
 *
 * @param {string|number} value
 * @param {string} [fieldName='variation_code']
 * @returns {string}
 */
function validateVariationCode(value, fieldName = 'variation_code') {
  if (value === null || value === undefined) {
    fail(fieldName, `${fieldName} is required`);
  }
  const str = String(value);
  if (str !== 'none' && !PLAN_IDENTIFIER_REGEX.test(str)) {
    fail(fieldName, `${fieldName} must be a valid variation code or "none"`);
  }
  return str;
}

// -----------------------------------------------------------------------
// Transaction amount
// -----------------------------------------------------------------------

/**
 * Validate a transaction amount. Rejects non-numbers, non-finite
 * values, zero/negative amounts, values with more than 2 decimal
 * places (kobo precision), and anything outside an optional min/max
 * range (e.g. a plan's configured min_amount/max_amount).
 *
 * @param {number} value
 * @param {string} [fieldName='amount']
 * @param {Object} [options]
 * @param {number} [options.min=1]
 * @param {number} [options.max=1000000]
 * @returns {number} the validated amount
 */
function validateAmount(value, fieldName = 'amount', { min = 1, max = 1000000 } = {}) {
  const amount = typeof value === 'string' ? Number(value) : value;

  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    fail(fieldName, `${fieldName} must be a number`);
  }
  if (amount <= 0) {
    fail(fieldName, `${fieldName} must be greater than zero`);
  }
  // Reject sub-kobo precision (more than 2 decimal places).
  if (Math.round(amount * 100) !== amount * 100) {
    fail(fieldName, `${fieldName} cannot have more than 2 decimal places`);
  }
  if (amount < min) {
    fail(fieldName, `${fieldName} must be at least ${min}`);
  }
  if (amount > max) {
    fail(fieldName, `${fieldName} cannot exceed ${max}`);
  }

  return amount;
}

// -----------------------------------------------------------------------
// Merchant / wallet transaction PIN
// -----------------------------------------------------------------------

// The customer-facing transaction PIN (checked against users.pin_hash
// before authorizing a purchase) — 4 to 6 numeric digits. This is
// distinct from AUTOSYNC_MERCHANT_PIN, which is a server-only env var
// autosync.js reads directly and which a request body should never
// carry.
const PIN_REGEX = /^\d{4,6}$/;

/**
 * @param {string} pin
 * @returns {boolean}
 */
function isValidPin(pin) {
  return typeof pin === 'string' && PIN_REGEX.test(pin);
}

/**
 * Validate a user-supplied transaction PIN field.
 *
 * @param {string} pin
 * @param {string} [fieldName='pin']
 * @returns {string} the validated PIN, unchanged
 */
function validatePin(pin, fieldName = 'pin') {
  if (!isValidPin(pin)) {
    fail(fieldName, `${fieldName} must be 4-6 digits`);
  }
  return pin;
}

// -----------------------------------------------------------------------
// Composable multi-field validation
// -----------------------------------------------------------------------

/**
 * Run several validators together and throw a single combined
 * ValidationError listing every failure, instead of stopping at the
 * first one. Each entry in `validators` is a zero-argument function
 * that should call one of the validate*() functions above (letting
 * their ValidationError propagate) or throw its own ValidationError.
 *
 * @param {Array<Function>} validators
 * @throws {ValidationError} if any validator fails
 *
 * @example
 *   runValidators([
 *     () => validateRequiredFields(req.body, ['phone', 'amount', 'product_id']),
 *     () => validatePhone(req.body.phone),
 *     () => validateAmount(req.body.amount, 'amount', { min: 50, max: 50000 }),
 *     () => validateProductId(req.body.product_id)
 *   ]);
 */
function runValidators(validators) {
  const details = [];

  for (const validator of validators) {
    try {
      validator();
    } catch (error) {
      if (error instanceof ValidationError) {
        details.push(...error.details);
      } else {
        throw error;
      }
    }
  }

  if (details.length > 0) {
    throw new ValidationError('Validation failed', { details });
  }
}

module.exports = {
  ValidationError,
  validateRequiredFields,
  isValidNigerianPhone,
  normalizeNigerianPhone,
  validatePhone,
  isValidUUID,
  validateUUID,
  isValidRequestRef,
  validateRequestRef,
  validateProductId,
  validateVariationCode,
  validateAmount,
  isValidPin,
  validatePin,
  runValidators
};
