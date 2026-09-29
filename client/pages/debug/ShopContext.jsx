import {
  Badge,
  BlockStack,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { navigate } from "raviger";
import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 5000;

const ShopContextRow = ({ label, value }) => (
  <InlineStack align="space-between">
    <Text as="span" variant="headingMd">
      {label}
    </Text>
    <Text as="span">{value ?? "—"}</Text>
  </InlineStack>
);

const ShopContextDebug = () => {
  const [context, setContext] = useState(null);
  const [error, setError] = useState("");

  const fetchContext = async () => {
    try {
      const shop = new URLSearchParams(window.location.search).get("shop");
      const url = shop
        ? `/api/apps/debug/shopContext?shop=${encodeURIComponent(shop)}`
        : "/api/apps/debug/shopContext";
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setError("");
        setContext(data);
      }
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => {
    fetchContext();
    const timer = setInterval(fetchContext, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Page
      title="Shop Context"
      subtitle="Live view of resolveShopContext, polling every 5 seconds"
      backAction={{ content: "Debug", onAction: () => navigate("/debug") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              {error && <Text tone="critical">{error}</Text>}
              {!context && !error && <Text>loading...</Text>}
              {context && (
                <>
                  <ShopContextRow label="shop" value={context.shop} />
                  <ShopContextRow
                    label="source"
                    value={
                      <Badge
                        tone={
                          context.source === "session" ? "attention" : "info"
                        }
                      >
                        {context.source}
                      </Badge>
                    }
                  />
                  <ShopContextRow
                    label="plan"
                    value={context.plan ?? "No Plan"}
                  />
                  <ShopContextRow
                    label="active"
                    value={
                      <Badge tone={context.active ? "success" : "critical"}>
                        {`${context.active}`}
                      </Badge>
                    }
                  />
                  <ShopContextRow
                    label="cache hits"
                    value={context.cacheHits}
                  />
                  <ShopContextRow
                    label="cache misses"
                    value={context.cacheMisses}
                  />
                  <ShopContextRow
                    label="origin fetches"
                    value={context.originFetches}
                  />
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
};

export default ShopContextDebug;
