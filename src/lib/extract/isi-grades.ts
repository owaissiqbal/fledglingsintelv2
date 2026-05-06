/**
 * ISI report grade extractor.
 *
 * ISI reports follow a fixed regulatory framework: "Standards relating to
 * <area> are met / are not met". We parse the standards-compliance section
 * and map each area to the corresponding Fledglings-relevant column on
 * `inspections`. Without this, ISI institutions are scored on findings
 * alone (max 55) and never reach critical/high.
 *
 * Mapping (ISI Standard area → our column):
 *   "leadership and management, and governance"          → leadershipManagement
 *   "quality of education, training and recreation"      → qualityOfEducation
 *   "pupils' physical and mental health and emotional…"  → personalDevelopment
 *   "social and cultural development of pupils"          → personalDevelopment (also)
 *   "welfare, health and safety of pupils"               → safeguardingEffective
 *   "safeguarding"                                       → safeguardingEffective
 *
 * "Met" → grade = "meets_standard" (or true for safeguarding)
 * "Not met" → "does_not_meet_standard" (or false for safeguarding); also
 *            sets overallGrade = "does_not_meet_standard" — material risk.
 */

import { eq, isNotNull, sql } from "drizzle-orm";
import { db, inspections, institutions } from "@/db";
import { log } from "../ingest/log";
import type { RunResult } from "../ingest/run";

type Outcome = "met" | "not_met";

type StandardLine = {
  area: string;
  outcome: Outcome;
  raw: string;
};

const STANDARD_PATTERN =
  /Standards?\s+relating\s+to\s+([^.]+?)\s+are\s+(not\s+met|met)\b/gi;

const AGGREGATE_NOT_MET = [
  /the school does not meet (?:all )?the (?:relevant )?standards/i,
  /(?:there are areas of|some areas of) non.?compliance/i,
  /standards have not been met/i,
];
const AGGREGATE_MET = [
  /the school meets all (?:the )?(?:relevant )?standards/i,
  /all (?:the )?(?:relevant )?standards are met/i,
];

function extractStandardsLines(text: string): StandardLine[] {
  const out: StandardLine[] = [];
  STANDARD_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = STANDARD_PATTERN.exec(text)) !== null) {
    const area = m[1].replace(/\s+/g, " ").trim().toLowerCase();
    const outcome: Outcome = /not\s+met/i.test(m[2]) ? "not_met" : "met";
    const key = `${area}|${outcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ area, outcome, raw: m[0] });
  }
  return out;
}

type Mapped = {
  safeguardingEffective: boolean | null;
  personalDevelopment: string | null;
  qualityOfEducation: string | null;
  leadershipManagement: string | null;
  overallGrade: string | null;
};

function mapStandards(lines: StandardLine[], text: string): Mapped {
  const result: Mapped = {
    safeguardingEffective: null,
    personalDevelopment: null,
    qualityOfEducation: null,
    leadershipManagement: null,
    overallGrade: null,
  };

  let anyNotMet = false;
  let anyMet = false;

  for (const line of lines) {
    const grade =
      line.outcome === "met" ? "meets_standard" : "does_not_meet_standard";
    if (line.outcome === "not_met") anyNotMet = true;
    else anyMet = true;

    if (
      /(?:welfare|safeguard|child protection|health and safety)/i.test(line.area)
    ) {
      // Compliance side
      result.safeguardingEffective =
        result.safeguardingEffective === false || line.outcome === "not_met"
          ? false
          : true;
    }
    if (
      /(?:physical and mental health|emotional wellbeing|spiritual|moral|social and cultural|smsc|personal\s*(?:and|,|$)\s*social)/i.test(
        line.area,
      )
    ) {
      result.personalDevelopment = pickWorse(result.personalDevelopment, grade);
    }
    if (
      /(?:quality of education|teaching and recreation|education,?\s*training)/i.test(
        line.area,
      )
    ) {
      result.qualityOfEducation = pickWorse(result.qualityOfEducation, grade);
    }
    if (
      /(?:leadership|management|governance)/i.test(line.area)
    ) {
      result.leadershipManagement = pickWorse(
        result.leadershipManagement,
        grade,
      );
    }
  }

  // Aggregate statements override individual lines if found.
  for (const re of AGGREGATE_NOT_MET) {
    if (re.test(text)) {
      result.overallGrade = "does_not_meet_standard";
      anyNotMet = true;
      break;
    }
  }
  if (!result.overallGrade) {
    for (const re of AGGREGATE_MET) {
      if (re.test(text)) {
        result.overallGrade = "meets_standard";
        anyMet = true;
        break;
      }
    }
  }

  // Synthesise overall if individual standards present but no aggregate.
  if (!result.overallGrade) {
    if (anyNotMet) result.overallGrade = "does_not_meet_standard";
    else if (anyMet) result.overallGrade = "meets_standard";
  }

  // Educational quality grades — descriptive section
  // Look for explicit "personal development is excellent/good/sound/unsatisfactory"
  const eqMatch = text.match(
    /personal development\s+(?:of pupils\s+)?is\s+(excellent|good|sound|unsatisfactory)/i,
  );
  if (eqMatch) {
    result.personalDevelopment =
      result.personalDevelopment ?? mapEqGrade(eqMatch[1]);
  }
  const achMatch = text.match(
    /(?:the\s+(?:quality of pupils['']?\s+)?achievement(?:\s+of pupils)?\s+is\s+|achievement is\s+)(excellent|good|sound|unsatisfactory)/i,
  );
  if (achMatch) {
    result.qualityOfEducation =
      result.qualityOfEducation ?? mapEqGrade(achMatch[1]);
  }

  return result;
}

function pickWorse(a: string | null, b: string): string {
  // does_not_meet_standard > meets_standard > null
  if (a === "does_not_meet_standard" || b === "does_not_meet_standard")
    return "does_not_meet_standard";
  if (a === "meets_standard" || b === "meets_standard") return "meets_standard";
  return b;
}

function mapEqGrade(g: string): string {
  switch (g.toLowerCase()) {
    case "excellent":
      return "outstanding";
    case "good":
      return "good";
    case "sound":
      return "requires_improvement"; // brutal-leaning: "sound" is meh
    case "unsatisfactory":
      return "inadequate";
    default:
      return g;
  }
}

export async function extractIsiGrades(): Promise<RunResult> {
  log.info("isi-grades: scanning ISI report text for compliance grades");

  const rows = await db
    .select({
      id: inspections.id,
      institutionId: inspections.institutionId,
      reportText: inspections.reportText,
      inspectionType: inspections.inspectionType,
    })
    .from(inspections)
    .where(
      sql`${inspections.inspectionBody} = 'isi' AND ${inspections.reportText} IS NOT NULL`,
    );

  log.info(`isi-grades: ${rows.length} ISI inspections to scan`);

  let updated = 0;
  let notMetCount = 0;
  let standardsExtracted = 0;
  const now = new Date();

  for (const row of rows) {
    if (!row.reportText) continue;
    const lines = extractStandardsLines(row.reportText);
    if (!lines.length) continue;

    const mapped = mapStandards(lines, row.reportText);
    standardsExtracted += lines.length;
    if (mapped.safeguardingEffective === false) notMetCount++;

    await db
      .update(inspections)
      .set({
        safeguardingEffective: mapped.safeguardingEffective ?? undefined,
        personalDevelopment: mapped.personalDevelopment ?? undefined,
        qualityOfEducation: mapped.qualityOfEducation ?? undefined,
        leadershipManagement: mapped.leadershipManagement ?? undefined,
        overallGrade: mapped.overallGrade ?? undefined,
        updatedAt: now,
      })
      .where(eq(inspections.id, row.id));
    updated++;
  }

  log.info(
    `isi-grades: complete — inspections updated=${updated}, standards parsed=${standardsExtracted}, safeguarding NOT MET=${notMetCount}`,
  );

  return {
    recordsSeen: rows.length,
    recordsUpserted: updated,
    notes: `standards_lines=${standardsExtracted}; safeguarding_not_met=${notMetCount}`,
  };
}
