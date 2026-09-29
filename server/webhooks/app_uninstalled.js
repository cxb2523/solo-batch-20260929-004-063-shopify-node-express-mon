import SessionModel from "../../utils/models/SessionModel.js";
import StoreModel from "../../utils/models/StoreModel.js";
import { invalidateShopContext } from "../middleware/shopContext.js";

/**
 * @typedef { import("../../_developer/types/2026-07/webhooks.js").APP_UNINSTALLED } webhookTopic
 */

const appUninstallHandler = async (
  topic,
  shop,
  webhookRequestBody,
  webhookId,
  apiVersion
) => {
  /** @type {webhookTopic} */
  const webhookBody = JSON.parse(webhookRequestBody);
  invalidateShopContext(shop);
  await StoreModel.findOneAndUpdate({ shop }, { isActive: false });
  await SessionModel.deleteMany({ shop });
};

export default appUninstallHandler;
