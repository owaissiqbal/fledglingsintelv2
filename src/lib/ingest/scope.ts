/**
 * ICP filter for the Fledglings inspection-intelligence dashboard.
 *
 *   IN-SCOPE: institutions that serve learners from Year 9 onwards
 *     - England only
 *     - Open establishments only
 *     - Schools that serve age 14+ (so Year 9 pupils, who turn 14, are in
 *       at least the school's last cohort): secondary 11-16/18, all-through,
 *       middle-deemed-secondary 10-14, sixth form, post-16
 *     - Independent schools with secondary or sixth-form provision (high age >= 14)
 *     - FE colleges and ITPs (16+ — well past Year 9)
 *
 *   OUT-OF-SCOPE:
 *     - Primary, infant, junior, nursery, EYFS-only
 *     - Middle schools that end at age 13 (9-13) — pupils leave before Year 9
 *     - Special schools that don't reach age 14
 *     - Welsh / Scottish / NI establishments
 *     - HE providers and universities
 *     - LA children's services / virtual schools
 */

const MIN_HIGH_AGE_FOR_YEAR_9 = 14; // Year 9 pupils turn 14 during the year

const SCOPED_PHASES = new Set([
  "Secondary",
  "Middle deemed secondary",
  "All-through",
  "16 plus",
  "Not applicable", // common for FE / sixth-form colleges in GIAS
]);

const OUT_OF_SCOPE_PHASES = new Set([
  "Nursery",
  "Primary",
  "Middle deemed primary",
  "16-19", // captured under "16 plus" in newer files
]);

const OUT_OF_SCOPE_TYPES = new Set([
  "Welsh comprehensive school",
  "Welsh establishment",
  "Higher education institutions",
  "Local authority adult education provision",
  "Children's centre",
  "Children's centre linked site",
  "Online provider",
  "Service children's education",
  "Miscellaneous",
]);

type ScopeInput = {
  status?: string | null;
  phase?: string | null;
  typeOfEstablishment?: string | null;
  statutoryHighAge?: number | null;
  statutoryLowAge?: number | null;
};

export type ScopeResult =
  | { inScope: true }
  | { inScope: false; reason: string };

export function classifyScope(input: ScopeInput): ScopeResult {
  if (input.status && input.status !== "Open") {
    return { inScope: false, reason: `status=${input.status}` };
  }

  const type = input.typeOfEstablishment?.trim();
  if (type && OUT_OF_SCOPE_TYPES.has(type)) {
    return { inScope: false, reason: `type=${type}` };
  }

  const phase = input.phase?.trim();
  if (phase && OUT_OF_SCOPE_PHASES.has(phase)) {
    return { inScope: false, reason: `phase=${phase}` };
  }

  // Year 9+ filter: must serve learners up to at least age 14.
  // Pupils in Year 9 turn 14 during the year, so a school that ends at 13
  // (a 9-13 middle-deemed-secondary) loses pupils before Year 9 starts.
  if (
    typeof input.statutoryHighAge === "number" &&
    input.statutoryHighAge < MIN_HIGH_AGE_FOR_YEAR_9
  ) {
    return {
      inScope: false,
      reason: `high_age=${input.statutoryHighAge} < 14 (no Year 9)`,
    };
  }

  if (phase && !SCOPED_PHASES.has(phase)) {
    // Unknown phase — be permissive if the upper age covers Year 9+.
    if (
      typeof input.statutoryHighAge !== "number" ||
      input.statutoryHighAge < MIN_HIGH_AGE_FOR_YEAR_9
    ) {
      return { inScope: false, reason: `phase=${phase}` };
    }
  }

  return { inScope: true };
}

const TYPE_MAPPING: Array<[RegExp, string]> = [
  [/independent\s+school/i, "independent_school"],
  [/independent\s+special/i, "independent_school"],
  [/sixth\s+form/i, "sixth_form_college"],
  [/academy\s+16/i, "sixth_form_college"], // Academy 16-19 converter / sponsor led
  [/free\s+schools?\s+16/i, "sixth_form_college"], // Free schools 16 to 19
  [/further\s+education/i, "fe_college"],
];

export function mapInstitutionType(
  rawType: string | null | undefined,
): string {
  if (!rawType) return "state_school";
  for (const [pattern, mapped] of TYPE_MAPPING) {
    if (pattern.test(rawType)) return mapped;
  }
  return "state_school";
}
