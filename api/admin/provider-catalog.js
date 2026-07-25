'use strict';

/**
 * api/admin/provider-catalog.js
 * ---------------------------------------------------------------------
 * GET /api/admin/provider-catalog?types=talk-more,data-sme
 * Admin-only. Fetches AutosyncNG's live category/product/variation
 * data so an admin can read off the real product_id and variation_code
 * values to enter into a plan in admin.html, without needing Postman
 * or direct API access. Read-only — never writes anything.
 *
 * Query params:
 *   types  optional comma-separated list of SERVICE_ENDPOINTS keys
 *          (e.g. "talk-more,airtime,cable"). Defaults to all services.
 * ---------------------------------------------------------------------
 */

const { requireAdmin } = require('../../lib/auth');
const { withErrorHandling, sendSuccess, methodNotAllowed } = require('../../lib/response');
const autosync = require('../../lib/autosync');

async function providerCatalog(req, res) {
  const typesParam = req.query && req.query.types;
  const types = typesParam ? String(typesParam).split(',').map(s => s.trim()).filter(Boolean) : undefined;

  const result = await autosync.getCategories(types);

  return sendSuccess(res, result, { message: 'Fetched live catalog from AutosyncNG' });
}

module.exports = withErrorHandling(async function handler(req, res) {
  if (methodNotAllowed(req, res, ['GET'])) return;
  return requireAdmin(providerCatalog)(req, res);
});
