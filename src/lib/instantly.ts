/**
 * Minimal Instantly v2 API client.
 *
 * Pushes a lead with custom variables into a campaign or list. The dashboard
 * "Send to Instantly" button calls this via a server action.
 *
 * Docs: https://developer.instantly.ai
 */

const BASE = process.env.INSTANTLY_BASE_URL ?? "https://api.instantly.ai";

export type LeadPayload = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName: string;
  campaignId?: string | null;
  listId?: string | null;
  customVariables?: Record<string, string | null | undefined>;
};

export type LeadResult =
  | { ok: true; leadId: string; status: number }
  | { ok: false; error: string; status: number };

function requireApiKey(): string {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) {
    throw new Error(
      "INSTANTLY_API_KEY not set in environment. Add it to .env from app.instantly.ai > Settings > Integrations.",
    );
  }
  return key;
}

function splitName(full: string | null | undefined): {
  first: string | null;
  last: string | null;
} {
  if (!full) return { first: null, last: null };
  const cleaned = full.replace(/^(mr|mrs|ms|miss|mx|dr|prof)\.?\s+/i, "").trim();
  const parts = cleaned.split(/\s+/);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export async function createLead(payload: LeadPayload): Promise<LeadResult> {
  const apiKey = requireApiKey();

  const body: Record<string, unknown> = {
    email: payload.email,
    company_name: payload.companyName,
    custom_variables: cleanVars(payload.customVariables),
  };
  if (payload.firstName) body.first_name = payload.firstName;
  if (payload.lastName) body.last_name = payload.lastName;
  if (payload.campaignId) body.campaign = payload.campaignId;
  if (payload.listId) body.list_id = payload.listId;

  const r = await fetch(`${BASE}/api/v2/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      error: `Instantly returned ${r.status}: ${text.slice(0, 300)}`,
    };
  }

  let leadId = "";
  try {
    const parsed = JSON.parse(text) as { id?: string; lead_id?: string };
    leadId = parsed.id ?? parsed.lead_id ?? "";
  } catch {
    // Some responses are plaintext; fall through with empty id.
  }

  return { ok: true, leadId, status: r.status };
}

function cleanVars(
  vars: Record<string, string | null | undefined> | undefined,
): Record<string, string> {
  if (!vars) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v == null || v === "") continue;
    out[k] = String(v).slice(0, 1000); // avoid pushing massive quotes
  }
  return out;
}

export { splitName };
