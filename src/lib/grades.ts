/**
 * Ofsted / ISI grade normalisation and drop detection.
 *
 * Inputs come from CSVs and HTML reports in the wild and are messy:
 * "Outstanding", "outstanding", "1", "Grade 1", "Requires Improvement", etc.
 * Everything funnels through `normaliseGrade` to one of the canonical
 * GRADES values exported from the schema.
 */

export const OFSTED_GRADE_RANK: Record<string, number> = {
  outstanding: 1,
  good: 2,
  requires_improvement: 3,
  inadequate: 4,
};

const NUMERIC_TO_GRADE: Record<string, string> = {
  "1": "outstanding",
  "2": "good",
  "3": "requires_improvement",
  "4": "inadequate",
};

export function normaliseGrade(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "NULL") return null;

  // "Grade 1" / "1"
  const num = s.replace(/^grade\s*/i, "").trim();
  if (NUMERIC_TO_GRADE[num]) return NUMERIC_TO_GRADE[num];

  const lower = s.toLowerCase();

  // Legacy EIF labels
  if (lower === "outstanding") return "outstanding";
  if (lower === "good") return "good";
  if (
    lower === "requires improvement" ||
    lower === "requires_improvement" ||
    lower === "ri"
  )
    return "requires_improvement";
  if (
    lower === "inadequate" ||
    lower === "serious weaknesses" ||
    lower === "special measures"
  )
    return "inadequate";

  // Post-Nov-2025 Ofsted "report card" labels
  if (lower === "exceptional") return "outstanding";
  if (lower === "strong standard" || lower === "strong") return "good";
  if (lower === "expected standard" || lower === "expected") return "good";
  if (lower === "needs attention") return "requires_improvement";
  if (lower === "urgent improvement") return "inadequate";

  // ISI / DfE compliance labels
  if (lower === "met") return "meets_standard";
  if (lower === "not met") return "does_not_meet_standard";
  if (lower.includes("meets the standard") || lower.includes("meets standard"))
    return "meets_standard";
  if (lower.includes("does not meet") || lower.startsWith("not met"))
    return "does_not_meet_standard";

  if (lower === "no formal designation" || lower === "not graded")
    return "not_judged";

  return null;
}

/**
 * How urgent is this sub-judgement, on a 0-1 scale, from a Fledglings
 * outreach point of view? 1 means "urgent — they need help now"; 0 means
 * "they're fine"; negative means "they're a leader, don't waste outreach
 * time". Used by the scorer's sub-judgement boost.
 */
export function gradeUrgency(grade: string | null | undefined): number {
  if (!grade) return 0;
  switch (grade) {
    case "inadequate":
    case "does_not_meet_standard":
      return 1.0;
    case "requires_improvement":
      return 0.72; // bumped from 0.55 — RI is a substantial signal
    case "meets_standard":
      return 0.0;
    case "good":
      return -0.1;
    case "outstanding":
      return -0.3;
    default:
      return 0;
  }
}

export function isOfstedGradeDrop(
  current: string | null,
  previous: string | null,
): boolean {
  if (!current || !previous) return false;
  const c = OFSTED_GRADE_RANK[current];
  const p = OFSTED_GRADE_RANK[previous];
  if (c == null || p == null) return false;
  return c > p;
}

export function gradeLabel(grade: string | null | undefined): string {
  if (!grade) return "—";
  switch (grade) {
    case "outstanding":
      return "Outstanding";
    case "good":
      return "Good";
    case "requires_improvement":
      return "Requires improvement";
    case "inadequate":
      return "Inadequate";
    case "meets_standard":
      return "Meets the standard";
    case "does_not_meet_standard":
      return "Does not meet the standard";
    case "not_judged":
      return "Not judged";
    default:
      return grade;
  }
}

export function gradeBadgeClass(grade: string | null | undefined): string {
  switch (grade) {
    case "outstanding":
      // Navy = premium, top tier
      return "bg-fl-navy text-fl-white";
    case "good":
      // Brand blue
      return "bg-fl-blue/10 text-fl-blue ring-1 ring-fl-blue/30";
    case "requires_improvement":
      // Mango = warm warning
      return "bg-fl-mango/15 text-[#a45a1c] ring-1 ring-fl-mango/40";
    case "inadequate":
      // Orange = urgent, brand primary
      return "bg-fl-orange/15 text-fl-orange ring-1 ring-fl-orange/40";
    case "meets_standard":
      return "bg-fl-blue/10 text-fl-blue ring-1 ring-fl-blue/30";
    case "does_not_meet_standard":
      return "bg-fl-orange/15 text-fl-orange ring-1 ring-fl-orange/40";
    default:
      return "bg-fl-off-white text-fl-navy/70 ring-1 ring-fl-navy/10";
  }
}

export function parseInspectionDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD-MM-YYYY
  const dashMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const [, d, m, y] = dashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  // DD Mon YYYY
  const monthMatch = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (monthMatch) {
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const [, d, m, y] = monthMatch;
    const mn = months[m.slice(0, 3).toLowerCase()];
    if (mn) return `${y}-${mn}-${d.padStart(2, "0")}`;
  }

  // Excel-serial? Skip — CSV won't have these.
  return null;
}

export function parseBoolean(raw: unknown): boolean | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}
