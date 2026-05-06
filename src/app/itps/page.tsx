/**
 * /itps — ITP-focused dashboard.
 *
 * The user's primary lens. Surfaces the three signal sources in one place:
 *   1. Ofsted urgency (RI/Inadequate inspections in last 12-24 months)
 *   2. Compliance / regulatory (active APAR restrictions, Companies House
 *      financial-health flags, ESFA Notices to Improve for FE)
 *   3. News (Claude-extracted high-trigger articles in last 6 months)
 *
 * Each block links into /opportunities pre-filtered so sales can drill in.
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

type ItpRow = {
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
  latest_grade: string | null;
  latest_inspection_date: string | null;
};

type CountRow = { n: number };

async function loadHeadline() {
  const universe = await client.execute(
    `SELECT COUNT(*) AS n FROM institutions WHERE type='itp' AND in_scope=1`,
  );
  const tiers = await client.execute(`
    SELECT os.tier, COUNT(*) AS n
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    WHERE i.type='itp' AND i.in_scope=1
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
    WHERE i.type='itp' AND cn.withdrawn_at IS NULL
  `);
  const recentInsp = await client.execute(`
    SELECT COUNT(DISTINCT i.id) AS n
    FROM institutions i
    JOIN inspections insp ON insp.institution_id = i.id
    WHERE i.type='itp'
      AND insp.publication_date >= date('now','-12 months')
      AND insp.overall_grade IN ('requires_improvement','inadequate')
  `);
  const newsTrigger = await client.execute(`
    SELECT COUNT(DISTINCT n.institution_id) AS n
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE i.type='itp'
      AND n.trigger_severity >= 70
      AND n.relevance >= 60
  `);
  const withEmail = await client.execute(`
    SELECT COUNT(*) AS n
    FROM institutions
    WHERE type='itp' AND in_scope=1
      AND (general_email IS NOT NULL OR head_email IS NOT NULL)
  `);
  return {
    total: (universe.rows[0] as unknown as CountRow).n,
    tiers: tierMap,
    activeCompliance: (compliance.rows[0] as unknown as CountRow).n,
    recentRiInadequate: (recentInsp.rows[0] as unknown as CountRow).n,
    activeNewsTrigger: (newsTrigger.rows[0] as unknown as CountRow).n,
    withEmail: (withEmail.rows[0] as unknown as CountRow).n,
  };
}

async function loadCriticalItps(): Promise<ItpRow[]> {
  const r = await client.execute(`
    SELECT
      i.id, i.name, i.ukprn, i.postcode, i.general_email, i.apprenticeship_standards,
      os.tier, os.score, os.urgency_score, os.pipeline_value_score,
      os.top_curriculum, os.critical_signals,
      latest.overall_grade AS latest_grade,
      latest.inspection_start_date AS latest_inspection_date
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    LEFT JOIN (
      SELECT institution_id, overall_grade, inspection_start_date,
             ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
      FROM inspections
    ) latest ON latest.institution_id = i.id AND latest.rn = 1
    WHERE i.type='itp' AND i.in_scope=1 AND os.tier='critical'
    ORDER BY os.urgency_score DESC, os.score DESC
  `);
  return r.rows as unknown as ItpRow[];
}

async function loadTopHighItps(limit = 30): Promise<ItpRow[]> {
  const r = await client.execute({
    sql: `SELECT
            i.id, i.name, i.ukprn, i.postcode, i.general_email, i.apprenticeship_standards,
            os.tier, os.score, os.urgency_score, os.pipeline_value_score,
            os.top_curriculum, os.critical_signals,
            latest.overall_grade AS latest_grade,
            latest.inspection_start_date AS latest_inspection_date
          FROM institutions i
          JOIN opportunity_scores os ON os.institution_id = i.id
          LEFT JOIN (
            SELECT institution_id, overall_grade, inspection_start_date,
                   ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
            FROM inspections
          ) latest ON latest.institution_id = i.id AND latest.rn = 1
          WHERE i.type='itp' AND i.in_scope=1 AND os.tier='high'
          ORDER BY os.urgency_score DESC, os.score DESC
          LIMIT ?`,
    args: [limit],
  });
  return r.rows as unknown as ItpRow[];
}

async function loadOutstandingItps(): Promise<ItpRow[]> {
  // Only "outstanding" graded ITPs whose latest inspection awarded that
  // grade. Sales-relevance: these are the providers Fledglings would be
  // compared against / could partner with for case studies.
  const r = await client.execute(`
    SELECT
      i.id, i.name, i.ukprn, i.postcode, i.general_email, i.apprenticeship_standards,
      os.tier, os.score, os.urgency_score, os.pipeline_value_score,
      os.top_curriculum, os.critical_signals,
      latest.overall_grade AS latest_grade,
      latest.inspection_start_date AS latest_inspection_date
    FROM institutions i
    JOIN opportunity_scores os ON os.institution_id = i.id
    JOIN (
      SELECT institution_id, overall_grade, inspection_start_date,
             ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
      FROM inspections
    ) latest ON latest.institution_id = i.id AND latest.rn = 1
    WHERE i.type='itp' AND i.in_scope=1 AND latest.overall_grade='outstanding'
    ORDER BY latest.inspection_start_date DESC
    LIMIT 20
  `);
  return r.rows as unknown as ItpRow[];
}

async function loadAllItps(): Promise<ItpRow[]> {
  // The full universe — every in-scope ITP, sorted by urgency then size.
  // 1,669 rows render fine in a single table; sticky header keeps it
  // navigable.
  const r = await client.execute(`
    SELECT
      i.id, i.name, i.ukprn, i.postcode, i.general_email, i.apprenticeship_standards,
      os.tier, os.score, os.urgency_score, os.pipeline_value_score,
      os.top_curriculum, os.critical_signals,
      latest.overall_grade AS latest_grade,
      latest.inspection_start_date AS latest_inspection_date
    FROM institutions i
    LEFT JOIN opportunity_scores os ON os.institution_id = i.id
    LEFT JOIN (
      SELECT institution_id, overall_grade, inspection_start_date,
             ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
      FROM inspections
    ) latest ON latest.institution_id = i.id AND latest.rn = 1
    WHERE i.type='itp' AND i.in_scope=1
    ORDER BY
      CASE WHEN os.tier = 'critical' THEN 0
           WHEN os.tier = 'high' THEN 1
           WHEN os.tier = 'worth_a_look' THEN 2
           WHEN os.tier = 'skip' THEN 3
           ELSE 4 END,
      COALESCE(os.urgency_score, 0) DESC,
      COALESCE(os.score, 0) DESC,
      COALESCE(i.apprenticeship_standards, 0) DESC,
      i.name
  `);
  return r.rows as unknown as ItpRow[];
}

async function loadMajorProviders(limit = 25): Promise<ItpRow[]> {
  // Largest providers by apprenticeship-standards count. These are the
  // household-name ITPs (Lifetime, BPP, QA, HIT, Multiverse, etc.) that
  // are pipeline-fit even when they're not in the news.
  const r = await client.execute({
    sql: `SELECT
            i.id, i.name, i.ukprn, i.postcode, i.general_email, i.apprenticeship_standards,
            os.tier, os.score, os.urgency_score, os.pipeline_value_score,
            os.top_curriculum, os.critical_signals,
            latest.overall_grade AS latest_grade,
            latest.inspection_start_date AS latest_inspection_date
          FROM institutions i
          JOIN opportunity_scores os ON os.institution_id = i.id
          LEFT JOIN (
            SELECT institution_id, overall_grade, inspection_start_date,
                   ROW_NUMBER() OVER (PARTITION BY institution_id ORDER BY inspection_start_date DESC) AS rn
            FROM inspections
          ) latest ON latest.institution_id = i.id AND latest.rn = 1
          WHERE i.type='itp' AND i.in_scope=1
          ORDER BY i.apprenticeship_standards DESC NULLS LAST
          LIMIT ?`,
    args: [limit],
  });
  return r.rows as unknown as ItpRow[];
}

async function loadComplianceFeed() {
  const r = await client.execute(`
    SELECT i.id, i.name, i.ukprn,
           cn.notice_body, cn.notice_type, cn.severity, cn.subject, cn.issued_at,
           cn.source_url
    FROM compliance_notices cn
    JOIN institutions i ON i.id = cn.institution_id
    WHERE i.type='itp' AND cn.withdrawn_at IS NULL
    ORDER BY cn.severity DESC, cn.issued_at DESC NULLS LAST
    LIMIT 20
  `);
  return r.rows as unknown as {
    id: number;
    name: string;
    ukprn: string | null;
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
    SELECT i.id, i.name, i.ukprn,
           n.title, n.angle, n.trigger_severity, n.relevance,
           n.curricula_tagged, n.published_at, n.url, n.source
    FROM news_items n
    JOIN institutions i ON i.id = n.institution_id
    WHERE i.type='itp'
      AND n.trigger_severity >= 50
      AND n.relevance >= 50
    ORDER BY n.trigger_severity DESC, n.published_at DESC NULLS LAST
    LIMIT 20
  `);
  return r.rows as unknown as {
    id: number;
    name: string;
    ukprn: string | null;
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

function gradeColour(g: string | null): string {
  switch (g) {
    case "outstanding":
      return "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-300";
    case "good":
      return "bg-sky-100 text-sky-900 ring-1 ring-sky-300";
    case "requires_improvement":
      return "bg-amber-100 text-amber-900 ring-1 ring-amber-300";
    case "inadequate":
      return "bg-red-100 text-red-900 ring-1 ring-red-300";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-300";
  }
}

function gradeLabel(g: string | null): string {
  if (!g) return "—";
  return g
    .split("_")
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(" ");
}

function severityBand(s: number): string {
  if (s >= 90) return "bg-red-600 text-white";
  if (s >= 70) return "bg-orange-500 text-white";
  if (s >= 50) return "bg-amber-300 text-slate-900";
  return "bg-slate-200 text-slate-700";
}

function StatTile({
  label,
  value,
  sub,
  href,
  accent = "bg-fl-blue",
}: {
  label: string;
  value: number | string;
  sub?: string;
  href?: string;
  accent?: string;
}) {
  const inner = (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-slate-300">
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
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default async function ItpsDashboard() {
  const [
    headline,
    criticalRows,
    highRows,
    outstandingRows,
    majorRows,
    compliance,
    news,
    allItps,
  ] = await Promise.all([
    loadHeadline(),
    loadCriticalItps(),
    loadTopHighItps(30),
    loadOutstandingItps(),
    loadMajorProviders(25),
    loadComplianceFeed(),
    loadNewsFeed(),
    loadAllItps(),
  ]);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="container mx-auto max-w-7xl px-6 py-8">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              ITP intelligence
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              UK Independent Training Providers in the Fledglings universe — Ofsted, ESFA / Companies House compliance,
              and Claude-extracted news triggers.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/opportunities?type=itp"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Browse all ITPs →
            </Link>
            <a
              href="/opportunities/export?type=itp"
              className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Download CSV
            </a>
          </div>
        </header>

        <section className="mb-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <StatTile
            label="ITPs in universe"
            value={headline.total.toLocaleString()}
            sub={`${headline.withEmail.toLocaleString()} with contact email`}
            href="/opportunities?type=itp"
            accent="bg-fl-navy"
          />
          <StatTile
            label="Critical (act now)"
            value={headline.tiers.critical.toLocaleString()}
            sub="Real urgency trigger"
            href="/opportunities?type=itp&tier=critical"
            accent="bg-red-500"
          />
          <StatTile
            label="High"
            value={headline.tiers.high.toLocaleString()}
            sub="Strong prospect, signal"
            href="/opportunities?type=itp&tier=high"
            accent="bg-orange-500"
          />
          <StatTile
            label="Worth a look"
            value={headline.tiers.worth_a_look.toLocaleString()}
            sub="Universe-fit, no trigger"
            href="/opportunities?type=itp&tier=worth_a_look"
            accent="bg-amber-300"
          />
          <StatTile
            label="Active compliance"
            value={headline.activeCompliance.toLocaleString()}
            sub="ITPs with open notice"
            accent="bg-fl-mango"
          />
          <StatTile
            label="News-flagged ITPs"
            value={headline.activeNewsTrigger.toLocaleString()}
            sub="Severity ≥ 70 in last pass"
            accent="bg-fl-orange"
          />
        </section>

        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">
            Critical ITPs — act this week
          </h2>
          <p className="mb-4 text-sm text-slate-600">
            These ITPs combine a real-time trigger (Ofsted RI/Inadequate, APAR
            restriction, financial NTI, or high-severity news story) with strong
            buyer-fit. Click through to the opportunity detail and the polished email.
          </p>
          {criticalRows.length === 0 ? (
            <div className="rounded-xl bg-white p-6 text-sm text-slate-500 ring-1 ring-slate-200">
              No critical ITPs right now.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Latest Ofsted</th>
                    <th className="px-4 py-3">Lead with</th>
                    <th className="px-4 py-3">Score</th>
                    <th className="px-4 py-3">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {criticalRows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t border-slate-100 align-top hover:bg-slate-50"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/opportunities/${r.id}`}
                          className="font-medium text-fl-navy hover:underline"
                        >
                          {r.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          {r.ukprn && <span>UKPRN {r.ukprn}</span>}
                          {r.postcode && <span>{r.postcode}</span>}
                          {r.apprenticeship_standards ? (
                            <span>{r.apprenticeship_standards} standards</span>
                          ) : null}
                          {r.general_email && (
                            <span className="text-emerald-700">✉ contactable</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {r.latest_grade ? (
                          <span
                            className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${gradeColour(r.latest_grade)}`}
                          >
                            {gradeLabel(r.latest_grade)}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">no inspection</span>
                        )}
                        {r.latest_inspection_date && (
                          <div className="mt-1 text-xs text-slate-500">
                            {r.latest_inspection_date}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {r.top_curriculum
                          ? CURRICULUM_LABELS[r.top_curriculum] ?? r.top_curriculum
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${severityBand(r.score ?? 0)}`}
                        >
                          {r.score}
                        </span>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                          U{r.urgency_score} · P{r.pipeline_value_score}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {(r.critical_signals ?? "")
                          .split(" · ")
                          .filter((s) => s)
                          .slice(0, 3)
                          .map((s, i) => (
                            <div key={i} className="line-clamp-1">{s}</div>
                          ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="mb-10 grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-4 text-lg font-semibold text-slate-900">
              Compliance feed
            </h2>
            {compliance.length === 0 ? (
              <div className="rounded-xl bg-white p-6 text-sm text-slate-500 ring-1 ring-slate-200">
                No active compliance notices for ITPs.
              </div>
            ) : (
              <ul className="space-y-3">
                {compliance.map((c, i) => (
                  <li
                    key={i}
                    className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/opportunities/${c.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {c.name}
                      </Link>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${severityBand(c.severity)}`}
                      >
                        {c.severity}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {c.notice_body} · {c.notice_type}
                      {c.issued_at && <> · issued {c.issued_at}</>}
                    </div>
                    <div className="mt-2 text-sm text-slate-700">{c.subject}</div>
                    <a
                      href={c.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-xs text-fl-blue hover:underline"
                    >
                      Source →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-4 text-lg font-semibold text-slate-900">News feed</h2>
            {news.length === 0 ? (
              <div className="rounded-xl bg-white p-6 text-sm text-slate-500 ring-1 ring-slate-200">
                No high-trigger news matched to ITPs yet. Run{" "}
                <code className="rounded bg-slate-100 px-1">pnpm ingest --only=news_trade,news_google,news_extract</code>.
              </div>
            ) : (
              <ul className="space-y-3">
                {news.map((n, i) => (
                  <li
                    key={i}
                    className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/opportunities/${n.id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {n.name}
                      </Link>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${severityBand(n.trigger_severity)}`}
                      >
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
                    <div className="mt-2 text-sm font-medium text-slate-900 line-clamp-2">
                      {n.title}
                    </div>
                    {n.angle && n.angle !== "no angle" && (
                      <div className="mt-1 text-xs text-slate-600 italic line-clamp-2">
                        {n.angle}
                      </div>
                    )}
                    <a
                      href={n.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-xs text-fl-blue hover:underline"
                    >
                      Read article →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-slate-900">
            High-tier ITPs ({headline.tiers.high.toLocaleString()})
          </h2>
          <p className="mb-4 text-sm text-slate-600">
            Showing top 30 by urgency. Strong buyer fit with at least one
            real signal — these are next-quarter pipeline.
          </p>
          {highRows.length === 0 ? (
            <div className="rounded-xl bg-white p-6 text-sm text-slate-500 ring-1 ring-slate-200">
              No high-tier ITPs.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Latest Ofsted</th>
                    <th className="px-4 py-3">Lead with</th>
                    <th className="px-4 py-3">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {highRows.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/opportunities/${r.id}`}
                          className="font-medium text-fl-navy hover:underline"
                        >
                          {r.name}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {r.ukprn && `UKPRN ${r.ukprn} · `}
                          {r.postcode}
                          {r.apprenticeship_standards ? ` · ${r.apprenticeship_standards} standards` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${gradeColour(r.latest_grade)}`}
                        >
                          {gradeLabel(r.latest_grade)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {r.top_curriculum
                          ? CURRICULUM_LABELS[r.top_curriculum] ?? r.top_curriculum
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span className={`rounded px-1.5 py-0.5 font-semibold ${severityBand(r.score ?? 0)}`}>
                          {r.score}
                        </span>
                        <span className="ml-2 text-slate-400">
                          U{r.urgency_score} · P{r.pipeline_value_score}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 text-right">
            <Link
              href="/opportunities?type=itp&tier=high"
              className="text-sm text-fl-blue hover:underline"
            >
              See all {headline.tiers.high.toLocaleString()} high-tier ITPs →
            </Link>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">
            Major providers — top 25 by apprenticeship-standards count
          </h2>
          <p className="mb-4 text-sm text-slate-600">
            The household-name ITPs. Lifetime, BPP, QA, HIT, Multiverse,
            Babcock, Kaplan and friends. These appear regardless of tier — size
            alone makes them strategic accounts.
          </p>
          <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Standards</th>
                  <th className="px-4 py-3">Latest Ofsted</th>
                  <th className="px-4 py-3">Tier</th>
                  <th className="px-4 py-3">Score</th>
                </tr>
              </thead>
              <tbody>
                {majorRows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/opportunities/${r.id}`}
                        className="font-medium text-fl-navy hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.postcode && (
                        <div className="text-xs text-slate-500">{r.postcode}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm font-semibold text-slate-900">
                        {r.apprenticeship_standards}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${gradeColour(r.latest_grade)}`}
                      >
                        {gradeLabel(r.latest_grade)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 font-semibold ${
                          r.tier === "critical"
                            ? "bg-red-600 text-white"
                            : r.tier === "high"
                              ? "bg-orange-500 text-white"
                              : r.tier === "worth_a_look"
                                ? "bg-amber-200 text-slate-900"
                                : "bg-slate-200 text-slate-600"
                        }`}
                      >
                        {r.tier ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${severityBand(r.score ?? 0)}`}>
                        {r.score}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {outstandingRows.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-2 text-lg font-semibold text-slate-900">
              Outstanding-rated ITPs · {outstandingRows.length}
            </h2>
            <p className="mb-4 text-sm text-slate-600">
              The providers Ofsted's just rated Outstanding. Useful for
              competitive intelligence and partnership outreach — they're not
              in trouble, but they're benchmarks.
            </p>
            <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Standards</th>
                    <th className="px-4 py-3">Inspected</th>
                    <th className="px-4 py-3">Pipeline</th>
                  </tr>
                </thead>
                <tbody>
                  {outstandingRows.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/opportunities/${r.id}`}
                          className="font-medium text-fl-navy hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.postcode && (
                          <div className="text-xs text-slate-500">{r.postcode}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-sm text-slate-900">
                        {r.apprenticeship_standards ?? 0}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        <span className="inline-block rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 ring-1 ring-emerald-300">
                          🟢 Outstanding
                        </span>
                        <div className="mt-1 text-slate-500">
                          {r.latest_inspection_date}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span
                          className={`rounded px-1.5 py-0.5 font-semibold ${severityBand(r.pipeline_value_score ?? 0)}`}
                        >
                          {r.pipeline_value_score}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="mb-6 rounded-xl bg-fl-navy/5 p-6 ring-1 ring-fl-navy/10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Universities (107)
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Universities delivering apprenticeships are now tracked
                separately. Same data plumbing, different cohort.
              </p>
            </div>
            <Link
              href="/universities"
              className="rounded-md bg-fl-navy px-4 py-2 text-sm font-medium text-white hover:bg-fl-navy/90"
            >
              Open universities →
            </Link>
          </div>
        </section>

        <section className="mb-10">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                All ITPs · {allItps.length.toLocaleString()}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Every in-scope ITP. Sorted by tier (critical → skip), then
                urgency, then size. Use Ctrl+F to find a specific provider.
              </p>
            </div>
            <form action="/opportunities" method="get" className="flex items-center gap-2">
              <input type="hidden" name="type" value="itp" />
              <input
                type="search"
                name="q"
                placeholder="Search any ITP by name…"
                className="w-72 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-fl-orange focus:outline-none"
              />
              <button
                type="submit"
                className="rounded-md bg-fl-orange px-3 py-2 text-sm font-medium text-white hover:bg-fl-orange/90"
              >
                Search
              </button>
            </form>
          </div>
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2.5">Provider</th>
                  <th className="px-3 py-2.5">UKPRN</th>
                  <th className="px-3 py-2.5">Std</th>
                  <th className="px-3 py-2.5">Latest grade</th>
                  <th className="px-3 py-2.5">Tier</th>
                  <th className="px-3 py-2.5">Score</th>
                  <th className="px-3 py-2.5">U / P</th>
                  <th className="px-3 py-2.5">Lead</th>
                </tr>
              </thead>
              <tbody>
                {allItps.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-t border-slate-100 hover:bg-slate-50 ${
                      r.tier === "critical" ? "bg-red-50/30" : r.tier === "high" ? "bg-orange-50/20" : ""
                    }`}
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/opportunities/${r.id}`}
                        className="font-medium text-fl-navy hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.postcode && (
                        <div className="text-[11px] text-slate-500">{r.postcode}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{r.ukprn}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">
                      {r.apprenticeship_standards ?? 0}
                    </td>
                    <td className="px-3 py-2">
                      {r.latest_grade ? (
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${gradeColour(r.latest_grade)}`}>
                          {gradeLabel(r.latest_grade)}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`inline-block rounded px-1.5 py-0.5 font-semibold ${
                        r.tier === "critical"
                          ? "bg-red-600 text-white"
                          : r.tier === "high"
                            ? "bg-orange-500 text-white"
                            : r.tier === "worth_a_look"
                              ? "bg-amber-200 text-slate-900"
                              : r.tier === "skip"
                                ? "bg-slate-200 text-slate-600"
                                : "bg-slate-100 text-slate-400"
                      }`}>
                        {r.tier ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`rounded px-1.5 py-0.5 font-semibold ${severityBand(r.score ?? 0)}`}>
                        {r.score ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                      {r.urgency_score ?? 0}/{r.pipeline_value_score ?? 0}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-600">
                      {r.top_curriculum ? CURRICULUM_LABELS[r.top_curriculum]?.split(" ")[0] ?? r.top_curriculum : "—"}
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
