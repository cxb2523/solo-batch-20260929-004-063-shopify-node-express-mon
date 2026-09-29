import { Badge, Card, DataTable, Layout, Page, Text } from "@shopify/polaris";
import { navigate } from "raviger";
import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 5000;

const ShopContextDebug = () => {
  const [context, setContext] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    const fetchShopContext = async () => {
      try {
        const response = await fetch("/api/apps/debug/shop-context");
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const data = await response.json();
        if (active) {
          setContext(data);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(err.message);
        }
      }
    };

    fetchShopContext();
    const interval = setInterval(fetchShopContext, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const rows = [
    ["shop", context?.shop ?? "—"],
    ["source", context ? <Badge>{context.source}</Badge> : "—"],
    ["plan", context?.plan ?? "—"],
    [
      "active",
      context ? (
        <Badge tone={context.active ? "success" : "critical"}>
          {String(context.active)}
        </Badge>
      ) : (
        "—"
      ),
    ],
    ["cache hits", context?.cacheHits ?? 0],
  ];

  return (
    <Page
      title="Shop Context"
      subtitle="Resolved by resolveShopContext, polling every 5 seconds"
      backAction={{ content: "Home", onAction: () => navigate("/debug") }}
    >
      <Layout>
        <Layout.Section variant="oneHalf">
          <Card padding="0">
            <DataTable
              columnContentTypes={["text", "text"]}
              headings={["Field", "Value"]}
              rows={rows}
            />
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <Card>
            <Text as="p" tone="subdued">
              First load resolves from the request source; subsequent polls are
              served from the 30 second subscription cache. The cache hits
              counter increments on every cached response for this shop.
            </Text>
            {error ? (
              <Text as="p" tone="critical">
                {error}
              </Text>
            ) : null}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
};

export default ShopContextDebug;
