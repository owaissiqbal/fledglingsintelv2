import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import {
  client,
  complianceNotices,
  curriculumMatches,
  db,
  findings,
  inspections,
  institutions,
  newsItems,
  opportunityScores,
} from "@/db";
import { CopyButton } from "@/components/CopyButton";
import { PolishWithClaudeButton } from "@/components/PolishWithClaudeButton";
import { SendToInstantlyButton } from "@/components/SendToInstantlyButton";
import { isClaudeEnabled } from "@/lib/claude";
import { frameworkFor } from "@/lib/extract/framework-display";
import { gradeBadgeClass, gradeLabel } from "@/lib/grades";
import { renderEmail } from "@/lib/templates";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const CURRICULUM_LABELS: Record<string, string> = {
  financial_literacy: "Financial Literacy",
  employability_skills: "Employability Skills",
  confidence_resilience: "Confidence & Resilience",
  online_safety: "Online Safety",
};

const CURRICULUM_ACCENTS: Record<string, string> = {
  financial_literacy: "bg-fl-mango",
  employability_skills: "bg-fl-orange",
  confidence_resilience: "bg-fl-blue",
  online_safety: "bg-fl-navy",
};

const SECTION_LABELS: Record<string, string> = {
  what_school_needs_to_improve: "What the school needs to improve",
  what_provider_needs_to_improve: "What the provider needs to improve",
  recommendations: "Recommendations",
  areas_for_action: "Areas for action",
  areas_for_improvement: "Areas for improvement",
  significant_strengths: "Significant strengths",
  safeguarding: "Safeguarding",
  main_findings: "What is it like to be a learner here / What does the provider do well",
  summary: "Summary",
  personal_development: "Personal development",
  behaviour_attitudes: "Behaviour and attitudes",
  apprenticeships: "Apprenticeships",
  adult_learning: "Adult learning programmes",
  young_peoples_provision: "Education programmes for young people",
  high_needs_provision: "Provision for learners with high needs",
  quality_of_education: "Quality of education",
  leadership_management: "Leadership and management",
  body: "Body text",
};

async function loadDetail(id: number) {
  const inst = await db
    .select()
    .from(institutions)
    .where(eq(institutions.id, id))
    .limit(1);
  if (!inst[0]) return null;

  const score = await db
    .select()
    .from(opportunityScores)
    .where(eq(opportunityScores.institutionId, id))
    .limit(1);

  const allInspections = await db
    .select()
    .from(inspections)
    .where(eq(inspections.institutionId, id))
    .orderBy(desc(inspections.inspectionStartDate));

  const inspectionFindings = await db
    .select()
    .from(findings)
    .where(eq(findings.institutionId, id))
    .orderBy(desc(findings.finalSeverity));

  const compliance = await db
    .select()
    .from(complianceNotices)
    .where(eq(complianceNotices.institutionId, id))
    .orderBy(desc(complianceNotices.severity));

  const news = await db
    .select()
    .from(newsItems)
    .where(eq(newsItems.institutionId, id))
    .orderBy(desc(newsItems.triggerSeverity), desc(newsItems.publishedAt));

  // Verbatim "what this provider needs to improve" / "areas for action"
  // sections from the latest report. The single most useful piece of
  // text on this page — the inspector's own words.
  const latestInspectionId = allInspections[0]?.id;
  const reportSectionRows = latestInspectionId
    ? (
        await client.execute({
          sql: `SELECT section_key, section_title, section_text, order_index
                FROM report_sections
                WHERE inspection_id = ?
                  AND section_key IN (
                    'what_provider_needs_to_improve',
                    'what_school_needs_to_improve',
                    'areas_for_action',
                    'areas_for_improvement',
                    'recommendations',
                    'apprenticeships',
                    'adult_learning',
                    'young_peoples_provision',
                    'high_needs_provision',
                    'quality_of_education',
                    'behaviour_attitudes',
                    'personal_development',
                    'leadership_management',
                    'safeguarding',
                    'main_findings'
                  )
                ORDER BY order_index ASC`,
          args: [latestInspectionId],
        })
      ).rows as unknown as {
        section_key: string;
        section_title: string | null;
        section_text: string;
        order_index: number;
      }[]
    : [];

  return {
    institution: inst[0],
    score: score[0] ?? null,
    inspections: allInspections,
    findings: inspectionFindings,
    compliance,
    news,
    reportSections: reportSectionRows,
  };
}

function scoreBg(n: number): string {
  if (n >= 80) return "bg-fl-orange text-white";
  if (n >= 60) return "bg-fl-mango text-fl-navy";
  if (n >= 40) return "bg-fl-blue text-white";
  return "bg-fl-navy/15 text-fl-navy";
}

function tierBg(tier: string | null | undefined): string {
  switch (tier) {
    case "critical":
      return "bg-fl-orange text-white";
    case "high":
      return "bg-fl-mango text-fl-navy";
    case "worth_a_look":
      return "bg-fl-blue text-white";
    default:
      return "bg-fl-navy/15 text-fl-navy";
  }
}

function tierLabel(tier: string): string {
  switch (tier) {
    case "critical":
      return "Critical";
    case "high":
      return "High priority";
    case "worth_a_look":
      return "Worth a look";
    case "skip":
      return "Skip";
    default:
      return tier;
  }
}

function curriculumBar(c: string): string {
  switch (c) {
    case "online_safety":
      return "bg-fl-navy";
    case "confidence_resilience":
      return "bg-fl-blue";
    case "employability_skills":
      return "bg-fl-orange";
    case "financial_literacy":
      return "bg-fl-mango";
    default:
      return "bg-fl-navy/40";
  }
}

function FrameworkPanel({
  inst,
  latest,
}: {
  inst: { type: string };
  latest: Record<string, unknown> | null;
}) {
  const hasReportCard = Boolean(
    latest?.personalDevWellbeing ||
      latest?.attendanceBehaviour ||
      latest?.inclusion ||
      latest?.curriculumTeaching,
  );
  const framework = frameworkFor(
    (latest?.inspectionBody as string) ?? null,
    inst.type,
    hasReportCard,
  );
  return (
    <section className="rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card">
      <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-fl-navy/65">
        {framework.title}
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-fl-navy/55">
        {framework.blurb}
      </p>
      {framework.groups.map((group) => (
        <div key={group.heading} className="mt-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fl-orange">
            {group.heading}
          </p>
          <dl className="mt-2 space-y-1.5 text-sm">
            {group.fields.map((f) => {
              const raw = (latest as Record<string, unknown> | null)?.[f.field];
              let display: string | null = null;
              if (f.field === "safeguardingEffective") {
                if (raw === true) display = "meets_standard";
                else if (raw === false) display = "does_not_meet_standard";
              } else if (typeof raw === "string") {
                display = raw;
              }
              return (
                <div key={f.field} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-fl-navy/75 leading-tight">{f.label}</dt>
                    <dd
                      className={
                        "flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium " +
                        gradeBadgeClass(display)
                      }
                    >
                      {gradeLabel(display)}
                    </dd>
                  </div>
                  {f.curriculumNote ? (
                    <p className="text-[10px] text-fl-navy/45">
                      → {f.curriculumNote}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </dl>
        </div>
      ))}
    </section>
  );
}

function curriculumLine(score: number): string {
  if (score >= 80) return "Lead with this — strong inspection signal";
  if (score >= 60) return "Strong fit — clear inspection evidence";
  if (score >= 40) return "Possible angle — modest signal";
  if (score >= 20) return "Light signal — keep as a sub-mention";
  return "Not a hook here";
}

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) notFound();

  const detail = await loadDetail(id);
  if (!detail) notFound();

  const { institution: inst, score, inspections: insps, findings: finds } =
    detail;
  const latest = insps[0] ?? null;
  const previous = insps[1] ?? null;
  const nonSuppressed = finds.filter((f) => !f.suppressed);
  const topFinding = nonSuppressed[0] ?? null;

  const ctx = {
    institution_name: inst.name,
    region: inst.region,
    inspection_date: latest ? formatDate(latest.inspectionStartDate) : null,
    current_grade: latest?.overallGrade ?? null,
    previous_grade: latest?.previousOverallGrade ?? null,
    top_weakness: topFinding ? phraseLabel(topFinding.phraseId) : null,
    source_quote: topFinding?.sourceQuote ?? null,
    source_section: topFinding
      ? SECTION_LABELS[topFinding.sectionKey] ?? topFinding.sectionKey
      : null,
    report_url: latest?.reportUrl ?? null,
    head_name: inst.headName,
  };

  const emailCurriculum = score?.topCurriculum ?? "confidence_resilience";
  const email = renderEmail(emailCurriculum, ctx);
  const fullEmail = email.subject
    ? `Subject: ${email.subject}\n\n${email.body}`
    : email.body;

  const groupedFindings = groupFindings(nonSuppressed);
  const activeCompliance = detail.compliance.filter((c) => !c.withdrawnAt);
  const withdrawnCompliance = detail.compliance.filter((c) => c.withdrawnAt);
  const significantNews = detail.news.filter(
    (n) => n.relevance >= 50 && n.triggerSeverity > 0,
  );

  return (
    <main className="container mx-auto max-w-7xl px-6 py-8">
      <Link
        href="/opportunities"
        className="inline-flex items-center gap-1 text-sm text-fl-navy/60 hover:text-fl-orange"
      >
        ← Back to opportunities
      </Link>

      <header className="mt-4 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-start">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-fl-orange">
            {(inst.type ?? "").replaceAll("_", " ")}
            {score?.tier ? ` · ${tierLabel(score.tier)}` : ""}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fl-navy md:text-4xl">
            {inst.name}
          </h1>
          <p className="mt-2 text-sm text-fl-navy/60">
            {inst.region ? `${inst.region} · ` : ""}
            {inst.localAuthority ? `${inst.localAuthority} · ` : ""}
            {inst.postcode ?? "—"}
            {inst.urn ? ` · URN ${inst.urn}` : ""}
            {inst.ukprn ? ` · UKPRN ${inst.ukprn}` : ""}
          </p>
        </div>
        {score ? (
          <div
            className={`flex items-center gap-4 rounded-xl px-6 py-4 shadow-fl-card ${tierBg(score.tier)}`}
          >
            <div>
              <div className="text-4xl font-bold leading-none">
                {score.score}
              </div>
              <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] opacity-80">
                {tierLabel(score.tier ?? "skip")}
              </div>
            </div>
            <div className="border-l border-current/30 pl-4 text-xs leading-relaxed">
              <div>{score.findingCount} findings</div>
              <div>top: {CURRICULUM_LABELS[score.topCurriculum ?? ""] ?? "—"}</div>
            </div>
          </div>
        ) : null}
      </header>

      {score ? (
        <section className="mt-8 rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-fl-navy">
              Why this is a Fledglings opportunity
            </h2>
            <span className="text-xs uppercase tracking-wider text-fl-navy/50">
              Per-curriculum sub-scores
            </span>
          </div>

          {score.criticalSignals ? (
            <div className="mb-5 rounded-lg border border-fl-orange/30 bg-fl-orange/5 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fl-orange">
                Critical signals from the inspection
              </div>
              <ul className="mt-2 space-y-1 text-sm text-fl-navy">
                {score.criticalSignals.split(" · ").map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span aria-hidden className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-fl-orange" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["online_safety", score.onlineSafetyScore],
                ["confidence_resilience", score.confidenceResilienceScore],
                ["employability_skills", score.employabilitySkillsScore],
                ["financial_literacy", score.financialLiteracyScore],
              ] as const
            )
              .sort((a, b) => b[1] - a[1])
              .map(([key, val]) => (
                <div
                  key={key}
                  className="rounded-lg border border-fl-navy/10 p-3"
                >
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-semibold text-fl-navy">
                      {CURRICULUM_LABELS[key]}
                    </p>
                    <span className="text-2xl font-bold tracking-tight text-fl-navy">
                      {val}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-fl-off-white">
                    <div
                      className={`h-full ${curriculumBar(key)}`}
                      style={{ width: `${val}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-fl-navy/55">
                    {curriculumLine(val)}
                  </p>
                </div>
              ))}
          </div>
        </section>
      ) : null}

      {detail.reportSections && detail.reportSections.length > 0 && (
        <section className="mt-8 overflow-hidden rounded-xl border-2 border-fl-orange/40 bg-gradient-to-br from-orange-50/60 to-amber-50/40 shadow-fl-card">
          <div className="border-b border-fl-orange/30 bg-fl-orange/10 px-5 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-fl-navy">
              Verbatim from the inspector
            </h2>
            <p className="mt-1 text-xs text-fl-navy/70">
              Direct quotes from the latest published report. Use these in
              outreach without paraphrasing.
            </p>
          </div>
          <div className="divide-y divide-fl-orange/20">
            {(() => {
              const seen = new Set<string>();
              return detail.reportSections
                .filter((s) => {
                  if (seen.has(s.section_key)) return false;
                  seen.add(s.section_key);
                  return s.section_text && s.section_text.trim().length >= 30;
                })
                .map((s) => {
                  const label =
                    SECTION_LABELS[s.section_key] ?? s.section_key.replaceAll("_", " ");
                  const text = s.section_text.trim();
                  const trimmed = text.length > 1800 ? text.slice(0, 1800) + "…" : text;
                  return (
                    <div key={s.section_key} className="px-5 py-4">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fl-navy/70">
                        {label}
                      </h3>
                      <blockquote className="border-l-4 border-fl-orange/60 pl-4 text-sm leading-relaxed text-fl-navy/90 whitespace-pre-line">
                        {trimmed}
                      </blockquote>
                    </div>
                  );
                });
            })()}
          </div>
        </section>
      )}

      {(activeCompliance.length > 0 || significantNews.length > 0) && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {activeCompliance.length > 0 && (
            <section className="rounded-xl border border-fl-orange/30 bg-orange-50/40 p-5 shadow-fl-card">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-fl-navy">
                Active compliance signals · {activeCompliance.length}
              </h2>
              <p className="mt-1 text-xs text-fl-navy/60">
                Public regulatory or financial-health notices currently
                affecting this provider. The most severe drives the score.
              </p>
              <ul className="mt-4 space-y-3">
                {activeCompliance.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-lg border border-fl-navy/10 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-fl-navy">
                        {c.subject}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          c.severity >= 90
                            ? "bg-red-600 text-white"
                            : c.severity >= 70
                              ? "bg-orange-500 text-white"
                              : "bg-amber-300 text-slate-900"
                        }`}
                      >
                        {c.severity}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] uppercase tracking-wide text-fl-navy/50">
                      {c.noticeBody} · {c.noticeType}
                      {c.issuedAt && <> · {c.issuedAt}</>}
                    </div>
                    {c.details && (
                      <div className="mt-2 text-xs text-fl-navy/70 line-clamp-3">
                        {c.details}
                      </div>
                    )}
                    <a
                      href={c.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block text-[11px] text-fl-blue hover:underline"
                    >
                      Source →
                    </a>
                  </li>
                ))}
              </ul>
              {withdrawnCompliance.length > 0 && (
                <p className="mt-3 text-[11px] text-fl-navy/50">
                  + {withdrawnCompliance.length} historical (withdrawn) notice{withdrawnCompliance.length === 1 ? "" : "s"}.
                </p>
              )}
            </section>
          )}

          {significantNews.length > 0 && (
            <section className="rounded-xl border border-fl-mango/40 bg-amber-50/40 p-5 shadow-fl-card">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-fl-navy">
                News signals · {significantNews.length}
              </h2>
              <p className="mt-1 text-xs text-fl-navy/60">
                Articles mentioning this provider. Trigger severity and
                curriculum tags come from a Claude pass over each story.
              </p>
              <ul className="mt-4 space-y-3">
                {significantNews.slice(0, 6).map((n) => (
                  <li
                    key={n.id}
                    className="rounded-lg border border-fl-navy/10 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <a
                        href={n.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-fl-navy hover:underline"
                      >
                        {n.title}
                      </a>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          n.triggerSeverity >= 70
                            ? "bg-red-600 text-white"
                            : n.triggerSeverity >= 40
                              ? "bg-orange-500 text-white"
                              : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {n.triggerSeverity}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] uppercase tracking-wide text-fl-navy/50">
                      {n.source}
                      {n.publishedAt && <> · {n.publishedAt}</>}
                      {n.curriculaTagged && <> · {n.curriculaTagged}</>}
                      <> · relevance {n.relevance}</>
                    </div>
                    {n.angle && n.angle !== "no angle" && (
                      <div className="mt-2 text-xs italic text-fl-navy/70 line-clamp-2">
                        {n.angle}
                      </div>
                    )}
                  </li>
                ))}
                {significantNews.length > 6 && (
                  <li className="text-xs text-fl-navy/50">
                    + {significantNews.length - 6} more
                  </li>
                )}
              </ul>
            </section>
          )}
        </div>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_340px]">
        <div className="space-y-8">
          <section className="overflow-hidden rounded-xl border border-fl-navy/10 bg-white shadow-fl-card">
            <div className="flex items-center justify-between border-b border-fl-navy/10 bg-fl-off-white/40 px-5 py-3">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={`h-2 w-2 rounded-full ${CURRICULUM_ACCENTS[emailCurriculum] ?? "bg-fl-orange"}`}
                />
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-fl-navy">
                  Suggested email · {CURRICULUM_LABELS[emailCurriculum] ?? emailCurriculum}
                </h2>
              </div>
              <span className="text-[11px] text-fl-navy/55">
                Template: <code>config/email-angles/{emailCurriculum.replaceAll("_", "-")}.md</code>
              </span>
            </div>
            <div className="p-5">
              <div className="rounded-lg border border-fl-navy/10 bg-fl-off-white/30 p-5">
                {email.subject ? (
                  <p className="mb-3 text-sm font-semibold text-fl-navy">
                    <span className="text-fl-navy/55">Subject:</span>{" "}
                    {email.subject}
                  </p>
                ) : null}
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-fl-navy">
                  {email.body}
                </pre>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <CopyButton
                  text={fullEmail}
                  label="Copy email"
                  variant="primary"
                />
                <CopyButton text={email.subject} label="Copy subject only" />
                <SendToInstantlyButton
                  institutionId={inst.id}
                  hasEmail={Boolean(inst.headEmail || inst.generalEmail)}
                />
              </div>
              {isClaudeEnabled() ? (
                <div className="mt-5 border-t border-fl-navy/10 pt-4">
                  <PolishWithClaudeButton institutionId={inst.id} />
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card">
            <h2 className="text-lg font-semibold text-fl-navy">
              Findings <span className="text-fl-navy/40">({nonSuppressed.length})</span>
            </h2>
            <p className="mt-1 text-xs text-fl-navy/55">
              Each finding traces to the verbatim sentence in the report.
              Phrases appearing in &ldquo;What the school needs to improve&rdquo;
              sections carry a 2× weight.
            </p>

            {groupedFindings.map(([curriculum, list]) => (
              <div key={curriculum} className="mt-6">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-fl-navy">
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${CURRICULUM_ACCENTS[curriculum] ?? "bg-fl-orange"}`}
                  />
                  {CURRICULUM_LABELS[curriculum] ?? curriculum}{" "}
                  <span className="text-fl-navy/40">({list.length})</span>
                </h3>
                <ul className="space-y-2">
                  {list.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-lg border border-fl-navy/10 bg-white p-3"
                    >
                      <div className="flex items-center justify-between text-xs text-fl-navy/55">
                        <span>
                          <span className="font-mono text-fl-blue">
                            {f.phraseId}
                          </span>
                          {" · "}
                          {SECTION_LABELS[f.sectionKey] ?? f.sectionKey}
                        </span>
                        <span className="font-medium text-fl-navy">
                          severity {f.finalSeverity.toFixed(1)}
                        </span>
                      </div>
                      <blockquote className="mt-2 border-l-2 border-fl-orange/60 pl-3 text-sm italic text-fl-navy/90">
                        &ldquo;{f.sourceQuote}&rdquo;
                      </blockquote>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {!groupedFindings.length ? (
              <p className="mt-3 text-sm text-fl-navy/55">
                No findings flagged for this institution.
              </p>
            ) : null}
          </section>
        </div>

        <aside className="space-y-5">
          <Card title="Latest inspection">
            {latest ? (
              <dl className="space-y-2.5 text-sm">
                <Row label="Date">{formatDate(latest.inspectionStartDate)}</Row>
                <Row label="Body">
                  <span className="capitalize">{latest.inspectionBody}</span>
                </Row>
                {latest.inspectionType ? (
                  <Row label="Type">{latest.inspectionType}</Row>
                ) : null}
                <Row label="Overall grade">
                  {latest.overallGrade ? (
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                        gradeBadgeClass(latest.overallGrade)
                      }
                    >
                      {gradeLabel(latest.overallGrade)}
                    </span>
                  ) : (
                    <span className="text-fl-navy/45">
                      Not in current MI snapshot
                    </span>
                  )}
                </Row>
                {previous?.overallGrade ? (
                  <Row label="Previous grade">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
                        gradeBadgeClass(previous.overallGrade)
                      }
                    >
                      {gradeLabel(previous.overallGrade)}
                    </span>
                  </Row>
                ) : null}
                {latest.reportUrl ? (
                  <Row label="Report">
                    <a
                      href={latest.reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="fl-link"
                    >
                      Open report ↗
                    </a>
                  </Row>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-fl-navy/45">No inspection on record.</p>
            )}
          </Card>

          <FrameworkPanel inst={inst} latest={latest} />



          <Card title="Contact">
            <dl className="space-y-2.5 text-sm">
              <Row label="Headteacher">{inst.headName ?? "—"}</Row>
              <Row label="Email">
                {inst.headEmail || inst.generalEmail || (
                  <span className="text-fl-navy/45">
                    Not in GIAS — add manually before pushing to Instantly
                  </span>
                )}
              </Row>
              <Row label="Phone">{inst.phone ?? "—"}</Row>
              <Row label="Website">
                {inst.website ? (
                  <a
                    href={inst.website}
                    target="_blank"
                    rel="noreferrer"
                    className="fl-link truncate"
                  >
                    {inst.website}
                  </a>
                ) : (
                  "—"
                )}
              </Row>
            </dl>
          </Card>

          {insps.length > 1 ? (
            <Card title={`Inspection history (${insps.length})`}>
              <ul className="space-y-2 text-sm">
                {insps.slice(0, 8).map((i) => (
                  <li key={i.id} className="flex items-center gap-2">
                    <span className="text-fl-navy/55">
                      {formatDate(i.inspectionStartDate)}
                    </span>
                    {i.overallGrade ? (
                      <span
                        className={
                          "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          gradeBadgeClass(i.overallGrade)
                        }
                      >
                        {gradeLabel(i.overallGrade)}
                      </span>
                    ) : null}
                    {i.inspectionType ? (
                      <span className="text-xs text-fl-navy/55">
                        {i.inspectionType}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </main>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-fl-navy/65">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-fl-navy/45">
        {label}
      </dt>
      <dd className="mt-0.5 text-fl-navy">{children}</dd>
    </div>
  );
}

function phraseLabel(phraseId: string): string {
  return phraseId
    .replace(/^[a-z_]+\./, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupFindings(
  finds: Array<{
    id: number;
    phraseId: string;
    sectionKey: string;
    sourceQuote: string;
    finalSeverity: number;
  }>,
): [string, typeof finds][] {
  const byCurriculum: Record<string, typeof finds> = {};
  const PREFIX_TO_CURRICULUM: Record<string, string> = {
    fin_lit: "financial_literacy",
    emp: "employability_skills",
    cr: "confidence_resilience",
    os: "online_safety",
    shared: "confidence_resilience",
  };
  for (const f of finds) {
    const prefix = f.phraseId.split(".")[0];
    const curr = PREFIX_TO_CURRICULUM[prefix] ?? "other";
    if (!byCurriculum[curr]) byCurriculum[curr] = [];
    byCurriculum[curr].push(f);
  }
  return Object.entries(byCurriculum)
    .map(([k, v]): [string, typeof finds] => [
      k,
      v.sort((a, b) => b.finalSeverity - a.finalSeverity),
    ])
    .sort((a, b) => b[1].length - a[1].length);
}
