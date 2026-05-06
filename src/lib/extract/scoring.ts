/**
 * Opportunity Score recompute — v3 (brutal).
 *
 * Each Fledglings curriculum gets its OWN sub-score (0-100). The headline
 * `score` is the max of those four. Sales pick the institution AND the
 * curriculum to lead with from the same row.
 *
 * Per-curriculum sub-score is the sum of:
 *
 *   1. **Sub-judgement contribution** — capped at 70.
 *      For each sub-judgement field on the latest inspection that maps to
 *      this curriculum (per src/lib/extract/sub-judgement-mapping.ts):
 *        contribution = grade_urgency × mapping_weight × 35
 *      Mappings are framework-aware — schools use EIF judgements, FE/ITP
 *      use the FE & Skills judgements (apprenticeships, adult learning,
 *      young people's provision, etc.), ISI uses ISI fields.
 *
 *   2. **Findings contribution** — capped at 30.
 *      Section-weighted phrase matches in the report, summed per
 *      mapped curriculum, scaled and clipped.
 *
 *   3. **Hard floor signals** — non-negotiable, override the cap.
 *        - safeguardingEffective = false → online_safety ≥ 90
 *        - Personal Development "Inadequate" → confidence_resilience ≥ 85
 *        - Apprenticeships "Inadequate" → employability_skills ≥ 88
 *        - Overall "Inadequate" → all curricula raised to ≥ 60
 *
 *   4. **Synergy multiplier** — when 2+ critical signals fire on the same
 *      institution, every sub-score × 1.20 (capped at 100).
 *
 * Tier from headline:
 *   - 90-100 critical
 *   - 70-89 high
 *   - 50-69 worth_a_look
 *   - 0-49 skip
 */

import { eq, sql } from "drizzle-orm";
import {
  complianceNotices,
  curriculumMatches,
  db,
  findings,
  inspections,
  institutions,
  newsItems,
  opportunityScores,
} from "@/db";
import { gradeUrgency } from "../grades";
import { log } from "../ingest/log";
import { getMappings, type Curriculum } from "./sub-judgement-mapping";
import type { RunResult } from "../ingest/run";

const CURRICULA: Curriculum[] = [
  "financial_literacy",
  "employability_skills",
  "confidence_resilience",
  "online_safety",
];

const CURRICULUM_LABELS: Record<Curriculum, string> = {
  financial_literacy: "Financial Literacy",
  employability_skills: "Employability Skills",
  confidence_resilience: "Confidence & Resilience",
  online_safety: "Online Safety",
};

// Section focus on findings — phrases in these sections map directly to
// Fledglings curricula even before reading the phrase.
function sectionFocus(sectionKey: string): number {
  switch (sectionKey) {
    case "safeguarding":
      return 1.6;
    case "personal_development":
      return 1.5;
    case "behaviour_attitudes":
      return 1.3;
    case "what_school_needs_to_improve":
    case "what_provider_needs_to_improve":
    case "areas_for_action":
      return 1.0;
    case "recommendations":
    case "areas_for_improvement":
      return 1.0;
    case "main_findings":
      return 0.7;
    case "summary":
      return 0.3;
    case "significant_strengths":
    case "strengths":
      return 0.0;
    default:
      return 0.5;
  }
}

const SUB_JUDGEMENT_WEIGHT = 35;
const SUB_JUDGEMENT_CAP = 70;
// Finding contribution is non-linear: a few findings get full credit, but
// once an inspection passes a saturation point we stop rewarding verbosity.
// A school with 30 mentions of "personal development" isn't 30× more urgent
// than one with one targeted action-section flag.
const FINDING_SATURATION = 25; // raw curriculum-finding total at which we hit the cap
const FINDING_CAP = 55;

// Tier rules — separate the two axes deliberately.
// `critical` means "act today": there is a fresh, public, time-sensitive trigger
// (Inadequate / RI / safeguarding fail / specific judgement urgency, and later
// also compliance notices and news flags). Pure pipeline-fit is never enough
// to be critical — that just means "good prospect", not "buying right now".
//
// Bands:
//   - critical:    urgency >= 70 (real trigger to act on)
//   - high:        urgency >= 50, OR pipeline >= 92 with urgency >= 30 (top-tier prospect with at least minor signal)
//   - worth_a_look: pipeline >= 60, OR urgency >= 30 (in the universe, no specific trigger)
//   - skip:        everything else
function tierFor(urgency: number, pipeline: number): string {
  if (urgency >= 70) return "critical";
  if (urgency >= 50) return "high";
  if (pipeline >= 92 && urgency >= 30) return "high";
  if (pipeline >= 60) return "worth_a_look";
  if (urgency >= 30) return "worth_a_look";
  return "skip";
}

// Grade-based ceiling on the headline `score`. Reserves the top of the
// scale for institutions that have ACTUALLY failed an inspection. A
// massive established ITP with full pipeline value but no urgency signal
// shouldn't read 100 — it should read ~75 ("solid prospect, no fire").
//
// Urgency overrides the ceiling: if compliance / news has driven urgency
// above the grade ceiling, the score reflects that instead. So a Good-
// rated ITP with active financial-NTI urgency 85 gets headline 85, not
// capped at 75.
function gradeCeiling(grade: string | null | undefined): number {
  switch (grade) {
    case "inadequate":
    case "does_not_meet_standard":
      return 100;
    case "requires_improvement":
      return 95;
    case "good":
    case "meets_standard":
      return 75;
    case "outstanding":
      return 60;
    case "not_judged":
      return 80;
    default:
      // No inspection on file — could be brand-new, dormant, or high-end
      // (Outstanding's just-published reports). Default mid-band.
      return 80;
  }
}

type LatestInspection = {
  id: number;
  institutionId: number;
  inspectionStartDate: string;
  inspectionBody: string;
  type: string;
  inScope: boolean;
  // Sub-judgement columns
  safeguardingEffective: boolean | null;
  personalDevelopment: string | null;
  personalDevWellbeing: string | null;
  behaviourAttitudes: string | null;
  attendanceBehaviour: string | null;
  inclusion: string | null;
  qualityOfEducation: string | null;
  curriculumTeaching: string | null;
  achievement: string | null;
  sixthFormProvision: string | null;
  apprenticeships: string | null;
  adultLearningProgrammes: string | null;
  youngPeoplesProvision: string | null;
  highNeedsProvision: string | null;
  contributionToSkills: string | null;
  overallGrade: string | null;
};

function gradeValueFromField(
  inspection: LatestInspection,
  field: string,
): { display: string | null; urgency: number } {
  if (field === "safeguardingEffective") {
    if (inspection.safeguardingEffective === false)
      return { display: "Not met", urgency: 1.0 };
    if (inspection.safeguardingEffective === true)
      return { display: "Met", urgency: -0.05 };
    return { display: null, urgency: 0 };
  }
  const value = (inspection as unknown as Record<string, string | null>)[field];
  if (!value) return { display: null, urgency: 0 };
  return { display: prettyGrade(value), urgency: gradeUrgency(value) };
}

function prettyGrade(g: string): string {
  switch (g) {
    case "outstanding":
      return "Outstanding";
    case "good":
      return "Good";
    case "requires_improvement":
      return "Requires improvement";
    case "inadequate":
      return "Inadequate";
    case "meets_standard":
      return "Met";
    case "does_not_meet_standard":
      return "Not met";
    case "not_judged":
      return "Not judged";
    default:
      return g;
  }
}

type InspMeta = {
  count: number;
  earliest: string;
  latest: string;
  bestGrade: string | null;
};

const GRADE_RANK: Record<string, number> = {
  outstanding: 1,
  good: 2,
  meets_standard: 2,
  requires_improvement: 3,
  inadequate: 4,
  does_not_meet_standard: 4,
};

function isGradeBetter(a: string, b: string | null): boolean {
  if (!b) return true;
  const ra = GRADE_RANK[a] ?? 99;
  const rb = GRADE_RANK[b] ?? 99;
  return ra < rb;
}

function computePipelineValue(opts: {
  type: string;
  inspMeta: InspMeta | undefined;
  hasContact: boolean;
  hasWebsite: boolean;
  fromApar: boolean;
  source: string | null;
  apprenticeshipStandards: number;
}): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  // Pipeline value applies to commercial training providers, FE colleges,
  // sixth-form colleges, universities (degree apprenticeships) and APAR
  // employer-providers — they're prospects regardless of inspection grade.
  // Schools (state / independent) are scored on inspection urgency only.
  const eligible = [
    "itp",
    "fe_college",
    "sixth_form_college",
    "university",
    "employer",
  ].includes(opts.type);
  if (!eligible) return { score: 0, signals: [] };

  // Baseline — being a known UK training provider is itself signal enough
  // to warrant outreach. Set so a typical mid-size APAR-listed provider
  // with website + email lands ~70-80 (worth_a_look), and only the genuinely
  // big established ones with multi-decade track records reach pipeline 92+.
  score += 35;

  if (opts.fromApar) {
    score += 18;
    signals.push("APAR-listed approved provider");
  }

  if (opts.inspMeta) {
    if (opts.inspMeta.count >= 5) {
      score += 18;
      signals.push(`${opts.inspMeta.count}+ historical inspections (very established)`);
    } else if (opts.inspMeta.count >= 3) {
      score += 14;
      signals.push(`${opts.inspMeta.count}+ historical inspections (established)`);
    } else if (opts.inspMeta.count >= 1) {
      score += 8;
      signals.push("Has Ofsted track record");
    }

    // Recency: last inspection within 24 months = active
    const latestMs = Date.parse(opts.inspMeta.latest);
    const ageMonths = (Date.now() - latestMs) / (1000 * 60 * 60 * 24 * 30.44);
    if (ageMonths <= 24) {
      score += 12;
      signals.push("Active (inspected within 24 months)");
    } else if (ageMonths <= 60) {
      score += 6;
      signals.push("Inspected within 5 years");
    }

    // Years operating (proxy for size/longevity)
    const earliestMs = Date.parse(opts.inspMeta.earliest);
    const yearsOperating = (Date.now() - earliestMs) / (1000 * 60 * 60 * 24 * 365.25);
    if (yearsOperating >= 15) {
      score += 12;
      signals.push(`${Math.floor(yearsOperating)}+ years on Ofsted register`);
    } else if (yearsOperating >= 10) {
      score += 8;
      signals.push(`${Math.floor(yearsOperating)}+ years on Ofsted register`);
    } else if (yearsOperating >= 5) {
      score += 5;
    }

    // Track record: best historical grade
    if (opts.inspMeta.bestGrade === "outstanding") {
      score += 8;
      signals.push("Previously rated Outstanding");
    } else if (opts.inspMeta.bestGrade === "good") {
      score += 5;
      signals.push("Previously rated Good");
    }
  }

  if (opts.hasContact) {
    score += 15;
    signals.push("Reachable (email on file)");
  }
  if (opts.hasWebsite) {
    score += 8;
    signals.push("Website on file");
  }

  // Apprenticeship-standards count = the most reliable size proxy we have.
  // Big providers (Lifetime, Kaplan, Babington) deliver 20-50+ standards;
  // niche providers deliver 1-5. This is the signal that distinguishes
  // household-name ITPs from one-trick-pony training shops.
  const std = opts.apprenticeshipStandards;
  if (std >= 50) {
    score += 28;
    signals.push(`${std} apprenticeship standards delivered (major provider)`);
  } else if (std >= 25) {
    score += 20;
    signals.push(`${std} apprenticeship standards delivered (large provider)`);
  } else if (std >= 10) {
    score += 12;
    signals.push(`${std} apprenticeship standards delivered`);
  } else if (std >= 3) {
    score += 5;
    signals.push(`${std} apprenticeship standards delivered`);
  }

  return { score: Math.min(100, score), signals };
}

export async function recomputeOpportunityScores(): Promise<RunResult> {
  log.info(`score: v3 (brutal + pipeline) — loading inspection grades + findings`);

  // 0. Inspection counts + recency + best grade per institution — feeds
  //    pipeline value scoring.
  const allInspectionsLite = await db
    .select({
      institutionId: inspections.institutionId,
      inspectionStartDate: inspections.inspectionStartDate,
      overallGrade: inspections.overallGrade,
    })
    .from(inspections);

  const inspMeta = new Map<number, InspMeta>();
  for (const r of allInspectionsLite) {
    let m = inspMeta.get(r.institutionId);
    if (!m) {
      m = {
        count: 0,
        earliest: r.inspectionStartDate,
        latest: r.inspectionStartDate,
        bestGrade: null,
      };
      inspMeta.set(r.institutionId, m);
    }
    m.count++;
    if (r.inspectionStartDate < m.earliest) m.earliest = r.inspectionStartDate;
    if (r.inspectionStartDate > m.latest) m.latest = r.inspectionStartDate;
    if (
      r.overallGrade &&
      isGradeBetter(r.overallGrade, m.bestGrade)
    ) {
      m.bestGrade = r.overallGrade;
    }
  }

  // 1. Latest inspection per institution (with all sub-judgement columns).
  const inspectionRows = await db
    .select({
      id: inspections.id,
      institutionId: inspections.institutionId,
      inspectionStartDate: inspections.inspectionStartDate,
      inspectionBody: inspections.inspectionBody,
      safeguardingEffective: inspections.safeguardingEffective,
      personalDevelopment: inspections.personalDevelopment,
      personalDevWellbeing: inspections.personalDevWellbeing,
      behaviourAttitudes: inspections.behaviourAttitudes,
      attendanceBehaviour: inspections.attendanceBehaviour,
      inclusion: inspections.inclusion,
      qualityOfEducation: inspections.qualityOfEducation,
      curriculumTeaching: inspections.curriculumTeaching,
      achievement: inspections.achievement,
      sixthFormProvision: inspections.sixthFormProvision,
      apprenticeships: inspections.apprenticeships,
      adultLearningProgrammes: inspections.adultLearningProgrammes,
      youngPeoplesProvision: inspections.youngPeoplesProvision,
      highNeedsProvision: inspections.highNeedsProvision,
      contributionToSkills: inspections.contributionToSkills,
      overallGrade: inspections.overallGrade,
      type: institutions.type,
      inScope: institutions.inScope,
    })
    .from(inspections)
    .innerJoin(institutions, eq(institutions.id, inspections.institutionId));

  const latestByInst = new Map<number, LatestInspection>();
  for (const r of inspectionRows) {
    const cur = latestByInst.get(r.institutionId);
    if (!cur || r.inspectionStartDate > cur.inspectionStartDate) {
      latestByInst.set(r.institutionId, r as LatestInspection);
    }
  }

  // 2. Findings — section-weighted, mapped to curricula.
  const findingRows = await db
    .select({
      institutionId: findings.institutionId,
      findingId: findings.id,
      finalSeverity: findings.finalSeverity,
      sectionKey: findings.sectionKey,
      curriculum: curriculumMatches.curriculum,
    })
    .from(findings)
    .innerJoin(
      curriculumMatches,
      eq(curriculumMatches.findingId, findings.id),
    )
    .where(eq(findings.suppressed, false));

  type FindingBucket = {
    perCurriculum: Map<Curriculum, number>;
    findingIds: Set<number>;
    topFindingId: number | null;
    topFindingContribution: number;
  };
  const findingBag = new Map<number, FindingBucket>();
  for (const r of findingRows) {
    let bag = findingBag.get(r.institutionId);
    if (!bag) {
      bag = {
        perCurriculum: new Map(),
        findingIds: new Set(),
        topFindingId: null,
        topFindingContribution: 0,
      };
      findingBag.set(r.institutionId, bag);
    }
    const focus = sectionFocus(r.sectionKey);
    const contribution = r.finalSeverity * focus;
    const key = r.curriculum as Curriculum;
    if (CURRICULA.includes(key)) {
      bag.perCurriculum.set(
        key,
        (bag.perCurriculum.get(key) ?? 0) + contribution,
      );
    }
    bag.findingIds.add(r.findingId);
    if (contribution > bag.topFindingContribution) {
      bag.topFindingContribution = contribution;
      bag.topFindingId = r.findingId;
    }
  }

  // 2c. Compliance signals — ESFA / DfE / RoATP-derived / Companies House.
  // Each active notice contributes a curriculum-agnostic urgency boost; the
  // worst becomes the institution's compliance flag. Withdrawn notices don't
  // count.
  type CompliancePunch = {
    body: string;
    type: string;
    severity: number;
    subject: string;
  };
  const compliancePunches = new Map<number, CompliancePunch[]>();
  const allCompliance = await db
    .select({
      institutionId: complianceNotices.institutionId,
      noticeBody: complianceNotices.noticeBody,
      noticeType: complianceNotices.noticeType,
      severity: complianceNotices.severity,
      subject: complianceNotices.subject,
      withdrawnAt: complianceNotices.withdrawnAt,
    })
    .from(complianceNotices);
  for (const r of allCompliance) {
    if (r.withdrawnAt) continue;
    let arr = compliancePunches.get(r.institutionId);
    if (!arr) {
      arr = [];
      compliancePunches.set(r.institutionId, arr);
    }
    arr.push({
      body: r.noticeBody,
      type: r.noticeType,
      severity: r.severity,
      subject: r.subject,
    });
  }

  // 2d. News signals — per-institution highest-trigger article in the
  // last 12 months. Only items with relevance >= 60 count.
  type NewsPunch = {
    title: string;
    angle: string | null;
    triggerSeverity: number;
    publishedAt: string | null;
    curricula: string[];
  };
  const newsPunches = new Map<number, NewsPunch[]>();
  // Include news where (trigger_severity >= 70) OR (relevance >= 60).
  // High-trigger items shouldn't be dropped because the LLM rated
  // relevance conservatively — a "Southampton Solent staff strike" article
  // can be relevance-15 in the LLM's eyes (union piece, syndicated
  // headline) but trigger-severity-75 to a sales rep. The trigger field
  // is the buying signal; relevance is just an extra noise filter.
  const allNews = await db
    .select({
      institutionId: newsItems.institutionId,
      title: newsItems.title,
      angle: newsItems.angle,
      triggerSeverity: newsItems.triggerSeverity,
      publishedAt: newsItems.publishedAt,
      curriculaTagged: newsItems.curriculaTagged,
      relevance: newsItems.relevance,
    })
    .from(newsItems)
    .where(
      sql`${newsItems.triggerSeverity} >= 70 OR ${newsItems.relevance} >= 60`,
    );
  for (const r of allNews) {
    let arr = newsPunches.get(r.institutionId);
    if (!arr) {
      arr = [];
      newsPunches.set(r.institutionId, arr);
    }
    arr.push({
      title: r.title,
      angle: r.angle,
      triggerSeverity: r.triggerSeverity,
      publishedAt: r.publishedAt,
      curricula: (r.curriculaTagged ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  }

  // 2b. Prefetch contact + APAR-source flags for every institution so the
  //     pipeline value calc is a Map lookup, not a per-row DB hit.
  const contactRows = await db
    .select({
      id: institutions.id,
      website: institutions.website,
      generalEmail: institutions.generalEmail,
      headEmail: institutions.headEmail,
      source: institutions.source,
      apprenticeshipStandards: institutions.apprenticeshipStandards,
    })
    .from(institutions);
  type InstContact = {
    hasContact: boolean;
    hasWebsite: boolean;
    fromApar: boolean;
    source: string | null;
    apprenticeshipStandards: number;
  };
  const instContactMap = new Map<number, InstContact>();
  for (const r of contactRows) {
    instContactMap.set(r.id, {
      hasContact: Boolean(r.generalEmail || r.headEmail),
      hasWebsite: Boolean(r.website),
      fromApar: (r.source ?? "").includes("apar"),
      source: r.source ?? null,
      apprenticeshipStandards: r.apprenticeshipStandards ?? 0,
    });
  }

  // 3. Score every in-scope institution that has either sub-judgements
  //    OR findings. FE/ITP with grades alone get scored. Schools with
  //    just findings get scored.
  await db.delete(opportunityScores);
  const now = new Date();
  let upserted = 0;
  let critical = 0;
  let high = 0;
  let worthLook = 0;

  for (const [instId, latest] of latestByInst) {
    if (!latest.inScope) continue;
    const bag = findingBag.get(instId);
    const mappings = getMappings(latest.inspectionBody, latest.type);

    // Per-curriculum sub-scores
    const subScores: Record<Curriculum, number> = {
      financial_literacy: 0,
      employability_skills: 0,
      confidence_resilience: 0,
      online_safety: 0,
    };
    const signals: string[] = [];
    let criticalSignalCount = 0;

    for (const c of CURRICULA) {
      let judgementSum = 0;
      for (const m of mappings) {
        const { display, urgency } = gradeValueFromField(latest, m.field);
        if (urgency <= 0 || !display) continue; // only weak grades contribute
        const w = m.weights[c];
        if (w <= 0) continue;
        judgementSum += urgency * w * SUB_JUDGEMENT_WEIGHT;
      }
      const judgement = Math.min(SUB_JUDGEMENT_CAP, judgementSum);

      const findingTotal = bag?.perCurriculum.get(c) ?? 0;
      // Sqrt curve: 1 finding ≈ 11pts, 4 ≈ 22, 9 ≈ 33, 25 ≈ 55 (cap).
      // Stops verbose reports from running away with the score.
      const findingScore =
        findingTotal > 0
          ? Math.min(
              FINDING_CAP,
              Math.sqrt(findingTotal / FINDING_SATURATION) * FINDING_CAP,
            )
          : 0;

      subScores[c] = Math.round(Math.min(100, judgement + findingScore));
    }

    // Hard floor signals — non-negotiable evidence of urgency.
    if (latest.safeguardingEffective === false) {
      subScores.online_safety = Math.max(subScores.online_safety, 90);
      signals.push("Safeguarding NOT MET — regulatory urgency");
      criticalSignalCount++;
    }
    if (latest.personalDevelopment === "inadequate") {
      subScores.confidence_resilience = Math.max(
        subScores.confidence_resilience,
        88,
      );
      signals.push("Personal Development: Inadequate");
      criticalSignalCount++;
    }
    if (latest.personalDevWellbeing === "inadequate") {
      subScores.confidence_resilience = Math.max(
        subScores.confidence_resilience,
        88,
      );
      signals.push("Personal Development & Wellbeing: Urgent improvement");
      criticalSignalCount++;
    }
    if (latest.behaviourAttitudes === "inadequate") {
      subScores.confidence_resilience = Math.max(
        subScores.confidence_resilience,
        82,
      );
      signals.push("Behaviour and Attitudes: Inadequate");
      criticalSignalCount++;
    }
    if (latest.attendanceBehaviour === "inadequate") {
      subScores.confidence_resilience = Math.max(
        subScores.confidence_resilience,
        82,
      );
      signals.push("Attendance and Behaviour: Urgent improvement");
      criticalSignalCount++;
    }
    if (latest.apprenticeships === "inadequate") {
      subScores.employability_skills = Math.max(
        subScores.employability_skills,
        90,
      );
      subScores.confidence_resilience = Math.max(
        subScores.confidence_resilience,
        70,
      );
      signals.push("Apprenticeships: Inadequate");
      criticalSignalCount++;
    }
    if (latest.apprenticeships === "requires_improvement") {
      subScores.employability_skills = Math.max(
        subScores.employability_skills,
        72,
      );
      signals.push("Apprenticeships: Requires improvement");
    }
    if (latest.youngPeoplesProvision === "inadequate") {
      subScores.employability_skills = Math.max(
        subScores.employability_skills,
        88,
      );
      signals.push("Education programmes for young people: Inadequate");
      criticalSignalCount++;
    }
    if (latest.youngPeoplesProvision === "requires_improvement") {
      subScores.employability_skills = Math.max(
        subScores.employability_skills,
        70,
      );
      signals.push("Education programmes for young people: Requires improvement");
    }
    if (latest.adultLearningProgrammes === "inadequate") {
      subScores.employability_skills = Math.max(
        subScores.employability_skills,
        85,
      );
      subScores.financial_literacy = Math.max(subScores.financial_literacy, 75);
      signals.push("Adult learning programmes: Inadequate");
      criticalSignalCount++;
    }
    if (latest.highNeedsProvision === "inadequate") {
      subScores.confidence_resilience = Math.max(
        subScores.confidence_resilience,
        85,
      );
      signals.push("Provision for learners with high needs: Inadequate");
      criticalSignalCount++;
    }
    if (latest.overallGrade === "inadequate") {
      // Inadequate overall is genuinely critical. Floor every curriculum
      // into the "high" tier; the worst sub-judgement boost can lift them
      // further into critical.
      for (const c of CURRICULA) subScores[c] = Math.max(subScores[c], 75);
      signals.push("Overall: Inadequate");
      criticalSignalCount++;
    }
    if (latest.overallGrade === "requires_improvement") {
      // RI is a real signal — floor at "worth a look" so the institution
      // appears on the list at all.
      for (const c of CURRICULA) subScores[c] = Math.max(subScores[c], 55);
      signals.push("Overall: Requires improvement");
    }
    if (latest.overallGrade === "does_not_meet_standard") {
      for (const c of CURRICULA) subScores[c] = Math.max(subScores[c], 75);
      signals.push("Overall: Does not meet the standard");
      criticalSignalCount++;
    }

    // Add weaker-but-real signals to the explanation list (no score boost,
    // they already came through via sub-judgement contributions).
    for (const m of mappings) {
      const { display, urgency } = gradeValueFromField(latest, m.field);
      if (!display) continue;
      if (urgency >= 0.7) {
        const note = `${m.label}: ${display}`;
        if (!signals.includes(note)) signals.push(note);
      } else if (urgency >= 0.55 && signals.length < 8) {
        const note = `${m.label}: ${display}`;
        if (!signals.includes(note)) signals.push(note);
      }
    }

    // Compliance contribution — every active notice raises the floor on
    // ALL curricula. Severity 90+ counts as a critical signal that fires
    // the synergy multiplier. The worst notice's subject becomes a top
    // signal explanation.
    const compliance = compliancePunches.get(instId);
    if (compliance && compliance.length > 0) {
      compliance.sort((a, b) => b.severity - a.severity);
      const worst = compliance[0];
      // Floor for all curricula scaled to compliance severity (sev 95 →
      // floor 80; sev 80 → floor 65; sev 60 → floor 45). Compliance is
      // genuine urgency so it should push everyone into at least
      // worth-a-look territory.
      const floor = Math.max(0, Math.round(worst.severity * 0.85));
      for (const c of CURRICULA) {
        subScores[c] = Math.max(subScores[c], floor);
      }
      signals.push(`Compliance: ${worst.subject}`);
      if (worst.severity >= 90) criticalSignalCount++;
      // Surface up to two additional notices on the same institution
      for (const extra of compliance.slice(1, 3)) {
        signals.push(`Compliance: ${extra.subject}`);
      }
    }

    // News contribution — recent high-severity articles raise relevant
    // curricula. We scale per-curriculum: a story with `curricula_tagged`
    // pointing at financial_literacy boosts that one only; if no specific
    // tag, all curricula get a smaller boost.
    const news = newsPunches.get(instId);
    if (news && news.length > 0) {
      news.sort((a, b) => b.triggerSeverity - a.triggerSeverity);
      const top = news[0];
      if (top.triggerSeverity >= 70) {
        if (top.curricula.length > 0) {
          for (const tag of top.curricula) {
            const c = tag as Curriculum;
            if (CURRICULA.includes(c)) {
              subScores[c] = Math.max(
                subScores[c],
                Math.round(top.triggerSeverity * 0.9),
              );
            }
          }
        } else {
          for (const c of CURRICULA) {
            subScores[c] = Math.max(
              subScores[c],
              Math.round(top.triggerSeverity * 0.65),
            );
          }
        }
        signals.push(
          `News: ${top.angle ?? top.title.slice(0, 100)} (${top.publishedAt ?? "recent"})`,
        );
        if (top.triggerSeverity >= 85) criticalSignalCount++;
      }
      for (const extra of news.slice(1, 3)) {
        if (extra.triggerSeverity < 50) continue;
        signals.push(
          `News: ${extra.angle ?? extra.title.slice(0, 90)} (${extra.publishedAt ?? "recent"})`,
        );
      }
    }

    // Synergy multiplier: 2+ critical signals on one institution × 1.20
    if (criticalSignalCount >= 2) {
      for (const c of CURRICULA) {
        subScores[c] = Math.min(100, Math.round(subScores[c] * 1.2));
      }
      signals.push(`(${criticalSignalCount} critical flags — synergy ×1.2)`);
    }

    // Urgency headline = max sub-score from inspection signals.
    let topCurriculum: Curriculum | null = null;
    let topCurriculumScore = 0;
    for (const c of CURRICULA) {
      if (subScores[c] > topCurriculumScore) {
        topCurriculumScore = subScores[c];
        topCurriculum = c;
      }
    }
    const urgencyHeadline = topCurriculumScore;

    // Pipeline value — separate axis. Only fires for ITP/FE/sixth-form.
    const meta = inspMeta.get(instId);
    const instContact = instContactMap.get(instId) ?? {
      hasContact: false,
      hasWebsite: false,
      fromApar: false,
      source: null,
    };
    const pv = computePipelineValue({
      type: latest.type,
      inspMeta: meta,
      hasContact: instContact.hasContact,
      hasWebsite: instContact.hasWebsite,
      fromApar: instContact.fromApar,
      source: instContact.source,
      apprenticeshipStandards: instContact.apprenticeshipStandards,
    });

    // Headline = max of the two axes, ceilinged by the latest grade.
    // Urgency always wins (compliance / news / safeguarding fail can push
    // a Good-rated provider above the Good ceiling). If pipeline wins,
    // default top_curriculum to employability_skills.
    const rawHeadline = Math.max(urgencyHeadline, pv.score);
    const ceiling = Math.max(gradeCeiling(latest.overallGrade), urgencyHeadline);
    const headline = Math.min(ceiling, rawHeadline);
    if (pv.score > urgencyHeadline) {
      if (!topCurriculum) topCurriculum = "employability_skills";
      for (const s of pv.signals) {
        const note = "Pipeline: " + s;
        if (!signals.includes(note)) signals.push(note);
      }
    }

    // Skip institutions with no real signal AND no pipeline value.
    if (headline < 1 && signals.length === 0) continue;

    const tier = tierFor(urgencyHeadline, pv.score);
    if (tier === "critical") critical++;
    else if (tier === "high") high++;
    else if (tier === "worth_a_look") worthLook++;

    await db.insert(opportunityScores).values({
      institutionId: instId,
      score: headline,
      urgencyScore: urgencyHeadline,
      pipelineValueScore: pv.score,
      inspectionCount: meta?.count ?? 0,
      firstInspectionDate: meta?.earliest ?? null,
      latestInspectionDate: meta?.latest ?? null,
      rawScore: subScores.financial_literacy +
        subScores.employability_skills +
        subScores.confidence_resilience +
        subScores.online_safety,
      financialLiteracyScore: subScores.financial_literacy,
      employabilitySkillsScore: subScores.employability_skills,
      confidenceResilienceScore: subScores.confidence_resilience,
      onlineSafetyScore: subScores.online_safety,
      topCurriculum,
      topCurriculumScore,
      topFindingId: bag?.topFindingId ?? null,
      criticalSignals: signals.length ? signals.join(" · ") : null,
      tier,
      findingCount: bag?.findingIds.size ?? 0,
      suppressedCount: 0,
      lastInspectionId: latest.id,
      lastCalculatedAt: now,
    });
    upserted++;
  }

  // Second pass — ITPs/FE/sixth-form with NO inspections at all. These
  // never appear in latestByInst but are real prospects (Lifetime, Babcock,
  // Kaplan etc.). Pipeline value alone scores them.
  const noInspectionRows = await db
    .select({
      id: institutions.id,
      type: institutions.type,
      website: institutions.website,
      generalEmail: institutions.generalEmail,
      headEmail: institutions.headEmail,
      source: institutions.source,
    })
    .from(institutions)
    .where(
      sql`${institutions.inScope} = 1 AND ${institutions.type} IN ('itp','fe_college','sixth_form_college','university')`,
    );

  let pipelineOnly = 0;
  for (const inst of noInspectionRows) {
    if (latestByInst.has(inst.id)) continue; // already scored above
    const meta = inspMeta.get(inst.id);
    const contact = instContactMap.get(inst.id);
    const fromApar = (inst.source ?? "").includes("apar");
    const hasContact = Boolean(inst.generalEmail || inst.headEmail);
    const hasWebsite = Boolean(inst.website);
    const pv = computePipelineValue({
      type: inst.type,
      inspMeta: meta,
      hasContact,
      hasWebsite,
      fromApar,
      source: inst.source ?? null,
      apprenticeshipStandards: contact?.apprenticeshipStandards ?? 0,
    });
    if (pv.score < 1) continue;

    // Compliance + news urgency for non-inspected ITPs. APAR-restricted ITPs
    // and providers with active Companies House signals will land here, so
    // their urgency must come through compliance/news even though there's no
    // Ofsted urgency to draw on.
    const compliance = compliancePunches.get(inst.id);
    const news = newsPunches.get(inst.id);
    let urgencyFromAux = 0;
    const auxSignals: string[] = [];
    let topCurriculum: Curriculum = "employability_skills";
    let topCurriculumScoreAux = 0;
    let curriculumScoresAux: Record<Curriculum, number> = {
      financial_literacy: 0,
      employability_skills: 0,
      confidence_resilience: 0,
      online_safety: 0,
    };
    if (compliance && compliance.length > 0) {
      compliance.sort((a, b) => b.severity - a.severity);
      const worst = compliance[0];
      const floor = Math.max(0, Math.round(worst.severity * 0.85));
      for (const c of CURRICULA) {
        curriculumScoresAux[c] = Math.max(curriculumScoresAux[c], floor);
      }
      urgencyFromAux = Math.max(urgencyFromAux, floor);
      auxSignals.push(`Compliance: ${worst.subject}`);
      for (const extra of compliance.slice(1, 3)) {
        auxSignals.push(`Compliance: ${extra.subject}`);
      }
    }
    if (news && news.length > 0) {
      news.sort((a, b) => b.triggerSeverity - a.triggerSeverity);
      const top = news[0];
      if (top.triggerSeverity >= 70) {
        const score = Math.round(top.triggerSeverity * 0.9);
        if (top.curricula.length > 0) {
          for (const tag of top.curricula) {
            const c = tag as Curriculum;
            if (CURRICULA.includes(c)) {
              curriculumScoresAux[c] = Math.max(curriculumScoresAux[c], score);
            }
          }
        } else {
          for (const c of CURRICULA) {
            curriculumScoresAux[c] = Math.max(
              curriculumScoresAux[c],
              Math.round(top.triggerSeverity * 0.65),
            );
          }
        }
        urgencyFromAux = Math.max(urgencyFromAux, score);
        auxSignals.push(`News: ${top.angle ?? top.title.slice(0, 100)}`);
      }
    }
    for (const c of CURRICULA) {
      if (curriculumScoresAux[c] > topCurriculumScoreAux) {
        topCurriculumScoreAux = curriculumScoresAux[c];
        topCurriculum = c;
      }
    }
    const tier = tierFor(urgencyFromAux, pv.score);
    if (tier === "critical") critical++;
    else if (tier === "high") high++;
    else if (tier === "worth_a_look") worthLook++;

    // No inspection → use the "no inspection" ceiling (80). Urgency
    // overrides if higher.
    const noInspCeiling = Math.max(gradeCeiling(null), urgencyFromAux);
    const noInspHeadline = Math.min(noInspCeiling, Math.max(urgencyFromAux, pv.score));

    await db.insert(opportunityScores).values({
      institutionId: inst.id,
      score: noInspHeadline,
      urgencyScore: urgencyFromAux,
      pipelineValueScore: pv.score,
      inspectionCount: meta?.count ?? 0,
      firstInspectionDate: meta?.earliest ?? null,
      latestInspectionDate: meta?.latest ?? null,
      rawScore: 0,
      financialLiteracyScore: curriculumScoresAux.financial_literacy,
      employabilitySkillsScore: Math.max(
        curriculumScoresAux.employability_skills,
        pv.score,
      ),
      confidenceResilienceScore: curriculumScoresAux.confidence_resilience,
      onlineSafetyScore: curriculumScoresAux.online_safety,
      topCurriculum,
      topCurriculumScore: Math.max(topCurriculumScoreAux, pv.score),
      topFindingId: null,
      criticalSignals: [
        ...(auxSignals.length ? auxSignals : ["Pipeline value (no inspection signal)"]),
        ...pv.signals.map((s) => `Pipeline: ${s}`),
      ].join(" · "),
      tier,
      findingCount: 0,
      suppressedCount: 0,
      lastInspectionId: null,
      lastCalculatedAt: now,
    });
    upserted++;
    pipelineOnly++;
  }
  log.info(
    `score: pipeline-only pass scored ${pipelineOnly} ITP/FE/sixth-form without inspection-flagged urgency`,
  );

  // Employer scoring — covers two ICP segments tagged via institutions.source:
  //   - APAR Employer-Providers: companies that train their own apprentices
  //   - Skills Bootcamps commissioners: combined authorities + county
  //     councils that hold pre-employment-programme budget directly
  //
  // Both are good Fledglings prospects. Commissioners get the higher
  // baseline because they have a direct line to the buyer.

  // Re-pull employers WITH source so we can spot Skills Bootcamps
  // commissioners (a top-priority ICP — they hold direct budget for
  // pre-employment programmes and have a published skills-team contact).
  const employersFull = await db
    .select({
      id: institutions.id,
      name: institutions.name,
      website: institutions.website,
      generalEmail: institutions.generalEmail,
      source: institutions.source,
    })
    .from(institutions)
    .where(
      sql`${institutions.type} = 'employer' AND ${institutions.inScope} = 1`,
    );

  let employersScored = 0;
  for (const emp of employersFull) {
    const isSkillsBootcamps = emp.source === "skills_bootcamps";
    // Skills Bootcamps commissioners hold direct skills-bootcamp budget
    // — top priority. APAR Employer-Providers are next tier — they run
    // apprenticeships in-house.
    const subScores: Record<Curriculum, number> = isSkillsBootcamps
      ? {
          employability_skills: 95,
          confidence_resilience: 80,
          financial_literacy: 70,
          online_safety: 60,
        }
      : {
          employability_skills: 78,
          confidence_resilience: 55,
          financial_literacy: 45,
          online_safety: 40,
        };

    const signals: string[] = isSkillsBootcamps
      ? [
          "Skills Bootcamps commissioning authority — direct budget for pre-employment programmes",
          "Published skills-team contact email on record",
        ]
      : [
          "APAR Employer-Provider — runs own apprenticeship scheme",
          "ICP fit: pre-employment bootcamp drops into their existing trainee pipeline",
        ];
    if (!emp.website) signals.push("(no website on record — enrich first)");

    const headline = subScores.employability_skills;
    // Employer scores are curated buyer-fit not pipeline-fit. Pass as urgency
    // so Skills Bootcamps commissioners (95) become critical and APAR
    // Employer-Providers (78) become high under the new tier rules.
    const tier = tierFor(headline, 0);

    // Use upsert because some employers may have prior inspection rows from
    // when they were classified as 'itp' — the main loop above will already
    // have written a row for them. We overwrite with the employer baseline.
    await db
      .insert(opportunityScores)
      .values({
        institutionId: emp.id,
        score: headline,
        rawScore:
          subScores.employability_skills +
          subScores.confidence_resilience +
          subScores.financial_literacy +
          subScores.online_safety,
        financialLiteracyScore: subScores.financial_literacy,
        employabilitySkillsScore: subScores.employability_skills,
        confidenceResilienceScore: subScores.confidence_resilience,
        onlineSafetyScore: subScores.online_safety,
        topCurriculum: "employability_skills",
        topCurriculumScore: subScores.employability_skills,
        topFindingId: null,
        criticalSignals: signals.join(" · "),
        tier,
        findingCount: 0,
        suppressedCount: 0,
        lastInspectionId: null,
        lastCalculatedAt: now,
      })
      .onConflictDoUpdate({
        target: opportunityScores.institutionId,
        set: {
          score: headline,
          financialLiteracyScore: subScores.financial_literacy,
          employabilitySkillsScore: subScores.employability_skills,
          confidenceResilienceScore: subScores.confidence_resilience,
          onlineSafetyScore: subScores.online_safety,
          topCurriculum: "employability_skills",
          topCurriculumScore: subScores.employability_skills,
          criticalSignals: signals.join(" · "),
          tier,
          lastCalculatedAt: now,
        },
      });
    if (tier === "critical") critical++;
    else if (tier === "high") high++;
    else if (tier === "worth_a_look") worthLook++;
    employersScored++;
    upserted++;
  }

  log.info(
    `score: v3 done — upserted=${upserted} critical=${critical} high=${high} worth_a_look=${worthLook} (employers=${employersScored})`,
  );

  return {
    recordsSeen: latestByInst.size + employersFull.length,
    recordsUpserted: upserted,
    notes: `critical=${critical} high=${high} worth_a_look=${worthLook} employers=${employersScored}`,
  };
}
