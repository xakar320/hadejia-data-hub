'use strict';

/**
 * lib/auth.js
 * ---------------------------------------------------------------------
 * Authentication & authorization for Vercel serverless functions.
 *
 * Verifies the Supabase-issued JWT access token sent by the frontend,
 * loads the matching profile from public.users, and rejects the
 * request if the account is suspended, banned, or has no profile
 * (treated as deleted — the users table cascades on auth.users
 * deletion, so a missing profile means the account no longer exists).
 *
 * Token verification and profile loading both use the service-role
 * Supabase client (see lib/supabaseAdmin.js) so this works
 * independently of RLS — but the service-role key itself is never
 * read from, logged, or returned by any function here.
 *
 * The resulting `user` object is exactly what wallet.js,
 * transactions.js, and autosync.js expect a caller to have on hand:
 * `user.id` is the `userId` those modules take, and `user.role` is
 * what admin-only endpoints check.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY env vars
 * (via lib/supabaseAdmin.js).
 * ---------------------------------------------------------------------
 */

const { supabaseAdmin } = require('./supabaseAdmin');

class AuthError extends Error {
  constructor(message, { statusCode = 401, code = 'UNAUTHORIZED' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const ADMIN_ROLES = ['admin', 'superadmin'];

/**
 * Normalized error body shape used by requireAuth/requireAdmin.
 * Kept intentionally small and stable so response.js (or any future
 * response formatter) can wrap it consistently.
 */
function toErrorBody(error) {
  return {
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Something went wrong'
    }
  };
}

/**
 * Extract the bearer token from a request's Authorization header.
 * Accepts "Authorization: Bearer <token>" (case-insensitive scheme).
 */
function getBearerToken(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!header || typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verify a Supabase access token and load the corresponding profile
 * from public.users. Throws AuthError for any invalid, expired,
 * missing, suspended, or banned account.
 *
 * @param {string} token - a Supabase JWT access token
 * @returns {Promise<Object>} normalized user object:
 *   {
 *     id, email, phone, fullName, role, status,
 *     walletBalance, referralCode, authUser
 *   }
 */
async function getUserFromToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new AuthError('Missing access token', { statusCode: 401, code: 'MISSING_TOKEN' });
  }

  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !authData || !authData.user) {
    throw new AuthError('Invalid or expired access token', {
      statusCode: 401,
      code: 'INVALID_TOKEN'
    });
  }

  const authUser = authData.user;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email, phone, role, status, wallet_balance, referral_code, referred_by, created_at')
    .eq('id', authUser.id)
    .maybeSingle();

  if (profileError) {
    throw new AuthError('Failed to load user profile', {
      statusCode: 500,
      code: 'PROFILE_LOOKUP_FAILED'
    });
  }

  // No profile row = no account. The users table cascades on
  // auth.users deletion, so a missing profile for a valid auth token
  // means the account has been deleted (or was never provisioned).
  if (!profile) {
    throw new AuthError('Account not found', { statusCode: 401, code: 'ACCOUNT_DELETED' });
  }

  if (profile.status === 'suspended') {
    throw new AuthError('This account has been suspended', {
      statusCode: 403,
      code: 'ACCOUNT_SUSPENDED'
    });
  }

  if (profile.status === 'banned') {
    throw new AuthError('This account has been banned', {
      statusCode: 403,
      code: 'ACCOUNT_BANNED'
    });
  }

  return {
    id: profile.id,
    email: profile.email,
    phone: profile.phone,
    fullName: profile.full_name,
    role: profile.role,
    status: profile.status,
    walletBalance: Number(profile.wallet_balance),
    referralCode: profile.referral_code,
    referredBy: profile.referred_by,
    createdAt: profile.created_at,
    authUser: {
      id: authUser.id,
      email: authUser.email,
      phone: authUser.phone
    }
  };
}

/**
 * Wrap a Vercel serverless function handler so it only runs for an
 * authenticated, active user. On success, `req.user` is set to the
 * normalized user object from getUserFromToken() before your handler
 * runs. On failure, responds with a normalized JSON error and never
 * calls your handler.
 *
 * Usage:
 *   module.exports = requireAuth(async (req, res) => {
 *     const balance = await wallet.getBalance(req.user.id);
 *     res.status(200).json({ success: true, data: { balance } });
 *   });
 *
 * @param {Function} handler - (req, res) => Promise<void>
 * @returns {Function} wrapped (req, res) => Promise<void>
 */
function requireAuth(handler) {
  return async function wrappedHandler(req, res) {
    try {
      const token = getBearerToken(req);
      const user = await getUserFromToken(token);
      req.user = user;
      return await handler(req, res);
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json(toErrorBody(error));
      }
      // eslint-disable-next-line no-console
      console.error('[auth] Unexpected error in requireAuth:', error);
      return res.status(500).json(
        toErrorBody(new AuthError('Authentication failed', { statusCode: 500, code: 'AUTH_INTERNAL_ERROR' }))
      );
    }
  };
}

/**
 * Wrap a Vercel serverless function handler so it only runs for an
 * authenticated user with an admin/superadmin role. Performs the same
 * checks as requireAuth() first, then additionally rejects non-admin
 * users. `req.user` is set exactly as in requireAuth().
 *
 * Usage:
 *   module.exports = requireAdmin(async (req, res) => {
 *     // req.user.role is guaranteed to be 'admin' or 'superadmin' here
 *   });
 *
 * @param {Function} handler - (req, res) => Promise<void>
 * @returns {Function} wrapped (req, res) => Promise<void>
 */
function requireAdmin(handler) {
  return requireAuth(async function wrappedAdminHandler(req, res) {
    if (!ADMIN_ROLES.includes(req.user.role)) {
      const error = new AuthError('Admin access required', {
        statusCode: 403,
        code: 'FORBIDDEN'
      });
      return res.status(error.statusCode).json(toErrorBody(error));
    }
    return handler(req, res);
  });
}

module.exports = {
  AuthError,
  ADMIN_ROLES,
  getBearerToken,
  getUserFromToken,
  requireAuth,
  requireAdmin
};
