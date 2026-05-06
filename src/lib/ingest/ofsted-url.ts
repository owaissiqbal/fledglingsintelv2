/**
 * Resolves an Ofsted "find an inspection" legacy URL to the modern
 * reports.ofsted.gov.uk provider page.
 *
 * The legacy host (www.ofsted.gov.uk) has a TLS SAN mismatch and Node's
 * fetch refuses to talk to it; the modern host (reports.ofsted.gov.uk) is
 * happy. The modern URL needs a numeric type code which depends on the
 * institution kind. We try each candidate code in order and return the
 * first that responds 200/206.
 */

import { log } from "./log";

// Mapping institution type → ordered list of Ofsted type codes to try.
// Codes derived empirically from reports.ofsted.gov.uk:
//   23 = Maintained schools (state-funded)
//   21 = Independent schools (Ofsted-side)
//   31 = General Further Education and Tertiary
//   33 = Independent Learning Providers (ITPs)
//   46 = 16-19 academies (standalone post-16)
const TYPE_CANDIDATES: Record<string, number[]> = {
  state_school: [23, 46],
  independent_school: [21, 23],
  sixth_form_college: [46, 31, 23],
  fe_college: [31, 33, 46],
  itp: [33, 31],
  other: [23, 31, 33, 46, 21],
};

const PROBE_USER_AGENT =
  process.env.USER_AGENT ??
  "Fledglings-ICP-Bot/1.0 (internal tooling; replace USER_AGENT in .env)";

const cache = new Map<string, string | null>();

function extractUrn(url: string): string | null {
  // Match /provider/<CODE>/<URN> or .../provider/<URN> or trailing /<URN>
  const m = url.match(/\/provider\/[^/]+\/(\d{4,8})/i);
  if (m) return m[1];
  const tail = url.match(/\/(\d{4,8})(?:[/?#]|$)/);
  return tail ? tail[1] : null;
}

function isLegacyOfsted(url: string): boolean {
  return /^https?:\/\/www\.ofsted\.gov\.uk\//i.test(url);
}

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0", "User-Agent": PROBE_USER_AGENT },
      redirect: "follow",
    });
    if (r.status === 200 || r.status === 206) {
      await r.arrayBuffer();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function resolveReportUrl(
  rawUrl: string,
  institutionType: string,
): Promise<string | null> {
  if (cache.has(rawUrl)) return cache.get(rawUrl)!;

  if (!isLegacyOfsted(rawUrl)) {
    cache.set(rawUrl, rawUrl);
    return rawUrl;
  }

  const urn = extractUrn(rawUrl);
  if (!urn) {
    log.debug(`url: cannot extract URN from ${rawUrl}`);
    cache.set(rawUrl, null);
    return null;
  }

  // Fast path: pick the highest-likelihood type code for the institution
  // and return immediately. Probing every candidate over the network is
  // expensive AND triggers bot-detection on reports.ofsted.gov.uk. If the
  // chosen URL turns out to be wrong, fetchToFile will surface a 403/404
  // and fall back to its on-disk cache from a prior successful run.
  const candidates = TYPE_CANDIDATES[institutionType] ?? TYPE_CANDIDATES.other;
  const best = candidates[0];
  const url = `https://reports.ofsted.gov.uk/provider/${best}/${urn}`;
  cache.set(rawUrl, url);
  return url;
}
