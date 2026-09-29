import React from "react";
import Index from "./pages/Index";
import BillingAPI from "./pages/debug/Billing";
import GetData from "./pages/debug/Data";
import DebugIndex from "./pages/debug/Index";
import OptionalScopes from "./pages/debug/Scopes";
import ShopContextDebug from "./pages/debug/ShopContext";

const routes = {
  "/": () => <Index />,
  "/debug": () => <DebugIndex />,
  "/debug/scopes": () => <OptionalScopes />,
  "/debug/billing": () => <BillingAPI />,
  "/debug/data": () => <GetData />,
  "/debug/shop-context": () => <ShopContextDebug />,
};

export default routes;
