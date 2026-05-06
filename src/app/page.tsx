import Link from "next/link";
import { count, desc, eq, sql } from "drizzle-orm";
import {
  db,
  findings,
  ingestionRuns,
  inspections,
  institutions,
  opportunityScores,
} from "@/db";
import { gradeBadgeClass, gradeLabel } from "@/lib/grades";
import { formatDate, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CURRICULA = [
  {
    key: "financial_literacy",
    title: "Financial Literacy",
    blurb:
      "Budgeting, money skills, financial decisions, preparation for adult life. Closes gaps in PSHE, RSHE and the financial strands of personal development.",
    accent: "fl-mango",
  },
  {
    key: "employability_skills",
    title: "Employability Skills",
    blurb:
      "Careers education, employer encounters, work readiness, interview craft, transition into work. Aligned to the Gatsby Benchmarks and PSHE Association programme of study.",
    accent: "fl-orange",
  },
  {
    key: "confidence_resilience",
    title: "Confidence & Resilience",
    blurb:
      "Personal development, mental wellbeing, character, behaviour and attitudes. Built for the section of the EIF where most reports flag weaknesses.",
    accent: "fl-blue",
  },
  {
    key: "online_safety",
    title: "Online Safety",
    blurb:
      "Digital literacy, KCSiE Annex C, Prevent online radicalisation, harmful sexual behaviour. Drops into PSHE, IT, or tutor sessions.",
    accent: "fl-navy",
  },
];

const CURRICULUM_LABELS: Record<string, string> = {
  financial_literacy: "Financial Literacy",
  employability_skills: "Employability Skills",
  confidence_resilience: "Confidence & Resilience",
  online_safety: "Online Safety",
};

async function loadStats() {
  try {
    const segmentRows = await db
      .select({
        type: institutions.type,
        instCount: sql<number>`COUNT(DISTINCT ${institutions.id})`,
        scoredCount: sql<number>`COUNT(DISTINCT ${opportunityScores.institutionId})`,
        highCount: sql<number>`SUM(CASE WHEN ${opportunityScores.score} >= 60 THEN 1 ELSE 0 END)`,
      })
      .from(institutions)
      .leftJoin(
        opportunityScores,
        eq(opportunityScores.institutionId, institutions.id),
      )
      .where(sql`${institutions.inScope} = 1`)
      .groupBy(institutions.type);

    const [
      [{ value: inScopeCount }],
      [{ value: inspectionCount }],
      [{ value: findingCount }],
      [{ value: scoredCount }],
      [{ value: highOpportunityCount }],
      [{ value: veryHigh }],
      [{ value: criticalCount }],
      [{ value: emailCovered }],
      lastRefreshRows,
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(institutions)
        .where(sql`${institutions.inScope} = 1`),
      db.select({ value: count() }).from(inspections),
      db
        .select({ value: count() })
        .from(findings)
        .where(sql`${findings.suppressed} = 0`),
      db.select({ value: count() }).from(opportunityScores),
      db
        .select({ value: count() })
        .from(opportunityScores)
        .where(sql`${opportunityScores.score} >= 60`),
      db
        .select({ value: count() })
        .from(opportunityScores)
        .where(sql`${opportunityScores.score} >= 80`),
      db
        .select({ value: count() })
        .from(opportunityScores)
        .where(sql`${opportunityScores.tier} = 'critical'`),
      db
        .select({ value: count() })
        .from(institutions)
        .where(
          sql`${institutions.inScope} = 1 AND (${institutions.generalEmail} IS NOT NULL OR ${institutions.headEmail} IS NOT NULL)`,
        ),
      db
        .select({
          source: ingestionRuns.source,
          completedAt: ingestionRuns.completedAt,
          status: ingestionRuns.status,
        })
        .from(ingestionRuns)
        .where(sql`${ingestionRuns.completedAt} IS NOT NULL`)
        .orderBy(desc(ingestionRuns.completedAt))
        .limit(1),
    ]);

    const topFive = await db
      .select({
        id: institutions.id,
        name: institutions.name,
        region: institutions.region,
        type: institutions.type,
        score: opportunityScores.score,
        topCurriculum: opportunityScores.topCurriculum,
        currentGrade: inspections.overallGrade,
        findingCount: opportunityScores.findingCount,
      })
      .from(opportunityScores)
      .innerJoin(
        institutions,
        eq(institutions.id, opportunityScores.institutionId),
      )
      .leftJoin(
        inspections,
        eq(inspections.id, opportunityScores.lastInspectionId),
      )
      .where(sql`${institutions.inScope} = 1`)
      .orderBy(
        desc(opportunityScores.score),
        desc(opportunityScores.urgencyScore),
        desc(opportunityScores.inspectionCount),
      )
      .limit(6);

    return {
      ok: true as const,
      inScopeCount,
      inspectionCount,
      findingCount,
      scoredCount,
      highOpportunityCount,
      veryHigh,
      criticalCount,
      emailCovered,
      lastRefresh: lastRefreshRows[0] ?? null,
      topFive,
      segments: segmentRows.map((s) => ({
        type: s.type,
        instCount: Number(s.instCount),
        scoredCount: Number(s.scoredCount),
        highCount: Number(s.highCount),
      })),
    };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default async function HomePage() {
  const stats = await loadStats();

  return (
    <main>
      <Hero stats={stats} />

      <div className="container mx-auto max-w-7xl px-6 pb-16">
        {!stats.ok ? (
          <ErrorPanel error={stats.error} />
        ) : stats.scoredCount === 0 ? (
          <EmptyPanel />
        ) : (
          <>
            <StatsPanel stats={stats} />
            <SegmentBreakdown segments={stats.segments} />
            <TopOpportunities rows={stats.topFive} />
          </>
        )}

        <section className="mt-16">
          <div className="flex items-baseline justify-between">
            <h2 className="text-2xl font-semibold tracking-tight text-fl-navy">
              Where Fledglings comes in
            </h2>
            <span className="text-sm text-fl-navy/60">
              For learners from Year 9 to age 25
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-fl-navy/70">
            Every flagged finding maps to one of our four SCORM-compliant
            curricula. The dashboard picks the strongest match as the
            lead-with angle for outreach, then renders the email with the
            verbatim source quote already filled in.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {CURRICULA.map((c) => (
              <article
                key={c.key}
                className="group relative overflow-hidden rounded-xl border border-fl-navy/10 bg-white p-6 shadow-fl-card transition-all hover:-translate-y-0.5 hover:shadow-fl-pop"
              >
                <span
                  aria-hidden
                  className={`absolute inset-x-0 top-0 h-1 bg-${c.accent}`}
                />
                <h3 className="text-lg font-semibold text-fl-navy">
                  {c.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-fl-navy/70">
                  {c.blurb}
                </p>
              </article>
            ))}
          </div>
        </section>

        <Footer />
      </div>
    </main>
  );
}

function Hero({ stats }: { stats: Awaited<ReturnType<typeof loadStats>> }) {
  const stat = stats.ok
    ? {
        opportunities: stats.highOpportunityCount,
        veryHigh: stats.veryHigh,
        findings: stats.findingCount,
        criticalCount: stats.criticalCount,
        emailCovered: stats.emailCovered,
      }
    : null;

  return (
    <section className="fl-hero">
      <div className="container mx-auto max-w-7xl px-6 py-14 lg:py-20">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr] lg:items-end">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full bg-fl-orange/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-fl-mango">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-fl-orange"
              />
              Where Growth Takes Flight
            </span>
            <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight md:text-4xl lg:text-5xl">
              The schools the inspector said&nbsp;
              <span className="text-fl-mango">need exactly what we do</span>.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg">
              We pull every published Ofsted and ISI inspection, surface the
              weaknesses our four curricula address, score the opportunity, and
              hand you the source quote ready to drop into outreach. For
              learners from Year 9 onwards.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href="/opportunities"
                className="fl-cta inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold shadow-sm"
              >
                See the prioritised list
                <svg
                  aria-hidden
                  viewBox="0 0 20 20"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 10h10M11 5l4 5-4 5" />
                </svg>
              </Link>
              <Link
                href="/qa"
                className="inline-flex items-center gap-2 rounded-md border border-white/25 px-4 py-2.5 text-sm font-medium text-white/90 transition-colors hover:bg-white/10"
              >
                Spot-check the extractor
              </Link>
            </div>
          </div>

          {stat ? (
            <div className="grid grid-cols-3 gap-3 rounded-xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
              <HeroStat
                label="Critical"
                value={formatNumber(stat.criticalCount ?? 0)}
                accent="text-fl-orange"
              />
              <HeroStat
                label="High priority"
                value={formatNumber(stat.opportunities)}
                accent="text-fl-mango"
              />
              <HeroStat
                label="With email"
                value={formatNumber(stat.emailCovered ?? 0)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  accent = "text-white",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="text-center">
      <div className={`text-3xl font-semibold tracking-tight ${accent}`}>
        {value}
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-white/60">
        {label}
      </div>
    </div>
  );
}

function ErrorPanel({ error }: { error: string }) {
  return (
    <div className="mt-10 rounded-xl border border-fl-orange/30 bg-fl-orange/5 p-6">
      <h2 className="text-lg font-semibold text-fl-orange">
        Database not ready
      </h2>
      <p className="mt-1 text-sm text-fl-navy/70">
        Couldn&rsquo;t read from <code>./data/fledglings.db</code>. The
        most likely cause is that migrations haven&rsquo;t been applied yet.
      </p>
      <div className="mt-4 rounded-md bg-white p-3 font-mono text-xs">
        <div>$ pnpm db:generate</div>
        <div>$ pnpm db:migrate</div>
      </div>
      <details className="mt-4 text-xs text-fl-navy/60">
        <summary className="cursor-pointer">Underlying error</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all">{error}</pre>
      </details>
    </div>
  );
}

function EmptyPanel() {
  return (
    <div className="mt-10 rounded-xl border border-fl-navy/10 bg-fl-off-white p-10 text-center">
      <h2 className="text-lg font-semibold text-fl-navy">
        No opportunities scored yet
      </h2>
      <p className="mt-1 text-sm text-fl-navy/70">
        The schema is in place but the pipeline hasn&rsquo;t produced
        opportunity scores yet. Click <strong>Refresh data</strong> in the
        nav, or run from a terminal:
      </p>
      <div className="mx-auto mt-5 inline-block rounded-md bg-fl-navy px-4 py-2 font-mono text-sm text-white">
        pnpm ingest
      </div>
    </div>
  );
}

function StatsPanel({
  stats,
}: {
  stats: Extract<Awaited<ReturnType<typeof loadStats>>, { ok: true }>;
}) {
  const refreshLabel = stats.lastRefresh?.completedAt
    ? `Last refresh: ${formatDate(stats.lastRefresh.completedAt)} · ${stats.lastRefresh.source} · ${stats.lastRefresh.status}`
    : "No completed refresh yet.";

  const cards = [
    { label: "Institutions in scope", value: formatNumber(stats.inScopeCount) },
    { label: "Inspection events", value: formatNumber(stats.inspectionCount) },
    { label: "Findings flagged", value: formatNumber(stats.findingCount) },
    { label: "Institutions scored", value: formatNumber(stats.scoredCount) },
  ];

  return (
    <section className="mt-12">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-fl-navy/55">
              {c.label}
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-fl-navy">
              {c.value}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-fl-navy/50">{refreshLabel}</p>
    </section>
  );
}

const SEGMENT_LABELS: Record<string, { label: string; blurb: string; tone: string }> = {
  state_school: {
    label: "State schools",
    blurb: "Ofsted-inspected, secondary phase or all-through with Year 9+",
    tone: "bg-fl-navy text-white",
  },
  independent_school: {
    label: "Independent schools",
    blurb: "ISI-inspected; Routine, Educational Quality, Compliance reports",
    tone: "bg-fl-blue text-white",
  },
  sixth_form_college: {
    label: "Sixth form colleges",
    blurb: "Standalone post-16 colleges (not sixth forms attached to schools)",
    tone: "bg-fl-mango text-fl-navy",
  },
  fe_college: {
    label: "FE colleges",
    blurb: "Further education colleges, Ofsted FE & Skills framework",
    tone: "bg-fl-orange text-white",
  },
  itp: {
    label: "Independent training providers",
    blurb: "Apprenticeship and skills providers under the Ofsted FE framework",
    tone: "bg-fl-blue/80 text-white",
  },
  employer: {
    label: "Employers (pre-employment bootcamp ICP)",
    blurb:
      "APAR Employer-Providers — companies running their own apprenticeship schemes who'd buy a pre-employment bootcamp",
    tone: "bg-fl-orange/90 text-white",
  },
  other: {
    label: "Other",
    blurb: "Establishments that don't fit the segments above",
    tone: "bg-fl-navy/70 text-white",
  },
};

function SegmentBreakdown({
  segments,
}: {
  segments: { type: string; instCount: number; scoredCount: number; highCount: number }[];
}) {
  const ORDER = [
    "state_school",
    "independent_school",
    "sixth_form_college",
    "fe_college",
    "itp",
    "employer",
    "other",
  ];
  const sorted = [...segments].sort(
    (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
  );

  return (
    <section className="mt-12">
      <div className="mb-4">
        <h2 className="text-2xl font-semibold tracking-tight text-fl-navy">
          Coverage by segment
        </h2>
        <p className="mt-1 text-sm text-fl-navy/60">
          How many institutions in each segment are scored versus how many we know exist.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((s) => {
          const meta = SEGMENT_LABELS[s.type] ?? SEGMENT_LABELS.other;
          const pct = s.instCount > 0 ? Math.round((s.scoredCount / s.instCount) * 100) : 0;
          return (
            <Link
              key={s.type}
              href={`/opportunities?type=${s.type}`}
              className="group overflow-hidden rounded-xl border border-fl-navy/10 bg-white shadow-fl-card transition-all hover:-translate-y-0.5 hover:shadow-fl-pop"
            >
              <div className={`flex items-center justify-between px-5 py-3 ${meta.tone}`}>
                <h3 className="text-sm font-semibold">{meta.label}</h3>
                <span className="text-xs opacity-80">{pct}% scored</span>
              </div>
              <div className="p-5">
                <p className="text-xs text-fl-navy/60">{meta.blurb}</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <Stat value={s.instCount} label="In scope" />
                  <Stat value={s.scoredCount} label="Scored" />
                  <Stat value={s.highCount} label="High ≥60" accent />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return (
    <div>
      <div
        className={
          "text-xl font-semibold tracking-tight " +
          (accent ? "text-fl-orange" : "text-fl-navy")
        }
      >
        {formatNumber(value)}
      </div>
      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-fl-navy/55">
        {label}
      </div>
    </div>
  );
}

function TopOpportunities({
  rows,
}: {
  rows: Extract<
    Awaited<ReturnType<typeof loadStats>>,
    { ok: true }
  >["topFive"];
}) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-fl-navy">
            Top opportunities right now
          </h2>
          <p className="mt-1 text-sm text-fl-navy/60">
            Highest Opportunity Scores from the latest scoring run.
          </p>
        </div>
        <Link
          href="/opportunities"
          className="text-sm font-medium text-fl-orange hover:underline"
        >
          See all →
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <Link
            key={r.id}
            href={`/opportunities/${r.id}`}
            className="group flex items-stretch overflow-hidden rounded-xl border border-fl-navy/10 bg-white shadow-fl-card transition-all hover:-translate-y-0.5 hover:shadow-fl-pop"
          >
            <div className="flex w-16 flex-shrink-0 flex-col items-center justify-center bg-fl-navy py-4 text-white">
              <div className="text-2xl font-bold leading-none">{r.score}</div>
              <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-fl-mango">
                Score
              </div>
            </div>
            <div className="min-w-0 flex-1 p-4">
              <h3 className="truncate font-semibold text-fl-navy group-hover:text-fl-orange">
                {r.name}
              </h3>
              <p className="mt-0.5 text-xs text-fl-navy/55">
                {(r.type ?? "").replaceAll("_", " ")} · {r.region ?? "—"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {r.topCurriculum ? (
                  <span className="rounded-full bg-fl-orange/10 px-2 py-0.5 text-[11px] font-medium text-fl-orange">
                    {CURRICULUM_LABELS[r.topCurriculum] ?? r.topCurriculum}
                  </span>
                ) : null}
                {r.currentGrade ? (
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                      gradeBadgeClass(r.currentGrade)
                    }
                  >
                    {gradeLabel(r.currentGrade)}
                  </span>
                ) : null}
                <span className="text-[11px] text-fl-navy/50">
                  {r.findingCount} findings
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-16 border-t border-fl-navy/10 pt-6 text-xs text-fl-navy/50">
      Local-first. Database lives at <code>./data/fledglings.db</code>.
      Monday 06:00 refresh runs via Windows Task Scheduler — see the README
      for setup. Where Growth Takes Flight.
    </footer>
  );
}
