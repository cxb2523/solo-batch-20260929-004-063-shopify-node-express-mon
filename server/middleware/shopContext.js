import { RequestedTokenType, Session } from "@shopify/shopify-api";
import crypto from "crypto";
import StoreModel from "../../utils/models/StoreModel.js";
import sessionHandler from "../../utils/sessionHandler.js";
import shopify from "../../utils/shopify.js";
import validateJWT from "../../utils/validateJWT.js";

const CACHE_TTL_MS = 30_000;

const UNAUTHORIZED_RESPONSE = { error: "Unauthorized call" };
const INACTIVE_RESPONSE = { error: "Shop is not active" };

// cacheKey (`${shop}:${planVersion}`) -> { value: {plan, active, planVersion}, expiresAt }
const contextCache = new Map();
// cacheKey -> Promise, dedupes concurrent origin fetches for the same shop+plan version
const inflightRefreshes = new Map();
// shop -> last known planVersion, used to build cache/dedup keys
const planVersions = new Map();

const stats = {
  cacheHits: 0,
  cacheMisses: 0,
  originFetches: 0,
};

const getShopContextStats = () => ({ ...stats });

/**
 * Invalidates all cached context for a shop. Call this whenever a
 * subscription or activation change happens so the old cache is voided
 * immediately and the next request re-fetches from the origin.
 *
 * @param {string} shop - The shop's myshopify domain.
 * @param {number} [planVersion] - The new plan version, if already known.
 */
const invalidateShopContext = (shop, planVersion) => {
  const nextVersion =
    typeof planVersion === "number"
      ? planVersion
      : (planVersions.get(shop) ?? 0) + 1;
  planVersions.set(shop, nextVersion);
  for (const key of contextCache.keys()) {
    if (key.startsWith(`${shop}:`)) {
      contextCache.delete(key);
    }
  }
};

/**
 * Loads {plan, active, planVersion} for a shop, backed by a 30s cache.
 * Expired entries are refreshed from MongoDB with per-shop+planVersion
 * deduplication: N concurrent requests for the same shop trigger exactly
 * one origin fetch.
 *
 * @param {string} shop - The shop's myshopify domain.
 */
const getPlanContext = async (shop) => {
  const knownVersion = planVersions.get(shop) ?? 0;
  const cacheKey = `${shop}:${knownVersion}`;

  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    stats.cacheHits += 1;
    return cached.value;
  }

  const inflight = inflightRefreshes.get(cacheKey);
  if (inflight) {
    stats.cacheHits += 1;
    return inflight;
  }

  stats.cacheMisses += 1;
  const refresh = (async () => {
    stats.originFetches += 1;
    const store = await StoreModel.findOne({ shop }).lean();
    const value = {
      plan: store?.plan ?? null,
      active: store?.isActive === true,
      planVersion: store?.planVersion ?? 0,
    };
    if (value.planVersion !== knownVersion) {
      // Plan changed while we were fetching; the old key is void.
      planVersions.set(shop, value.planVersion);
      contextCache.delete(cacheKey);
    }
    contextCache.set(`${shop}:${value.planVersion}`, {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return value;
  })();

  inflightRefreshes.set(cacheKey, refresh);
  try {
    return await refresh;
  } finally {
    inflightRefreshes.delete(cacheKey);
  }
};

/**
 * Finds the most recent cached entry for a shop, even if expired. Used to
 * serve stale data when the origin fetch fails.
 *
 * @param {string} shop - The shop's myshopify domain.
 */
const findStalePlanContext = (shop) => {
  let stale;
  for (const [key, entry] of contextCache.entries()) {
    if (key.startsWith(`${shop}:`)) {
      stale = entry.value;
    }
  }
  return stale;
};

/**
 * Verifies a Shopify webhook HMAC against the raw request body.
 * Throws when the signature is missing or invalid.
 */
const verifyWebhookHmac = (req) => {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) {
    throw new Error("Missing webhook HMAC header");
  }
  const rawBody =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const generateHash = crypto
    .createHmac("SHA256", process.env.SHOPIFY_API_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  if (!shopify.auth.safeCompare(generateHash, hmac)) {
    throw new Error("Invalid webhook HMAC");
  }
};

/**
 * Exchanges an App Bridge session token for online + offline sessions and
 * stores them. Only ever called after the token signature has been
 * verified, so failed signature checks never hit the database.
 */
const exchangeAndStoreSession = async ({ shop, sessionToken }) => {
  const { session: onlineSession } = await shopify.auth.tokenExchange({
    sessionToken,
    shop,
    requestedTokenType: RequestedTokenType.OnlineAccessToken,
  });
  await sessionHandler.storeSession(onlineSession);

  const { session: offlineSession } = await shopify.auth.tokenExchange({
    sessionToken,
    shop,
    requestedTokenType: RequestedTokenType.OfflineAccessToken,
    expiring: true,
  });
  await sessionHandler.storeSession(offlineSession);

  return new Session(onlineSession);
};

/**
 * Resolves the request identity from one of three sources:
 * webhook HMAC headers, an App Bridge session token, or a MongoDB session.
 * Throws when the signature is invalid or required fields are missing.
 *
 * @returns {Promise<{shop: string, session: Session, source: string}>}
 */
const resolveIdentity = async (req, res) => {
  // Webhook chain
  if (req.headers["x-shopify-hmac-sha256"]) {
    verifyWebhookHmac(req);
    const shop = shopify.utils.sanitizeShop(
      req.headers["x-shopify-shop-domain"] || req.body?.shop_domain || ""
    );
    if (!shop) {
      throw new Error("No shop found on webhook request");
    }
    const session = await sessionHandler.loadSession(
      shopify.session.getOfflineId(shop)
    );
    return { shop, session, source: "webhook" };
  }

  // App Bridge session token chain
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const sessionToken = authHeader.split(" ")[1];
    const payload = validateJWT(sessionToken);
    const shop = shopify.utils.sanitizeShop(
      payload.dest.replace("https://", "")
    );
    if (!shop) {
      throw new Error("No shop found, not a valid request");
    }

    const sessionId = await shopify.session.getCurrentId({
      isOnline: true,
      rawRequest: req,
      rawResponse: res,
    });
    let session = await sessionHandler.loadSession(sessionId);
    const isUsable =
      session &&
      new Date(session.expires) > new Date() &&
      shopify.config.scopes.equals(session.scope);
    if (!isUsable) {
      session = await exchangeAndStoreSession({ shop, sessionToken });
    }
    return { shop, session, source: "token" };
  }

  // MongoDB session chain
  const shop = shopify.utils.sanitizeShop(req.query.shop || "");
  if (shop) {
    const session = await sessionHandler.loadSession(
      shopify.session.getOfflineId(shop)
    );
    if (session) {
      return { shop, session, source: "session" };
    }
  }

  throw new Error("No authorization header found");
};

/**
 * Unified auth + subscription middleware. Produces
 * res.locals.shopContext = { shop, session, plan, active, source } for
 * downstream handlers, which must not re-implement their own auth checks.
 *
 * - Invalid/missing signature -> 401, nothing is written to the database.
 * - Valid signature but inactive shop -> 403.
 * - Origin (MongoDB) failures degrade to source="session" with a warning;
 *   existing sessions are left untouched so blips don't log merchants out.
 *
 * @param {import('express').Request} req - Express request object
 * @param {import('express').Response} res - Express response object
 * @param {import('express').NextFunction} next - Express next middleware function
 */
const resolveShopContext = async (req, res, next) => {
  let identity;
  try {
    identity = await resolveIdentity(req, res);
  } catch (e) {
    console.error(`---> shopContext rejected request: ${e.message}`);
    return res.status(401).send(UNAUTHORIZED_RESPONSE);
  }

  if (!identity?.shop || !identity?.session) {
    console.error(`---> shopContext missing fields for request`);
    return res.status(401).send(UNAUTHORIZED_RESPONSE);
  }

  let planContext;
  let source = identity.source;
  try {
    planContext = await getPlanContext(identity.shop);
  } catch (e) {
    console.warn(
      `---> shopContext origin fetch failed for ${identity.shop}, degrading to source=session: ${e.message}`
    );
    planContext = findStalePlanContext(identity.shop) ?? {
      plan: null,
      active: true,
      planVersion: 0,
    };
    source = "session";
  }

  if (planContext.active !== true) {
    return res.status(403).send(INACTIVE_RESPONSE);
  }

  res.locals.shopContext = {
    shop: identity.shop,
    session: identity.session,
    plan: planContext.plan,
    active: planContext.active,
    source,
  };
  next();
};

export { getShopContextStats, invalidateShopContext };
export default resolveShopContext;
