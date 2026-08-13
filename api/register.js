'use strict';

/**
 * api/register.js
 * POST /api/register
 *
 * Public (unauthenticated) endpoint — this is the server-side
 * counterpart to register.html's "Create Account" button
 * (js/auth.js#registerUser()).
 *
 * Body: { full_name, phone, email, password, pin }
 *
 * Creates a Supabase Auth user + matching public.users row via
 * lib/accountRegistration.js, reusing:
 *   - lib/validation.js  (phone normalization/validation, same rules
 *                          used everywhere else in the app)
 *   - lib/supabaseAdmin.js (service role — never exposed to the browser)
 *   - lib/referral.js    (referral code generation, same helper the
 *                          WhatsApp registration flow uses)
 *
 * Does NOT create a second authentication system, a second users
 * table, or new columns. Phone stays in the existing local format
 * ("08...") — the same format WhatsApp identification already
 * expects (see api/whatsapp-webhook.js's toLocalPhone()).
 * ---------------------------------------------------------------------
 */

const crypto = require('crypto');

const { withErrorHandling, sendCreated, methodNotAllowed } = require('../lib/response');
const { validateRequiredFields, validatePhone, ValidationError } = require('../lib/validation');
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const accountRegistration = require('../lib/accountRegistration');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_REGEX = /^\d{4}$/;
const MIN_PASSWORD_LENGTH = 6;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 100;

async function register(req, res) {
  const body = req.body || {};

  validateRequiredFields(body, ['full_name', 'phone', 'email', 'password', 'pin']);

  const fullName = String(body.full_name).trim();
  if (fullName.length < MIN_NAME_LENGTH || fullName.length > MAX_NAME_LENGTH) {
    throw new ValidationError('Please enter your full name', {
      details: [{ field: 'full_name', message: `full_name must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters` }]
    });
  }

  // Reuses the exact same normalizer as the rest of the app — throws
  // a ValidationError itself if the format is invalid.
  const phone = validatePhone(body.phone, 'phone');

  const email = String(body.email).trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    throw new ValidationError('Please enter a valid email address', {
      details: [{ field: 'email', message: 'email must be a valid address' }]
    });
  }

  // NEVER log `password` — used once below, then goes out of scope.
  const password = body.password;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      details: [{ field: 'password', message: 'password too short' }]
    });
  }

  // NEVER log `pin` — hashed immediately below.
  const pin = String(body.pin).trim();
  if (!PIN_REGEX.test(pin)) {
    throw new ValidationError('PIN must be exactly 4 digits', {
      details: [{ field: 'pin', message: 'pin must be exactly 4 digits' }]
    });
  }

  // Uniqueness checks via the service-role client — reliable
  // regardless of RLS, unlike a pre-signup check from the browser.
  const { data: existingEmail, error: emailErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (emailErr) throw new Error(`Email check failed: ${emailErr.message}`);
  if (existingEmail) {
    throw new ValidationError('An account with this email already exists', {
      details: [{ field: 'email', message: 'email already registered' }]
    });
  }

  const { data: existingPhone, error: phoneErr } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (phoneErr) throw new Error(`Phone check failed: ${phoneErr.message}`);
  if (existingPhone) {
    throw new ValidationError('An account with this phone number already exists', {
      details: [{ field: 'phone', message: 'phone already registered' }]
    });
  }

  // Same SHA-256 approach already used by lib/auth.js#verifyPin and
  // js/profile.js#savePin — only the hash is ever stored.
  const pinHash = crypto.createHash('sha256').update(pin).digest('hex');

  let newUser;
  try {
    newUser = await accountRegistration.createAccount({
      fullName,
      email,
      phone,
      password,
      pinHash,
      referredBy: null
    });
  } catch (err) {
    if (/already.*registered|already.*exists/i.test(err.message || '')) {
      throw new ValidationError('An account with this email already exists', {
        details: [{ field: 'email', message: 'email already registered' }]
      });
    }
    // Don't leak internals to the customer — log server-side only.
    console.error('[register] Account creation failed:', err.message);
    throw new Error('Account creation failed');
  }

  return sendCreated(res, { id: newUser.id, email: newUser.email }, 'Account created successfully');
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  return register(req, res);
});
