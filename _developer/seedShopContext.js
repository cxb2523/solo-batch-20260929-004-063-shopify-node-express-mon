// One-off local seed for verifying /debug/shop-context without a real store.
import { Session } from "@shopify/shopify-api";
import mongoose from "mongoose";
import "dotenv/config";
import StoreModel from "../utils/models/StoreModel.js";
import sessionHandler from "../utils/sessionHandler.js";

const shop = "context-test.myshopify.com";

await mongoose.connect(process.env.MONGO_URL);

const session = new Session({
  id: `offline_${shop}`,
  shop,
  state: "seeded",
  isOnline: false,
  accessToken: "shpat_seeded_token",
  scope: "write_app_proxy",
});
await sessionHandler.storeSession(session);

await StoreModel.findOneAndUpdate(
  { shop },
  { isActive: true, plan: "$10.25 plan", planVersion: 1 },
  { upsert: true, new: true }
);

console.log(`--> Seeded session + active store for ${shop}`);
await mongoose.disconnect();
