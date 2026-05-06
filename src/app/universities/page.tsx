/**
 * /universities — separate cohort of HE providers delivering apprenticeships.
 *
 * Universities aren't inspected by Ofsted (Office for Students looks after
 * HE), so the urgency story for them is news-driven: leadership scandals,
 * strikes, financial difficulties, safeguarding incidents. We surface:
 *   - All 107 universities, sorted by size (apprenticeship-standards count)
 *   - Compliance feed (Companies House, gov.uk Atom) when active
 *   - News feed — high-trigger articles
 */

import Link from "next/link";
import { client } from "@/db";

export const dynamic = "force-dynamic";

const CURRICULUM_LABELS: Record<string, string> = {
  financial_literacy: "Financial Literacy",
  employability_skills: "Employability Skills",
  confidence_resilience: "Confidence & Resilience",
  online_safety: "Online Safety",
};

type UniRow = {
  id: number;
  name: string;
  ukprn: string | null;
  postcode: string | null;
  general_email: string | null;
  apprenticeship_standards: number | null;
  tier: string | null;
  score: number | null;
  urgency_score: number | null;
  pipeline_value_score: number | null;
  top_curriculum: string | null;
  critical_signals: string | null;
};

async function loadHeadline() {
  const universe = await client.execute(
    `SELECT COUNT(*) AS n FROM institutions WHERE type='university' AND in_scope=1`,
  );
  const tiers = await client.execute(`
    SELECT os.tier, COUNT(*) AS n
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.type='university' AND i.in_scope=1
    GROUP BY os.tier
  `);
  const tierMap: Record<string, number> = {
    critical: 0, high: 0, worth_a_look: 0, skip: 0,
  };
  for (const row of tiers.rows as unknown as { tier: string; n: number }[]) {
    if (row.tier && row.tier in tierMap) tierMap[row.tier] = row.n;
  }
  const compliance = await client.execute(`
    SELECT COUNT(DISTINCT cn.institution_id) AS n
    FROM compliance_notices cn
    JOIN institutions i ON i.id = cn.institution_id
    WHERE i.type='university' AND cn.withdrawn_at IS NULL
  `);
  const newsTrigger = await client.execute(`
    SELECT COUNT(DISTINCT n.institution_id) AS n
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE i.type='university' AND n.trigger_severity >= 70 AND n.relevance >= 60
  `);
  const withEmail = await client.execute(`
    SELECT COUNT(*) AS n FROM institutions
    WHERE type='university' AND in_scope=1
      AND (general_email IS NOT NULL OR head_email IS NOT NULL)
  `);
  const totalStandards = await client.execute(`
    SELECT SUM(apprenticeship_standards) AS n FROM institutions
    WHERE type='university' AND in_scope=1
  `);
  return {
    total: (universe.rows[0] as unknown as { n: number }).n,
    tiers: tierMap,
    activeCompliance: (compliance.rows[0] as unknown as { n: number }).n,
    activeNewsTrigger: (newsTrigger.rows[0] as unknown as { n: number }).n,
    withEmail: (withEmail.rows[0] as unknown as { n: number }).n,
    totalStandards: (totalStandards.rows[0] as unknown as { n: number }).n,
  };
}

async function loadAllUniversities(): Promise<UniRow[]> {
  // All 107 — universities are a small enough universe to render in one
  // table without pagination.
  const r = await client.execute(`
    SELECT
      i.id, i.name, i.ukprn, i.postcode, i.general_email, i.apprenticeship_standards,
      os.tier, os.score, os.urgency_score, os.pipeline_value_score,
      os.top_curriculum, os.critical_signals
    FROM institutions i
    LEFT JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.type='university' AND i.in_scope=1
    ORDER BY i.apprenticeship_standards DESC NULLS LAST, i.name
  `);
  return r.rows as unknown as UniRow[];
}

async function loadComplianceFeed() {
  const r = await client.execute(`
    SELECT i.id, i.name, cn.notice_body, cn.notice_type,
           cn.severity, cn.subject, cn.issued_at, cn.source_url
    FROM compliance_notices cn
    JOIN institutions i ON i.id = cn.institution_id
    WHERE i.type='university' AND cn.withdrawn_at IS NULL
    ORDER BY cn.severity DESC
    LIMIT 10
  `);
  return r.rows as unknown as {
    id: number;
    name: string;
    notice_body: string;
    notice_type: string;
    severity: number;
    subject: string;
    issued_at: string | null;
    source_url: string;
  }[];
}

async function loadNewsFeed() {
  const r = await client.execute(`
    SELECT i.id, i.name, n.title, n.angle, n.trigger_severity, n.relevance,
           n.curricula_tagged, n.published_at, n.url, n.source
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE i.type='university'
      AND n.trigger_severity >= 50
      AND n.relevance >= 50
    ORDER BY n.trigger_severity DESC, n.published_at DESC NULLS LAST
    LIMIT 15
  `);
  return r.rows as unknown as {
    id: number;
    name: string;
    title: string;
    angle: string | null;
    trigger_severity: number;
    relevance: number;
    curricula_tagged: string | null;
    published_at: string | null;
    url: string;
    source: string;
  }[];
}

function severityBand(s: number): string {
  if (s >= 90) return "bg-red-600 text-white";
  if (s >= 70) return "bg-orange-500 text-white";
  if (s >= 50) return "bg-amber-300 text-slate-900";
  return "bg-slate-200 text-slate-700";
}

function StatTile({ label, value, sub, accent = "bg-fl-blue" }: {
  label: string; value: number | string; sub?: string; accent?: string;
}) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full ${accent}`} aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">
        {value}
      </div>
      {sub && <div className="mt-1 text-sm text-slate-500">{sub}</div>}
    </div>
  );
}

export default async function UniversitiesDashboard() {
  const [headline, all, compliance, news] = await Promise.all([
    loadHeadline(),
    loadAllUniversities(),
    loadComplianceFeed(),
    loadNewsFeed(),
  ]);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="container mx-auto max-w-7xl px-6 py-8">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Universities
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              UK universities delivering apprenticeships. Not Ofsted-inspected
              (HE is regulated by the Office for Students), so the urgency
              signal is news + compliance + size-by-standards.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/opportunities?type=university"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Browse all →
            </Link>
            <a
              href="/opportunities/export?type=university"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Download CSV
            </a>
          </div>
        </header>

        <section className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <StatTile
            label="Universities"
            value={headline.total.toLocaleString()}
            sub={`${headline.withEmail.toLocaleString()} with contact email`}
            accent="bg-fl-navy"
          />
          <StatTile
            label="Total standards delivered"
            value={(headline.totalStandards ?? 0).toLocaleString()}
            sub="Across all 107 unis"
            accent="bg-fl-blue"
          />
          <StatTile
            label="Active compliance"
            value={headline.activeCompliance.toLocaleString()}
            accent="bg-fl-mango"
          />
          <StatTile
            label="News-flagged"
            value={headline.activeNewsTrigger.toLocaleString()}
            sub="Severity ≥ 70 in last pass"
            accent="bg-fl-orange"
          />
          <StatTile
            label="In high tiers"
            value={(headline.tiers.critical + headline.tiers.high).toLocaleString()}
            sub={`${headline.tiers.worth_a_look} worth a look · ${headline.tiers.skip} skip`}
            accent="bg-red-500"
          />
        </section>

        {(compliance.length > 0 || news.length > 0) && (
          <div className="mb-10 grid gap-6 lg:grid-cols-2">
            {compliance.length > 0 && (
              <section>
                <h2 className="mb-4 text-lg font-semibold text-slate-900">
                  Compliance feed
                </h2>
                <ul className="space-y-3">
                  {compliance.map((c, i) => (
                    <li key={i} className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/opportunities/${c.id}`} className="font-medium text-slate-900 hover:underline">
                          {c.name}
                        </Link>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${severityBand(c.severity)}`}>
                          {c.severity}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {c.notice_body} · {c.notice_type}
                        {c.issued_at && <> · {c.issued_at}</>}
                      </div>
                      <div className="mt-2 text-sm text-slate-700">{c.subject}</div>
                      <a href={c.source_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-fl-blue hover:underline">
                        Source →
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {news.length > 0 && (
              <section>
                <h2 className="mb-4 text-lg font-semibold text-slate-900">News feed</h2>
                <ul className="space-y-3">
                  {news.map((n, i) => (
                    <li key={i} className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/opportunities/${n.id}`} className="font-medium text-slate-900 hover:underline">
                          {n.name}
                        </Link>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${severityBand(n.trigger_severity)}`}>
                          {n.trigger_severity}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {n.source}
                        {n.published_at && <> · {n.published_at}</>}
                        {n.curricula_tagged && (
                          <> · {n.curricula_tagged.split(",").map((c) => CURRICULUM_LABELS[c.trim()] ?? c).join(", ")}</>
                        )}
                      </div>
                      <div className="mt-2 text-sm font-medium text-slate-900 line-clamp-2">{n.title}</div>
                      {n.angle && n.angle !== "no angle" && (
                        <div className="mt-1 text-xs italic text-slate-600 line-clamp-2">{n.angle}</div>
                      )}
                      <a href={n.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-fl-blue hover:underline">
                        Read article →
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        <section className="mb-10">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">
            All universities · {headline.total}
          </h2>
          <p className="mb-4 text-sm text-slate-600">
            Sorted by apprenticeship-standards count (size proxy). University
            of Derby leads with 72 standards.
          </p>
          <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">University</th>
                  <th className="px-4 py-3">Standards</th>
                  <th className="px-4 py-3">UKPRN</th>
                  <th className="px-4 py-3">Tier</th>
                  <th className="px-4 py-3">Pipeline</th>
                  <th className="px-4 py-3">Lead with</th>
                </tr>
              </thead>
              <tbody>
                {all.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/opportunities/${r.id}`} className="font-medium text-fl-navy hover:underline">
                        {r.name}
                      </Link>
                      {r.postcode && <div className="text-xs text-slate-500">{r.postcode}</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-slate-900">
                      {r.apprenticeship_standards ?? 0}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {r.ukprn}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`inline-block rounded px-1.5 py-0.5 font-semibold ${
                        r.tier === "critical"
                          ? "bg-red-600 text-white"
                          : r.tier === "high"
                            ? "bg-orange-500 text-white"
                            : r.tier === "worth_a_look"
                              ? "bg-amber-200 text-slate-900"
                              : "bg-slate-200 text-slate-600"
                      }`}>
                        {r.tier ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${severityBand(r.pipeline_value_score ?? 0)}`}>
                        {r.pipeline_value_score ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.top_curriculum
                        ? CURRICULUM_LABELS[r.top_curriculum] ?? r.top_curriculum
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
