import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export interface Ga4Metrics {
  enabled: boolean;
  propertyId: string | null;
  activeUsers7d: number | null;
  activeUsers7dPrevious: number | null;
  eventCounts7d: Record<string, number>;
}

interface RunReportResponse {
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function normalizePrivateKey(key: string): string {
  return key.includes("\\n") && !key.includes("\n") ? key.replace(/\\n/gu, "\n") : key;
}

async function getAccessToken(email: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: email,
      scope: SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(privateKey));
  const jwt = `${signingInput}.${signature}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    throw new Error(`GA4 token exchange failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("GA4 token exchange returned no access_token");
  return body.access_token;
}

async function runReport(
  token: string,
  propertyId: string,
  body: Record<string, unknown>,
): Promise<RunReportResponse> {
  const response = await fetch(`${DATA_API}/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GA4 runReport failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as RunReportResponse;
}

const DISABLED: Ga4Metrics = {
  enabled: false,
  propertyId: null,
  activeUsers7d: null,
  activeUsers7dPrevious: null,
  eventCounts7d: {},
};

export async function collectGa4Metrics(): Promise<Ga4Metrics> {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const email = process.env.GA4_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!propertyId || !email || !rawKey) return DISABLED;

  const privateKey = normalizePrivateKey(rawKey);
  const token = await getAccessToken(email, privateKey);

  const totals = await runReport(token, propertyId, {
    dateRanges: [
      { name: "current", startDate: "7daysAgo", endDate: "yesterday" },
      { name: "previous", startDate: "14daysAgo", endDate: "8daysAgo" },
    ],
    metrics: [{ name: "activeUsers" }],
  });

  let activeUsers7d: number | null = null;
  let activeUsers7dPrevious: number | null = null;
  for (const row of totals.rows ?? []) {
    const rangeName = row.dimensionValues?.[0]?.value;
    const value = Number(row.metricValues?.[0]?.value ?? "0");
    if (rangeName === "current") activeUsers7d = value;
    if (rangeName === "previous") activeUsers7dPrevious = value;
  }

  const byEvent = await runReport(token, propertyId, {
    dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
    limit: "20",
  });

  const eventCounts7d: Record<string, number> = {};
  for (const row of byEvent.rows ?? []) {
    const name = row.dimensionValues?.[0]?.value;
    const value = Number(row.metricValues?.[0]?.value ?? "0");
    if (name) eventCounts7d[name] = value;
  }

  return { enabled: true, propertyId, activeUsers7d, activeUsers7dPrevious, eventCounts7d };
}
