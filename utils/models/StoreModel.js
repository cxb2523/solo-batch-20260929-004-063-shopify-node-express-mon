import mongoose from "mongoose";

const StoreSchema = new mongoose.Schema({
  shop: { type: String, required: true, unique: true },
  isActive: { type: Boolean, required: true, default: false },
  plan: { type: String, required: true, default: "free" },
  planVersion: { type: Number, required: true, default: 0 },
});

const StoreModel = mongoose.model("Active_Stores", StoreSchema);

export default StoreModel;
