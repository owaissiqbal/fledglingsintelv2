/**
 * Generate per-ITP markdown intelligence briefs.
 *
 * One file per ITP at `data/briefs/<ukprn>-<slug>.md`. Each brief is a
 * self-contained sales document covering:
 *   - identity (UKPRN, postcode, type, size)
 *   - opportunity score breakdown (urgency vs pipeline)
 *   - latest Ofsted with sub-judgements
 *   - all Fledglings-relevant findings (verbatim quotes, source section)
 *   - active compliance notices (APAR / ESFA / DfE / Companies House)
 *   - high-trigger news with Claude-extracted angles
 *   - recommended Fledglings curriculum to lead with + the verbatim quote
 *     to weave into outreach
 *
 * By default writes briefs only for tier=critical or tier=high. Override:
 *   pnpm tsx scripts/generate-itp-briefs.ts --tier=critical,high,worth_a_look
 *   pnpm tsx scripts/generate-itp-briefs.ts --type=fe_college
 *   pnpm tsx scripts/generate-itp-briefs.ts --limit=20
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { client } from "../src/db";

type Args = {
  tiers: string[];
  types: string[];
  limit: number;
};

function parseArgs(argv: string[]): Args {
  // Default to all training-provider-shaped types — ITPs and universities
  // both buy Fledglings, FE colleges sit nicely between them. Restrict
  // by tier to keep brief volume manageable.
  const out: Args = {
    tiers: ["critical", "high"],
    types: ["itp", "university", "fe_college"],
    limit: 0,
  };
  for (const a of argv.slice(2)) {
    if (a === "--all") {
      out.tiers = ["critical", "high", "worth_a_look", "skip"];
    } else if (a.startsWith("--tier=")) {
      out.tiers = a.slice("--tier=".length).split(",");
    } else if (a.startsWith("--type=")) {
      out.types = a.slice("--type=".length).split(",");
    } else if (a.startsWith("--limit=")) {
      out.limit = Number(a.slice("--limit=".length));
    }
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const CURRICULUM_LABEL: Record<string, string> = {
  financial_literacy: "Financial Literacy",
  employability_skills: "Employability Skills",
  confidence_resilience: "Confidence & Resilience",
  online_safety: "Online Safety",
};

function tierBadge(t: string | null): string {
  switch (t) {
    case "critical": return "🔴 CRITICAL";
    case "high": return "🟠 HIGH";
    case "worth_a_look": return "🟡 worth a look";
    default: return t ?? "—";
  }
}

function gradeBadge(g: string | null): string {
  if (!g) return "—";
  if (g === "outstanding") return `🟢 ${g}`;
  if (g === "good") return `🔵 ${g}`;
  if (g === "requires_improvement") return `🟠 requires improvement`;
  if (g === "inadequate") return `🔴 inadequate`;
  return g;
}

async function loadCohort(args: Args) {
  const tierClause = args.tiers.map(() => "?").join(",");
  const typeClause = args.types.map(() => "?").join(",");
  const limitClause = args.limit > 0 ? `LIMIT ${args.limit}` : "";

  const r = await client.execute({
    sql: `SELECT
            i.id, i.name, i.urn, i.ukprn, i.type, i.region, i.local_authority,
            i.postcode, i.address, i.website, i.general_email, i.head_email,
            i.head_name, i.apprenticeship_standards,
            os.tier, os.score, os.urgency_score, os.pipeline_value_score,
            os.financial_literacy_score, os.employability_skills_score,
            os.confidence_resilience_score, os.online_safety_score,
            os.top_curriculum, os.top_curriculum_score, os.critical_signals,
            os.inspection_count, os.first_inspection_date, os.latest_inspection_date,
            os.top_finding_id
          FROM institutions i
          JOIN opportunity_scores os ON os.institution_id = i.id
          WHERE i.in_scope = 1
            AND os.tier IN (${tierClause})
            AND i.type IN (${typeClause})
          ORDER BY os.urgency_score DESC, os.score DESC
          ${limitClause}`,
    args: [...args.tiers, ...args.types],
  });
  return r.rows as unknown as Record<string, unknown>[];
}

async function loadInspectionHistory(institutionId: number) {
  const r = await client.execute({
    sql: `SELECT
            inspection_start_date, publication_date, inspection_body, framework,
            overall_grade, previous_overall_grade, grade_dropped,
            quality_of_education, behaviour_attitudes, personal_development,
            leadership_management, sixth_form_provision, apprenticeships,
            adult_learning_programmes, safeguarding_effective,
            young_peoples_provision, high_needs_provision, contribution_to_skills,
            report_url
          FROM inspections
          WHERE institution_id = ?
          ORDER BY inspection_start_date DESC`,
    args: [institutionId],
  });
  return r.rows as unknown as Record<string, unknown>[];
}

async function loadFindings(institutionId: number) {
  const r = await client.execute({
    sql: `SELECT phrase_id, section_key, source_quote, final_severity
          FROM findings
          WHERE institution_id = ? AND suppressed = 0
          ORDER BY final_severity DESC
          LIMIT 12`,
    args: [institutionId],
  });
  return r.rows as unknown as Record<string, unknown>[];
}

// Pull the verbatim "what the provider/school needs to improve" section
// (and "areas for action" / "areas for improvement" — Ofsted's language
// varies by framework) for the LATEST inspection. This is the single
// most useful piece of report text for sales — it tells us in the
// inspector's own words what the institution is being told to fix.
async function loadKeyReportSections(institutionId: number) {
  const r = await client.execute({
    sql: `SELECT rs.section_key, rs.section_title, rs.section_text, rs.order_index
          FROM inspections insp
          JOIN report_sections rs ON rs.inspection_id = insp.id
          WHERE insp.institution_id = ?
            AND rs.section_key IN (
              'what_provider_needs_to_improve',
              'what_school_needs_to_improve',
              'areas_for_action',
              'areas_for_improvement',
              'recommendations',
              'main_findings'
            )
          ORDER BY insp.inspection_start_date DESC, rs.order_index ASC`,
    args: [institutionId],
  });
  return r.rows as unknown as Record<string, unknown>[];
}

async function loadCompliance(institutionId: number) {
  const r = await client.execute({
    sql: `SELECT notice_body, notice_type, severity, subject, details,
                 source_url, issued_at, withdrawn_at
          FROM compliance_notices
          WHERE institution_id = ?
          ORDER BY withdrawn_at IS NOT NULL, severity DESC`,
    args: [institutionId],
  });
  return r.rows as unknown as Record<string, unknown>[];
}

async function loadNews(institutionId: number) {
  const r = await client.execute({
    sql: `SELECT title, source, url, excerpt, published_at,
                 trigger_severity, relevance, curricula_tagged, angle
          FROM news_items
          WHERE institution_id = ?
            AND relevance >= 50
            AND (trigger_severity > 0 OR angle IS NULL)
          ORDER BY trigger_severity DESC, published_at DESC
          LIMIT 8`,
    args: [institutionId],
  });
  return r.rows as unknown as Record<string, unknown>[];
}

const SECTION_LABEL: Record<string, string> = {
  what_provider_needs_to_improve: "What this provider needs to improve",
  what_school_needs_to_improve: "What this school needs to improve",
  areas_for_action: "Areas for action",
  areas_for_improvement: "Areas for improvement",
  recommendations: "Recommendations",
  main_findings: "Main findings",
};

function renderBrief(
  inst: Record<string, unknown>,
  insps: Record<string, unknown>[],
  finds: Record<string, unknown>[],
  comp: Record<string, unknown>[],
  news: Record<string, unknown>[],
  sections: Record<string, unknown>[],
): string {
  const out: string[] = [];
  const name = inst.name as string;
  const tier = inst.tier as string;
  const score = inst.score as number;

  out.push(`# ${name}`);
  out.push("");
  out.push(`**${tierBadge(tier)}** · score **${score}** · urgency ${inst.urgency_score} · pipeline ${inst.pipeline_value_score}`);
  out.push("");
  out.push("## Identity");
  out.push("");
  out.push(`- **Type**: ${inst.type}${inst.apprenticeship_standards ? ` · ${inst.apprenticeship_standards} apprenticeship standards` : ""}`);
  if (inst.ukprn) out.push(`- **UKPRN**: ${inst.ukprn}`);
  if (inst.urn) out.push(`- **URN**: ${inst.urn}`);
  if (inst.postcode || inst.region || inst.local_authority) {
    const loc = [inst.postcode, inst.local_authority, inst.region].filter(Boolean).join(", ");
    out.push(`- **Location**: ${loc}`);
  }
  if (inst.website) out.push(`- **Website**: ${inst.website}`);
  if (inst.general_email) out.push(`- **Email**: ${inst.general_email}`);
  if (inst.head_name) out.push(`- **Lead contact**: ${inst.head_name}`);
  out.push("");

  out.push("## Lead-with curriculum");
  out.push("");
  if (inst.top_curriculum) {
    out.push(`**${CURRICULUM_LABEL[inst.top_curriculum as string]}** (sub-score ${inst.top_curriculum_score})`);
    out.push("");
    const breakdown = [
      ["Financial Literacy", inst.financial_literacy_score],
      ["Employability Skills", inst.employability_skills_score],
      ["Confidence & Resilience", inst.confidence_resilience_score],
      ["Online Safety", inst.online_safety_score],
    ] as [string, number][];
    out.push(breakdown.map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  } else {
    out.push("_No curriculum recommendation yet (no inspection signal)._");
  }
  out.push("");

  out.push("## Why this is on the list");
  out.push("");
  const signals = ((inst.critical_signals as string) ?? "")
    .split(" · ")
    .filter((s) => s.trim());
  if (signals.length === 0) {
    out.push("_No signals recorded._");
  } else {
    for (const s of signals) out.push(`- ${s}`);
  }
  out.push("");

  out.push("## Ofsted history");
  out.push("");
  if (insps.length === 0) {
    out.push("_No inspection records on file._");
  } else {
    for (const i of insps.slice(0, 3)) {
      out.push(
        `### ${gradeBadge(i.overall_grade as string)} · ${i.inspection_start_date}${
          i.previous_overall_grade
            ? ` (was: ${i.previous_overall_grade}${i.grade_dropped ? " — dropped" : ""})`
            : ""
        }`,
      );
      out.push("");
      const subs: [string, string | null][] = [
        ["Apprenticeships", i.apprenticeships as string | null],
        ["Adult learning programmes", i.adult_learning_programmes as string | null],
        ["Education programmes for young people", i.young_peoples_provision as string | null],
        ["Provision for learners with high needs", i.high_needs_provision as string | null],
        ["Contribution to meeting skills needs", i.contribution_to_skills as string | null],
        ["Quality of education", i.quality_of_education as string | null],
        ["Behaviour and attitudes", i.behaviour_attitudes as string | null],
        ["Personal development", i.personal_development as string | null],
        ["Leadership and management", i.leadership_management as string | null],
      ];
      const present = subs.filter(([, v]) => v);
      for (const [k, v] of present) out.push(`- ${k}: **${v}**`);
      const sg = i.safeguarding_effective;
      if (sg !== null && sg !== undefined) {
        out.push(`- Safeguarding: ${sg ? "Met" : "**NOT MET**"}`);
      }
      if (i.report_url) out.push(`- [Report](${i.report_url})`);
      out.push("");
    }
    if (insps.length > 3) {
      out.push(`_+ ${insps.length - 3} earlier inspection${insps.length - 3 === 1 ? "" : "s"} in the database._`);
      out.push("");
    }
  }

  // Verbatim "what this provider needs to improve" / "areas for action"
  // section from the latest report. This is the inspector's own words —
  // the gold for outreach. We dedup by section_key (in case two latest-
  // tied inspections each have one).
  if (sections.length > 0) {
    out.push("## Verbatim from the inspector");
    out.push("");
    out.push("Direct quotes from the latest published report. Use these in outreach without paraphrasing.");
    out.push("");
    const seen = new Set<string>();
    for (const s of sections) {
      const key = s.section_key as string;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = SECTION_LABEL[key] ?? key;
      const text = ((s.section_text as string) ?? "").trim();
      if (!text || text.length < 30) continue;
      out.push(`### ${label}`);
      out.push("");
      // Render as a quote block, line by line so the markdown stays clean.
      // Cap each section to 2,000 chars so a brief is readable.
      const trimmed = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
      for (const line of trimmed.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) {
          out.push(">");
        } else {
          out.push(`> ${t}`);
        }
      }
      out.push("");
    }
  }

  out.push("## Compliance signals");
  out.push("");
  const active = comp.filter((c) => !c.withdrawn_at);
  const withdrawn = comp.filter((c) => c.withdrawn_at);
  if (active.length === 0 && withdrawn.length === 0) {
    out.push("_No public regulatory or financial-health notices on file._");
    out.push("");
  } else {
    if (active.length > 0) {
      out.push("### Active");
      out.push("");
      for (const c of active) {
        out.push(`- **${c.subject}** · severity ${c.severity}`);
        out.push(`  ${c.notice_body} · ${c.notice_type}${c.issued_at ? ` · issued ${c.issued_at}` : ""}`);
        if (c.details) out.push(`  > ${(c.details as string).slice(0, 240)}`);
        if (c.source_url) out.push(`  [Source](${c.source_url})`);
        out.push("");
      }
    }
    if (withdrawn.length > 0) {
      out.push("### Historical (withdrawn / closed)");
      out.push("");
      for (const c of withdrawn.slice(0, 4)) {
        out.push(`- ${c.subject} (closed ${c.withdrawn_at})`);
      }
      if (withdrawn.length > 4) out.push(`- _+ ${withdrawn.length - 4} more_`);
      out.push("");
    }
  }

  out.push("## News signals");
  out.push("");
  const triggers = news.filter((n) => (n.trigger_severity as number) >= 40);
  if (triggers.length === 0) {
    out.push("_No high-trigger news matched in the last extraction pass._");
    if (news.length > 0) out.push(`_(${news.length} low-signal items in DB.)_`);
    out.push("");
  } else {
    for (const n of triggers) {
      out.push(`- **${n.title}** · severity ${n.trigger_severity} · relevance ${n.relevance}`);
      out.push(`  ${n.source}${n.published_at ? ` · ${n.published_at}` : ""}${n.curricula_tagged ? ` · curricula: ${n.curricula_tagged}` : ""}`);
      if (n.angle && n.angle !== "no angle") out.push(`  > ${n.angle}`);
      if (n.url) out.push(`  [Read](${n.url})`);
      out.push("");
    }
  }

  if (finds.length > 0) {
    out.push("## Verbatim inspection findings");
    out.push("");
    out.push("Quotes you can drop directly into outreach. Severity drives the score.");
    out.push("");
    for (const f of finds.slice(0, 6)) {
      out.push(`- **${f.phrase_id}** (severity ${(f.final_severity as number).toFixed(1)}, ${f.section_key})`);
      out.push(`  > ${(f.source_quote as string).replace(/\n/g, " ").slice(0, 360)}`);
      out.push("");
    }
  }

  out.push("---");
  out.push("");
  out.push(
    `_Generated by Fledglings Inspection Intel · ${new Date().toISOString().slice(0, 10)}_`,
  );
  return out.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  const cohort = await loadCohort(args);
  console.log(`Generating briefs for ${cohort.length} institutions (tiers=${args.tiers.join(",")}, types=${args.types.join(",")})`);

  const outDir = path.resolve(process.cwd(), "data/briefs");
  mkdirSync(outDir, { recursive: true });

  let written = 0;
  for (const inst of cohort) {
    const id = inst.id as number;
    const [insps, finds, comp, news, sections] = await Promise.all([
      loadInspectionHistory(id),
      loadFindings(id),
      loadCompliance(id),
      loadNews(id),
      loadKeyReportSections(id),
    ]);
    const md = renderBrief(inst, insps, finds, comp, news, sections);
    const slug = slugify(inst.name as string);
    const ukprn = (inst.ukprn as string) || `id${id}`;
    const filename = `${ukprn}-${slug}.md`;
    writeFileSync(path.join(outDir, filename), md);
    written++;
  }
  console.log(`Wrote ${written} briefs to ${outDir}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
