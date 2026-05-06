import Link from "next/link";
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import {
  CURRICULA,
  db,
  findings,
  inspections,
  institutions,
  opportunityScores,
} from "@/db";
import { gradeBadgeClass, gradeLabel } from "@/lib/grades";
import { formatDate, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

type SearchParams = {
  q?: string;
  region?: string;
  type?: string;
  curriculum?: string;
  tier?: string;
  min_score?: string;
  max_score?: string;
  has_email?: string;
  page?: string;
};

const CURRICULUM_LABELS: Record<string, string> = {
  financial_literacy: "Financial Literacy",
  employability_skills: "Employability Skills",
  confidence_resilience: "Confidence & Resilience",
  online_safety: "Online Safety",
};

function buildWhere(params: SearchParams) {
  const conds = [eq(institutions.inScope, true)];
  if (params.q) {
    const like1 = `%${params.q}%`;
    conds.push(
      or(
        like(institutions.name, like1),
        like(institutions.postcode, like1),
      )!,
    );
  }
  if (params.region) conds.push(eq(institutions.region, params.region));
  if (params.type) conds.push(eq(institutions.type, params.type));
  if (params.curriculum)
    conds.push(eq(opportunityScores.topCurriculum, params.curriculum));
  if (params.tier) conds.push(eq(opportunityScores.tier, params.tier));
  if (params.min_score)
    conds.push(gte(opportunityScores.score, Number(params.min_score)));
  if (params.max_score)
    conds.push(lte(opportunityScores.score, Number(params.max_score)));
  if (params.has_email === "1")
    conds.push(
      sql`(${institutions.generalEmail} IS NOT NULL OR ${institutions.headEmail} IS NOT NULL)`,
    );
  return and(...conds);
}

async function loadFilterOptions() {
  const regions = await db
    .selectDistinct({ region: institutions.region })
    .from(institutions)
    .innerJoin(
      opportunityScores,
      eq(opportunityScores.institutionId, institutions.id),
    )
    .where(eq(institutions.inScope, true))
    .orderBy(institutions.region);
  return {
    regions: regions
      .map((r) => r.region)
      .filter((r): r is string => Boolean(r))
      .sort(),
  };
}

async function loadResults(params: SearchParams) {
  const page = Math.max(1, Number(params.page ?? "1"));
  const offset = (page - 1) * PAGE_SIZE;
  const where = buildWhere(params);

  // When the user filters by a specific institution type we INCLUDE
  // unscored institutions so they can browse the full universe of e.g.
  // ITPs (Lifetime Training, Babcock, Kaplan etc. that are Good-rated and
  // therefore score=0 — but still real sales prospects). Default view
  // (no type filter) sticks to scored institutions only so the high-tier
  // ranking isn't drowned in 5,000 unscored state schools.
  const includeUnscored = Boolean(params.type);
  const joinFn = includeUnscored ? db.select : db.select;

  const selectFields = {
    id: institutions.id,
    name: institutions.name,
    type: institutions.type,
    region: institutions.region,
    postcode: institutions.postcode,
    headName: institutions.headName,
    headEmail: institutions.headEmail,
    generalEmail: institutions.generalEmail,
    score: opportunityScores.score,
    tier: opportunityScores.tier,
    rawScore: opportunityScores.rawScore,
    topCurriculum: opportunityScores.topCurriculum,
    topFindingId: opportunityScores.topFindingId,
    findingCount: opportunityScores.findingCount,
    lastInspectionId: opportunityScores.lastInspectionId,
    lastInspectionDate: inspections.inspectionStartDate,
    currentGrade: inspections.overallGrade,
    previousGrade: inspections.previousOverallGrade,
    reportUrl: inspections.reportUrl,
    gradeDropped: inspections.gradeDropped,
  };

  const baseQuery = includeUnscored
    ? db
        .select(selectFields)
        .from(institutions)
        .leftJoin(
          opportunityScores,
          eq(opportunityScores.institutionId, institutions.id),
        )
        .leftJoin(
          inspections,
          eq(
            inspections.id,
            sql<number>`COALESCE(${opportunityScores.lastInspectionId}, (SELECT id FROM inspections WHERE institution_id = ${institutions.id} ORDER BY inspection_start_date DESC LIMIT 1))`,
          ),
        )
        .where(where)
    : db
        .select(selectFields)
        .from(opportunityScores)
        .innerJoin(
          institutions,
          eq(institutions.id, opportunityScores.institutionId),
        )
        .leftJoin(
          inspections,
          eq(inspections.id, opportunityScores.lastInspectionId),
        )
        .where(where);

  const rows = await baseQuery
    .orderBy(
      sql`COALESCE(${opportunityScores.score}, -1) DESC`,
      // Within the same score bucket, big/established providers first.
      sql`COALESCE(${opportunityScores.inspectionCount}, 0) DESC`,
      institutions.name,
    )
    .limit(PAGE_SIZE)
    .offset(offset);

  const findingIds = rows
    .map((r) => r.topFindingId)
    .filter((id): id is number => id != null);
  const topFindingMap = new Map<
    number,
    { phraseId: string; section: string; quote: string }
  >();
  if (findingIds.length) {
    const fRows = await db
      .select({
        id: findings.id,
        phraseId: findings.phraseId,
        section: findings.sectionKey,
        quote: findings.sourceQuote,
      })
      .from(findings)
      .where(
        sql`${findings.id} IN (${sql.join(
          findingIds.map((id) => sql`${id}`),
          sql`,`,
        )})`,
      );
    for (const f of fRows) {
      topFindingMap.set(f.id, {
        phraseId: f.phraseId,
        section: f.section,
        quote: f.quote,
      });
    }
  }

  const total = includeUnscored
    ? (
        await db
          .select({ value: sql<number>`COUNT(*)` })
          .from(institutions)
          .leftJoin(
            opportunityScores,
            eq(opportunityScores.institutionId, institutions.id),
          )
          .where(where)
      )[0].value
    : (
        await db
          .select({ value: sql<number>`COUNT(*)` })
          .from(opportunityScores)
          .innerJoin(
            institutions,
            eq(institutions.id, opportunityScores.institutionId),
          )
          .where(where)
      )[0].value;

  return {
    rows: rows.map((r) => ({
      ...r,
      topFinding: r.topFindingId ? topFindingMap.get(r.topFindingId) : null,
    })),
    total,
    page,
  };
}

function scoreTier(n: number | null): {
  bar: string;
  bg: string;
  text: string;
  label: string;
} {
  if (n == null)
    return {
      bar: "bg-fl-navy/20",
      bg: "bg-fl-off-white",
      text: "text-fl-navy/60",
      label: "No signal",
    };
  if (n >= 90)
    return {
      bar: "bg-fl-orange",
      bg: "bg-fl-orange",
      text: "text-fl-white",
      label: "Critical",
    };
  if (n >= 70)
    return {
      bar: "bg-fl-mango",
      bg: "bg-fl-mango",
      text: "text-fl-navy",
      label: "High",
    };
  if (n >= 50)
    return {
      bar: "bg-fl-blue",
      bg: "bg-fl-blue",
      text: "text-fl-white",
      label: "Worth a look",
    };
  return {
    bar: "bg-fl-navy/30",
    bg: "bg-fl-navy/15",
    text: "text-fl-navy",
    label: "Skip",
  };
}

function buildHref(params: SearchParams, overrides: Partial<SearchParams>) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) merged[k] = v;
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null || v === "") delete merged[k];
    else merged[k] = String(v);
  }
  const qs = new URLSearchParams(merged).toString();
  return `/opportunities${qs ? `?${qs}` : ""}`;
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [{ regions }, results] = await Promise.all([
    loadFilterOptions(),
    loadResults(params),
  ]);

  const totalPages = Math.max(1, Math.ceil(results.total / PAGE_SIZE));
  const exportHref =
    "/opportunities/export?" +
    new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([, v]) => v),
      ) as Record<string, string>,
    ).toString();

  return (
    <main className="container mx-auto max-w-7xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fl-orange">
            Opportunities
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fl-navy">
            {params.type
              ? `Every ${typeLabel(params.type)} we know about`
              : "Prioritised by inspection signal"}
          </h1>
          <p className="mt-1 text-sm text-fl-navy/60">
            {formatNumber(results.total)} institutions match these filters ·
            page {results.page} of {totalPages}
            {params.type ? (
              <>
                {" "}· scored ones first, then unscored alphabetical (those
                with no current inspection-flagged urgency but still real
                prospects)
              </>
            ) : null}
          </p>
        </div>
        <a
          href={exportHref}
          className="inline-flex items-center gap-2 rounded-md border border-fl-navy/15 bg-white px-3.5 py-2 text-sm font-medium text-fl-navy transition-colors hover:bg-fl-off-white"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 3v10m0 0 4-4m-4 4-4-4M3 17h14" />
          </svg>
          Export CSV
        </a>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside>
          <form
            method="get"
            action="/opportunities"
            className="space-y-4 rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card"
          >
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-fl-navy/55">
                Filters
              </h3>
            </div>
            <FilterField label="Search">
              <input
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Name or postcode"
                className="w-full rounded-md border border-fl-navy/15 bg-white px-2.5 py-1.5 text-sm focus:border-fl-orange focus:outline-none focus:ring-1 focus:ring-fl-orange"
              />
            </FilterField>
            <FilterField label="Type">
              <select
                name="type"
                defaultValue={params.type ?? ""}
                className="w-full rounded-md border border-fl-navy/15 bg-white px-2 py-1.5 text-sm focus:border-fl-orange focus:outline-none"
              >
                <option value="">Any</option>
                <option value="state_school">State school</option>
                <option value="independent_school">Independent school</option>
                <option value="sixth_form_college">Sixth form college</option>
                <option value="fe_college">FE college</option>
                <option value="itp">Independent training provider</option>
                <option value="university">University</option>
                <option value="employer">Employer (pre-employment ICP)</option>
              </select>
            </FilterField>
            <FilterField label="Region">
              <select
                name="region"
                defaultValue={params.region ?? ""}
                className="w-full rounded-md border border-fl-navy/15 bg-white px-2 py-1.5 text-sm focus:border-fl-orange focus:outline-none"
              >
                <option value="">Any</option>
                {regions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="Lead-with curriculum">
              <select
                name="curriculum"
                defaultValue={params.curriculum ?? ""}
                className="w-full rounded-md border border-fl-navy/15 bg-white px-2 py-1.5 text-sm focus:border-fl-orange focus:outline-none"
              >
                <option value="">Any</option>
                {CURRICULA.map((c) => (
                  <option key={c} value={c}>
                    {CURRICULUM_LABELS[c]}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="Tier">
              <select
                name="tier"
                defaultValue={params.tier ?? ""}
                className="w-full rounded-md border border-fl-navy/15 bg-white px-2 py-1.5 text-sm focus:border-fl-orange focus:outline-none"
              >
                <option value="">Any</option>
                <option value="critical">Critical</option>
                <option value="high">High priority</option>
                <option value="worth_a_look">Worth a look</option>
                <option value="skip">Skip</option>
              </select>
            </FilterField>
            <label className="flex items-center gap-2 text-sm text-fl-navy">
              <input
                type="checkbox"
                name="has_email"
                value="1"
                defaultChecked={params.has_email === "1"}
                className="h-4 w-4 rounded border-fl-navy/30 text-fl-orange focus:ring-fl-orange"
              />
              Only show institutions with a contact email
            </label>
            <div className="grid grid-cols-2 gap-2">
              <FilterField label="Min score">
                <input
                  name="min_score"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={params.min_score ?? ""}
                  className="w-full rounded-md border border-fl-navy/15 bg-white px-2 py-1.5 text-sm focus:border-fl-orange focus:outline-none"
                />
              </FilterField>
              <FilterField label="Max score">
                <input
                  name="max_score"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={params.max_score ?? ""}
                  className="w-full rounded-md border border-fl-navy/15 bg-white px-2 py-1.5 text-sm focus:border-fl-orange focus:outline-none"
                />
              </FilterField>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="submit"
                className="fl-cta flex-1 rounded-md px-3 py-1.5 text-sm font-semibold"
              >
                Apply
              </button>
              <a
                href="/opportunities"
                className="rounded-md border border-fl-navy/15 bg-white px-3 py-1.5 text-sm font-medium text-fl-navy transition-colors hover:bg-fl-off-white"
              >
                Reset
              </a>
            </div>
          </form>
        </aside>

        <section className="space-y-3">
          {results.rows.length === 0 ? (
            <div className="rounded-xl border border-fl-navy/10 bg-fl-off-white p-10 text-center text-sm text-fl-navy/70">
              No institutions match these filters. Reset filters or run{" "}
              <code>pnpm ingest</code> for fresh data.
            </div>
          ) : (
            results.rows.map((r) => {
              const tier = scoreTier(r.score);
              return (
                <Link
                  key={r.id}
                  href={`/opportunities/${r.id}`}
                  className="group flex overflow-hidden rounded-xl border border-fl-navy/10 bg-white shadow-fl-card transition-all hover:-translate-y-0.5 hover:shadow-fl-pop"
                >
                  <div
                    className={`flex w-20 flex-shrink-0 flex-col items-center justify-center ${tier.bg} ${tier.text}`}
                  >
                    <div className="text-3xl font-bold leading-none">
                      {r.score == null ? "—" : r.score}
                    </div>
                    <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.14em] opacity-80">
                      {tier.label}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 p-4">
                    <div className="flex items-baseline gap-2">
                      <h3 className="truncate font-semibold text-fl-navy group-hover:text-fl-orange">
                        {r.name}
                      </h3>
                      {r.gradeDropped ? (
                        <span className="flex-shrink-0 rounded-full bg-fl-orange/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fl-orange">
                          Grade drop
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-fl-navy/55">
                      {r.region ?? "—"} ·{" "}
                      <span className="capitalize">
                        {(r.type ?? "").replaceAll("_", " ")}
                      </span>{" "}
                      · {r.postcode ?? "—"}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      {r.topCurriculum ? (
                        <span className="rounded-full bg-fl-orange/10 px-2 py-0.5 font-medium text-fl-orange">
                          {CURRICULUM_LABELS[r.topCurriculum] ??
                            r.topCurriculum}
                        </span>
                      ) : null}
                      {r.currentGrade ? (
                        <span
                          className={
                            "rounded-full px-2 py-0.5 font-medium " +
                            gradeBadgeClass(r.currentGrade)
                          }
                        >
                          {gradeLabel(r.currentGrade)}
                        </span>
                      ) : null}
                      <span className="text-fl-navy/50">
                        {r.findingCount} findings
                      </span>
                      <span className="text-fl-navy/50">
                        Inspected {formatDate(r.lastInspectionDate)}
                      </span>
                    </div>
                    {r.topFinding ? (
                      <p className="mt-2 line-clamp-2 text-sm text-fl-navy/85">
                        <span className="font-semibold text-fl-navy">
                          Top signal:
                        </span>{" "}
                        <span className="italic">
                          &ldquo;{r.topFinding.quote.slice(0, 220)}
                          {r.topFinding.quote.length > 220 ? "…" : ""}&rdquo;
                        </span>
                      </p>
                    ) : null}
                  </div>
                </Link>
              );
            })
          )}

          {totalPages > 1 ? (
            <div className="flex items-center justify-between pt-4 text-sm">
              <a
                href={
                  results.page > 1
                    ? buildHref(params, { page: String(results.page - 1) })
                    : "#"
                }
                aria-disabled={results.page <= 1}
                className={
                  "rounded-md border border-fl-navy/15 bg-white px-3 py-1.5 " +
                  (results.page <= 1
                    ? "pointer-events-none opacity-40"
                    : "hover:bg-fl-off-white")
                }
              >
                ← Previous
              </a>
              <span className="text-fl-navy/55">
                Page {results.page} of {totalPages}
              </span>
              <a
                href={
                  results.page < totalPages
                    ? buildHref(params, { page: String(results.page + 1) })
                    : "#"
                }
                aria-disabled={results.page >= totalPages}
                className={
                  "rounded-md border border-fl-navy/15 bg-white px-3 py-1.5 " +
                  (results.page >= totalPages
                    ? "pointer-events-none opacity-40"
                    : "hover:bg-fl-off-white")
                }
              >
                Next →
              </a>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function typeLabel(t: string): string {
  switch (t) {
    case "state_school":
      return "state school";
    case "independent_school":
      return "independent school";
    case "sixth_form_college":
      return "sixth form college";
    case "fe_college":
      return "FE college";
    case "itp":
      return "independent training provider";
    case "university":
      return "university";
    case "employer":
      return "employer";
    default:
      return t.replaceAll("_", " ");
  }
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-[11px] font-semibold uppercase tracking-wider text-fl-navy/55">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
