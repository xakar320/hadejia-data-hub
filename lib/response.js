'use strict';

/**
 * lib/response.js
 * ---------------------------------------------------------------------
 * Normalized HTTP responses for Vercel serverless functions. Every
 * endpoint should send success/error bodies through this module so
 * the frontend can rely on one consistent shape regardless of which
 * part of the backend produced the result.
 *
 * Success shape:
 *   {
 *     success: true,
 *     data: <any>,
 *     message: string,
 *     meta: <object|null>,
 *     timestamp: <ISO 8601 string>
 *   }
 *
 * Error shape:
 *   {
 *     success: false,
 *     error: {
 *       code: string,
 *       message: string,
 *       details: <array|null>   // e.g. ValidationError's field-level issues
 *     },
 *     timestamp: <ISO 8601 string>
 *   }
 *
 * This module recognizes the error classes thrown by every other
 * module in the backend (auth.js's AuthError, validation.js's
 * ValidationError, wallet.js's WalletError/InsufficientFundsError,
 * transactions.js's TransactionError/DuplicateTransactionError/
 * InvalidStateTransitionError, autosync.js's AutosyncError) purely by
 * `name`/`code`/`statusCode` duck-typing — it does NOT `require()`
 * those modules, so there's no risk of circular dependencies no
 * matter which module ends up requiring response.js.
 * ---------------------------------------------------------------------
 */

// Fallback HTTP status codes for error `code` values that don't carry
// their own `statusCode` (auth.js's AuthError and validation.js's
// ValidationError already set statusCode themselves; this map covers
// wallet.js, transactions.js, and autosync.js, whose errors only set
// `code`).
const CODE_STATUS_MAP = {
  // wallet.js
  INVALID_USER: 400,
  INVALID_AMOUNT: 400,
  INVALID_SOURCE: 400,
  INSUFFICIENT_FUNDS: 402,
  USER_NOT_FOUND: 404,
  DEBIT_FAILED: 500,
  CREDIT_FAILED: 500,

  // transactions.js
  INVALID_INPUT: 400,
  INVALID_TYPE: 400,
  NOT_FOUND: 404,
  DUPLICATE_TRANSACTION: 409,
  INVALID_STATE: 409,

  // autosync.js
  AUTOSYNC_ERROR: 502,

  // validation.js (ValidationError also sets statusCode=400 itself;
  // this is just a safety net if that ever isn't set)
  VALIDATION_ERROR: 400,

  // generic
  DB_ERROR: 500,
  WALLET_RPC_ERROR: 500,
  INTERNAL_ERROR: 500
};

const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please try again.';
const DEFAULT_ERROR_CODE = 'INTERNAL_ERROR';

function timestamp() {
  return new Date().toISOString();
}

/**
 * Build a success response body (does not send it — use sendSuccess
 * for that). Useful when you need the plain object, e.g. for testing.
 *
 * @param {*} data
 * @param {Object} [options]
 * @param {string} [options.message='Request successful']
 * @param {Object} [options.meta]
 * @returns {Object}
 */
function successBody(data = null, { message = 'Request successful', meta = null } = {}) {
  return {
    success: true,
    data,
    message,
    meta,
    timestamp: timestamp()
  };
}

/**
 * Resolve the HTTP status code to use for a given error.
 * Priority: explicit error.statusCode -> CODE_STATUS_MAP[error.code] -> 500.
 */
function resolveStatusCode(error) {
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  if (error.code && CODE_STATUS_MAP[error.code]) {
    return CODE_STATUS_MAP[error.code];
  }
  return 500;
}

/**
 * Build an error response body (does not send it — use sendError for
 * that). Normalizes any thrown error, including plain JS Errors that
 * don't carry a `code`.
 *
 * @param {Error} error
 * @returns {{ body: Object, statusCode: number }}
 */
function errorBody(error) {
  const statusCode = resolveStatusCode(error);

  // Never leak internal error messages/stack details for unexpected
  // (non-normalized) 500-level failures — only the modules in this
  // backend that deliberately throw a typed, user-safe error get their
  // message surfaced to the client.
  const isKnownErrorType = typeof error.code === 'string' || error.name === 'AuthError' || error.name === 'ValidationError';
  const isServerError = statusCode >= 500;

  const message = isServerError && !isKnownErrorType
    ? DEFAULT_ERROR_MESSAGE
    : error.message || DEFAULT_ERROR_MESSAGE;

  const body = {
    success: false,
    error: {
      code: error.code || DEFAULT_ERROR_CODE,
      message,
      details: Array.isArray(error.details) && error.details.length > 0 ? error.details : null
    },
    timestamp: timestamp()
  };

  return { body, statusCode };
}

/**
 * Send a normalized success response.
 *
 * @param {import('http').ServerResponse} res
 * @param {*} data
 * @param {Object} [options]
 * @param {number} [options.statusCode=200]
 * @param {string} [options.message='Request successful']
 * @param {Object} [options.meta]
 */
function sendSuccess(res, data = null, { statusCode = 200, message = 'Request successful', meta = null } = {}) {
  return res.status(statusCode).json(successBody(data, { message, meta }));
}

/**
 * Send a normalized error response. Logs unexpected (non-typed, 500-
 * level) errors server-side with full detail before responding, since
 * the response body itself deliberately withholds internal detail for
 * those.
 *
 * @param {import('http').ServerResponse} res
 * @param {Error} error
 */
function sendError(res, error) {
  const { body, statusCode } = errorBody(error);

  if (statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error('[response] Unhandled error:', {
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack
    });
  }

  return res.status(statusCode).json(body);
}

/**
 * Send a 201 Created response. Convenience wrapper around sendSuccess.
 */
function sendCreated(res, data = null, message = 'Resource created') {
  return sendSuccess(res, data, { statusCode: 201, message });
}

/**
 * Send a 204 No Content response (no JSON body).
 */
function sendNoContent(res) {
  return res.status(204).end();
}

/**
 * Send a 404 for an unmatched route/resource.
 */
function sendNotFound(res, message = 'Resource not found') {
  return res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message, details: null },
    timestamp: timestamp()
  });
}

/**
 * Reject a request whose HTTP method isn't in `allowedMethods`.
 * Sets the Allow header per HTTP spec and responds 405.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string[]} allowedMethods
 * @returns {boolean} true if the method was rejected (caller should return immediately)
 */
function methodNotAllowed(req, res, allowedMethods) {
  if (allowedMethods.includes(req.method)) {
    return false;
  }
  res.setHeader('Allow', allowedMethods.join(', '));
  res.status(405).json({
    success: false,
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: `${req.method} is not allowed on this endpoint. Allowed: ${allowedMethods.join(', ')}`,
      details: null
    },
    timestamp: timestamp()
  });
  return true;
}

/**
 * Wrap a Vercel serverless handler so any thrown/rejected error
 * (from auth.js, validation.js, wallet.js, transactions.js,
 * autosync.js, or your own endpoint code) is caught and sent through
 * sendError() automatically, instead of every endpoint needing its
 * own try/catch.
 *
 * Usage:
 *   module.exports = withErrorHandling(async (req, res) => {
 *     const data = await someModule.doSomething();
 *     sendSuccess(res, data);
 *   });
 *
 * Composes with auth.js's requireAuth/requireAdmin in either order:
 *   module.exports = withErrorHandling(requireAuth(async (req, res) => { ... }));
 *
 * @param {Function} handler - (req, res) => Promise<void> | void
 * @returns {Function} wrapped (req, res) => Promise<void>
 */
function withErrorHandling(handler) {
  return async function wrappedHandler(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

module.exports = {
  successBody,
  errorBody,
  sendSuccess,
  sendError,
  sendCreated,
  sendNoContent,
  sendNotFound,
  methodNotAllowed,
  withErrorHandling
};
