import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import {
  db,
  findings,
  inspections,
  institutions,
  reportSections,
} from "@/db";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SECTION_LABELS: Record<string, string> = {
  what_school_needs_to_improve: "What the school needs to improve",
  what_provider_needs_to_improve: "What the provider needs to improve",
  recommendations: "Recommendations",
  areas_for_action: "Areas for action",
  significant_strengths: "Significant strengths",
  safeguarding: "Safeguarding",
  main_findings: "Main findings",
  summary: "Summary",
  personal_development: "Personal development",
  behaviour_attitudes: "Behaviour and attitudes",
  body: "Body",
};

async function loadSample() {
  const sample = await db
    .select({
      institutionId: findings.institutionId,
      name: institutions.name,
      region: institutions.region,
      type: institutions.type,
      inspectionStartDate: inspections.inspectionStartDate,
    })
    .from(findings)
    .innerJoin(
      institutions,
      eq(institutions.id, findings.institutionId),
    )
    .innerJoin(inspections, eq(inspections.id, findings.inspectionId))
    .where(eq(findings.suppressed, false))
    .groupBy(findings.institutionId)
    .orderBy(sql`RANDOM()`)
    .limit(10);

  const out: Array<{
    institutionId: number;
    name: string;
    region: string | null;
    type: string;
    inspectionStartDate: string | null;
    findings: Array<{
      id: number;
      phraseId: string;
      sectionKey: string;
      sourceQuote: string;
      finalSeverity: number;
    }>;
  }> = [];

  for (const s of sample) {
    const fRows = await db
      .select({
        id: findings.id,
        phraseId: findings.phraseId,
        sectionKey: findings.sectionKey,
        sourceQuote: findings.sourceQuote,
        finalSeverity: findings.finalSeverity,
      })
      .from(findings)
      .where(eq(findings.institutionId, s.institutionId))
      .orderBy(sql`${findings.finalSeverity} DESC`)
      .limit(4);

    out.push({ ...s, findings: fRows });
  }

  return out;
}

export default async function QaPage() {
  const sample = await loadSample();

  return (
    <main className="container mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fl-orange">
          Quality assurance
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fl-navy">
          Random sample of flagged institutions
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-fl-navy/65">
          Use this to spot-check the phrase library. Each finding shows the
          verbatim source quote and the section it came from. If something
          looks like a false positive, add a guard in{" "}
          <code className="rounded bg-fl-off-white px-1.5 py-0.5 text-xs">
            config/phrases/*.yaml
          </code>{" "}
          and re-run{" "}
          <code className="rounded bg-fl-off-white px-1.5 py-0.5 text-xs">
            pnpm extract
          </code>
          .
        </p>
      </div>

      <div className="space-y-6">
        {sample.map((s) => (
          <section
            key={s.institutionId}
            className="rounded-xl border border-fl-navy/10 bg-white p-5 shadow-fl-card"
          >
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-lg font-semibold text-fl-navy">
                <Link
                  href={`/opportunities/${s.institutionId}`}
                  className="hover:text-fl-orange"
                >
                  {s.name}
                </Link>
              </h2>
              <span className="text-xs text-fl-navy/55">
                {(s.type ?? "").replaceAll("_", " ")} · {s.region ?? "—"} ·{" "}
                {formatDate(s.inspectionStartDate)}
              </span>
            </div>
            <ul className="mt-4 space-y-3">
              {s.findings.map((f) => (
                <li
                  key={f.id}
                  className="rounded-lg border border-fl-navy/10 bg-fl-off-white/30 p-3"
                >
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-fl-blue">
                      {f.phraseId}
                    </span>
                    <span className="text-fl-navy/55">
                      {SECTION_LABELS[f.sectionKey] ?? f.sectionKey} ·
                      severity {f.finalSeverity.toFixed(1)}
                    </span>
                  </div>
                  <blockquote className="mt-2 border-l-2 border-fl-orange/60 pl-3 text-sm italic text-fl-navy/85">
                    &ldquo;{f.sourceQuote}&rdquo;
                  </blockquote>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!sample.length ? (
          <div className="rounded-xl border border-fl-navy/10 bg-fl-off-white p-10 text-center text-sm text-fl-navy/65">
            No findings yet. Run <code>pnpm ingest</code> to populate.
          </div>
        ) : null}
      </div>
    </main>
  );
}
