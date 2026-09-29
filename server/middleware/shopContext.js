import crypto from "crypto";
import { RequestedTokenType, Session } from "@shopify/shopify-api";
import StoreModel from "../../utils/models/StoreModel.js";
import sessionHandler from "../../utils/sessionHandler.js";
import shopify from "../../utils/shopify.js";
import validateJWT from "../../utils/validateJWT.js";

/**
 * Unified shop context resolution.
 *
 * Three credential sources are accepted and normalised into the same
 * `{ shop, session, plan, active, source }` shape on `res.locals.shop_context`:
 *
 * - `token`   -> App Bridge session token (Bearer authorization header)
 * - `webhook` -> Shopify webhook HMAC signature
 * - `session` -> MongoDB session, either as the origin fallback or the
 *                degraded source when an origin refresh throws
 *
 * Subscription state for each shop is cached for `CACHE_TTL_MS`. Expired
 * entries are refetched from MongoDB once per shop + planVersion; concurrent
 * callers await the same in-flight promise.
 */

const CACHE_TTL_MS = 30 * 1000;

/**
 * @typedef {Object} ShopContext
 * @property {string} shop
 * @property {Session | null} session
 * @property {string | null} plan
 * @property {boolean} active
 * @property {"token" | "webhook" | "session" | "cache"} source
 */

/** @type {Map<string, {shop: string, plan: string, planVersion: number, active: boolean, expiresAt: number}>} */
const contextCache = new Map();

/** @type {Map<string, Promise<{shop: string, plan: string, planVersion: number, active: boolean}>>} */
const inFlight = new Map();

/** @type {Map<string, number>} Cumulative cache hits per shop, for the debug page */
const cacheHits = new Map();

export const UNAUTHORIZED_MESSAGE = "Unauthorized call";
export const SHOP_INACTIVE_MESSAGE = "Shop is not active";

const normalizeShop = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return shopify.utils.sanitizeShop(value.replace(/^https?:\/\//, ""));
};

const cacheEntry = (shop) => {
  const cached = contextCache.get(shop);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    contextCache.delete(shop);
    return undefined;
  }
  return cached;
};

/**
 * Fetches subscription state from MongoDB. Concurrent calls for the same
 * shop + planVersion share a single in-flight promise, so 20 simultaneous
 * requests for one shop trigger exactly one origin read.
 *
 * @param {string} shop
 * @returns {Promise<{shop: string, plan: string, planVersion: number, active: boolean}>}
 */
const fetchShopState = (shop) => {
  const knownVersion = contextCache.get(shop)?.planVersion;
  const dedupeKey = `${shop}:${knownVersion ?? "unknown"}`;
  const pending = inFlight.get(dedupeKey);
  if (pending) {
    return pending;
  }

  const promise = (async () => {
    const store = await StoreModel.findOne({ shop });
    const state = {
      shop,
      plan: store?.plan ?? "free",
      planVersion: store?.planVersion ?? 0,
      active: store?.isActive === true,
    };
    contextCache.set(shop, {
      ...state,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return state;
  })();

  inFlight.set(dedupeKey, promise);
  // Avoid an unhandled rejection if the origin read fails before a
  // concurrent caller attaches its own `.catch` via resolveSubscription.
  promise.catch(() => {});
  promise.finally(() => inFlight.delete(dedupeKey));
  return promise;
};

/**
 * Proactively drops the cached subscription state for a shop. Called on
 * subscription changes (and uninstall/reinstall) so an in-flight upgrade can
 * never serve the previous planVersion entry.
 *
 * @param {string} shop
 */
export const invalidateShopContext = (shop) => {
  if (!shop) {
    return;
  }
  contextCache.delete(shop);
};

/**
 * Persists a subscription-plan change and bumps `planVersion`. The version
 * bump is part of the cache dedupe key and invalidation is immediate.
 *
 * @param {string} shop
 * @param {string} plan
 * @returns {Promise<void>}
 */
export const setShopPlan = async (shop, plan) => {
  await StoreModel.findOneAndUpdate(
    { shop },
    { $set: { plan }, $inc: { planVersion: 1 } },
    { upsert: true }
  );
  invalidateShopContext(shop);
};

/** Cumulative subscription cache hits for a shop, exposed on the debug route. */
export const getCacheHits = (shop) => cacheHits.get(shop) ?? 0;

/**
 * Resolves plan/active state for a shop, serving the 30s cache when fresh.
 * On origin errors the existing session is kept and the request degrades to
 * `source: "session"` instead of logging the merchant out during a wobble.
 *
 * @param {string} shop
 * @param {"token" | "webhook"} origin
 * @returns {Promise<{plan: string | null, active: boolean, source: string, degraded: boolean}>}
 */
const resolveSubscription = async (shop, origin) => {
  const cached = cacheEntry(shop);
  if (cached) {
    cacheHits.set(shop, getCacheHits(shop) + 1);
    return {
      plan: cached.plan,
      active: cached.active,
      source: "cache",
      degraded: false,
    };
  }

  try {
    const state = await fetchShopState(shop);
    return {
      plan: state.plan,
      active: state.active,
      source: origin,
      degraded: false,
    };
  } catch (error) {
    console.warn(
      `---> shopContext origin fetch failed for ${shop}, ` +
        `degrading to session: ${error.message}`
    );
    const stale = contextCache.get(shop);
    return {
      plan: stale?.plan ?? null,
      active: stale?.active ?? false,
      source: "session",
      degraded: true,
    };
  }
};

/**
 * Performs the online + offline token exchange using an App Bridge session
 * token and persists both MongoDB sessions. Signature validity is established
 * before this runs, so an exchange never happens for an unsigned request.
 *
 * @param {string} shop
 * @param {string} sessionToken
 * @returns {Promise<Session>}
 */
const exchangeToken = async (shop, sessionToken) => {
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
 * Verifies a webhook HMAC. Works on the raw text body used by webhook routes
 * and on the already-parsed JSON body used by the GDPR compliance route.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const verifyWebhookHmac = (req) => {
  try {
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const generatedHash = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(rawBody, "utf8")
      .digest("base64");
    const hmac = req.headers["x-shopify-hmac-sha256"];
    return Boolean(hmac) && shopify.auth.safeCompare(generatedHash, hmac);
  } catch {
    return false;
  }
};

const rejectUnauthorized = (res) =>
  res.status(401).send({ error: UNAUTHORIZED_MESSAGE });

const rejectInactive = (res) =>
  res.status(403).send({ error: SHOP_INACTIVE_MESSAGE });

/**
 * Resolves the authenticated shop from either an App Bridge session token, a
 * webhook HMAC, or a MongoDB session, and attaches the unified context to
 * `res.locals.shop_context`.
 *
 * - Invalid/missing signature            -> 401, nothing is persisted
 * - Valid signature but `active === false` -> 403
 * - Origin (MongoDB) failure             -> degrades to `source: "session"`
 *
 * @param {{ requireActive?: boolean }} [options] - `requireActive: false`
 *   skips the 403 inactive gate for compliance webhooks (GDPR customers/shop
 *   redact) that legitimately arrive after uninstallation.
 * @returns {import('express').RequestHandler}
 */
const createShopContextResolver =
  ({ requireActive = true } = {}) =>
  async (req, res, next) => {
    try {
      let shop;
      let origin;
      /** @type {Session | null} */
      let session = null;

      // 1. Webhook HMAC
      if (req.headers["x-shopify-hmac-sha256"]) {
        if (!verifyWebhookHmac(req)) {
          return rejectUnauthorized(res);
        }
        origin = "webhook";
        shop =
          normalizeShop(req.headers["x-shopify-shop-domain"]) ||
          normalizeShop(req.headers["shopify-shop-domain"]) ||
          normalizeShop(req.body?.shop_domain);
        if (!shop) {
          return rejectUnauthorized(res);
        }
        const webhookSession = await sessionHandler.loadSession(
          shopify.session.getOfflineId(shop)
        );
        session = webhookSession ?? null;
      } else {
        // 2. App Bridge session token
        const authHeader = req.headers["authorization"];
        const sessionToken = authHeader?.startsWith("Bearer ")
          ? authHeader.split(" ")[1]
          : undefined;

        if (sessionToken) {
          let payload;
          try {
            payload = validateJWT(sessionToken);
          } catch {
            return rejectUnauthorized(res);
          }

          shop = normalizeShop(payload.dest);
          if (!shop) {
            return rejectUnauthorized(res);
          }
          origin = "token";

          const sessionId = await shopify.session.getCurrentId({
            isOnline: true,
            rawRequest: req,
            rawResponse: res,
          });
          session = (await sessionHandler.loadSession(sessionId)) ?? null;

          const sessionValid =
            session &&
            new Date(session.expires) > new Date() &&
            shopify.config.scopes.equals(session.scope);

          if (!sessionValid) {
            try {
              session = await exchangeToken(shop, sessionToken);
            } catch (error) {
              console.error(
                `---> shopContext token exchange failed for ${shop}: ` +
                  error.message
              );
              return rejectUnauthorized(res);
            }
          }
        } else {
          // 3. MongoDB session fallback (no token/HMAC on the request)
          shop =
            normalizeShop(req.query.shop) ||
            normalizeShop(req.headers["x-shopify-shop-domain"]) ||
            normalizeShop(req.body?.shop_domain);
          if (!shop) {
            return rejectUnauthorized(res);
          }
          origin = "session";
          session =
            (await sessionHandler.loadSession(
              shopify.session.getOfflineId(shop)
            )) ?? null;
          if (!session) {
            return rejectUnauthorized(res);
          }
        }
      }

      const subscription = await resolveSubscription(shop, origin);

      if (
        requireActive &&
        !subscription.degraded &&
        subscription.active !== true
      ) {
        return rejectInactive(res);
      }

      /** @type {ShopContext} */
      const shopContext = {
        shop,
        session,
        plan: subscription.plan,
        active: subscription.active,
        source: subscription.source,
      };

      res.locals.shop_context = shopContext;
      return next();
    } catch (error) {
      console.error(
        `---> An error happened at resolveShopContext middleware: ${error.message}`
      );
      return rejectUnauthorized(res);
    }
  };

/**
 * App Bridge + webhook resolver. Signature failures return 401; valid calls
 * from inactive shops return 403.
 */
const resolveShopContext = createShopContextResolver();

/**
 * GDPR compliance resolver. HMAC is still enforced with 401, but the active
 * gate is skipped because redact/data-request webhooks arrive for uninstalled
 * shops and must always be acknowledged.
 */
const resolveComplianceContext = createShopContextResolver({
  requireActive: false,
});

export { resolveComplianceContext };
export default resolveShopContext;
