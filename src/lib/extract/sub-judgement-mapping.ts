/**
 * Mapping of inspection sub-judgements to Fledglings curriculum weights.
 *
 * Sourced from an education-regulation expert review of:
 *   - Ofsted Education Inspection Framework (Sept 2023)
 *   - Ofsted FE & Skills Inspection Handbook (2024)
 *   - Ofsted Nov-2025 "report card" thematic standards
 *   - ISI Inspection Framework + Independent School Standards
 *   - Gatsby Good Career Guidance Benchmarks
 *   - KCSiE 2024
 *
 * Weights are 0.0-1.0 reflecting how directly Fledglings' four curricula
 * address an institution flagged on each sub-judgement.
 */

export type Curriculum =
  | "financial_literacy"
  | "employability_skills"
  | "confidence_resilience"
  | "online_safety";

export type SubJudgementMapping = {
  field: string; // matches a column on `inspections`
  label: string; // human label for UI / critical signals
  weights: Record<Curriculum, number>;
};

const SCHOOL_MAPPINGS: SubJudgementMapping[] = [
  // Safeguarding (legacy boolean and the new "Safeguarding standards" Met/Not met)
  {
    field: "safeguardingEffective",
    label: "Safeguarding",
    weights: {
      financial_literacy: 0.0,
      employability_skills: 0.0,
      confidence_resilience: 0.4,
      online_safety: 0.95,
    },
  },
  // Personal Development (legacy EIF)
  {
    field: "personalDevelopment",
    label: "Personal Development",
    weights: {
      financial_literacy: 0.7,
      employability_skills: 0.7,
      confidence_resilience: 0.9,
      online_safety: 0.6,
    },
  },
  // Personal Development & Wellbeing (new report card)
  {
    field: "personalDevWellbeing",
    label: "Personal Development & Wellbeing",
    weights: {
      financial_literacy: 0.8,
      employability_skills: 0.8,
      confidence_resilience: 0.9,
      online_safety: 0.7,
    },
  },
  // Behaviour and Attitudes (legacy EIF)
  {
    field: "behaviourAttitudes",
    label: "Behaviour and Attitudes",
    weights: {
      financial_literacy: 0.1,
      employability_skills: 0.2,
      confidence_resilience: 0.9,
      online_safety: 0.4,
    },
  },
  // Attendance and Behaviour (new report card)
  {
    field: "attendanceBehaviour",
    label: "Attendance and Behaviour",
    weights: {
      financial_literacy: 0.2,
      employability_skills: 0.3,
      confidence_resilience: 0.95,
      online_safety: 0.4,
    },
  },
  // Inclusion (new report card)
  {
    field: "inclusion",
    label: "Inclusion",
    weights: {
      financial_literacy: 0.3,
      employability_skills: 0.4,
      confidence_resilience: 0.7,
      online_safety: 0.3,
    },
  },
  {
    field: "qualityOfEducation",
    label: "Quality of Education",
    weights: {
      financial_literacy: 0.2,
      employability_skills: 0.4,
      confidence_resilience: 0.3,
      online_safety: 0.3,
    },
  },
  {
    field: "curriculumTeaching",
    label: "Curriculum and Teaching",
    weights: {
      financial_literacy: 0.3,
      employability_skills: 0.4,
      confidence_resilience: 0.3,
      online_safety: 0.3,
    },
  },
  {
    field: "achievement",
    label: "Achievement",
    weights: {
      financial_literacy: 0.2,
      employability_skills: 0.4,
      confidence_resilience: 0.4,
      online_safety: 0.1,
    },
  },
  {
    field: "sixthFormProvision",
    label: "Sixth Form Provision",
    weights: {
      financial_literacy: 0.6,
      employability_skills: 0.9,
      confidence_resilience: 0.5,
      online_safety: 0.3,
    },
  },
  {
    field: "overallGrade",
    label: "Overall Effectiveness",
    weights: {
      financial_literacy: 0.3,
      employability_skills: 0.4,
      confidence_resilience: 0.5,
      online_safety: 0.4,
    },
  },
];

const FE_SKILLS_MAPPINGS: SubJudgementMapping[] = [
  {
    field: "safeguardingEffective",
    label: "Safeguarding",
    weights: {
      financial_literacy: 0.0,
      employability_skills: 0.0,
      confidence_resilience: 0.4,
      online_safety: 0.95,
    },
  },
  {
    field: "personalDevelopment",
    label: "Personal Development",
    weights: {
      financial_literacy: 0.8,
      employability_skills: 0.85,
      confidence_resilience: 0.85,
      online_safety: 0.7,
    },
  },
  {
    field: "behaviourAttitudes",
    label: "Behaviour and Attitudes",
    weights: {
      financial_literacy: 0.2,
      employability_skills: 0.5,
      confidence_resilience: 0.85,
      online_safety: 0.4,
    },
  },
  {
    field: "qualityOfEducation",
    label: "Quality of Education",
    weights: {
      financial_literacy: 0.3,
      employability_skills: 0.5,
      confidence_resilience: 0.3,
      online_safety: 0.3,
    },
  },
  {
    field: "apprenticeships",
    label: "Apprenticeships",
    weights: {
      financial_literacy: 0.6,
      employability_skills: 0.95,
      confidence_resilience: 0.6,
      online_safety: 0.4,
    },
  },
  {
    field: "adultLearningProgrammes",
    label: "Adult Learning Programmes",
    weights: {
      financial_literacy: 0.7,
      employability_skills: 0.8,
      confidence_resilience: 0.5,
      online_safety: 0.4,
    },
  },
  {
    field: "youngPeoplesProvision",
    label: "Education programmes for young people",
    weights: {
      financial_literacy: 0.7,
      employability_skills: 0.9,
      confidence_resilience: 0.7,
      online_safety: 0.5,
    },
  },
  {
    field: "highNeedsProvision",
    label: "Provision for learners with high needs",
    weights: {
      financial_literacy: 0.6,
      employability_skills: 0.8,
      confidence_resilience: 0.85,
      online_safety: 0.5,
    },
  },
  {
    field: "contributionToSkills",
    label: "Contribution to skills needs",
    weights: {
      financial_literacy: 0.4,
      employability_skills: 0.8,
      confidence_resilience: 0.3,
      online_safety: 0.2,
    },
  },
  {
    field: "overallGrade",
    label: "Overall Effectiveness",
    weights: {
      financial_literacy: 0.3,
      employability_skills: 0.6,
      confidence_resilience: 0.4,
      online_safety: 0.3,
    },
  },
];

const ISI_MAPPINGS: SubJudgementMapping[] = [
  {
    field: "safeguardingEffective",
    label: "Safeguarding (ISS Part 3)",
    weights: {
      financial_literacy: 0.0,
      employability_skills: 0.0,
      confidence_resilience: 0.6,
      online_safety: 0.9,
    },
  },
  {
    field: "personalDevelopment",
    label: "Personal Development (ISI EQI)",
    weights: {
      financial_literacy: 0.7,
      employability_skills: 0.6,
      confidence_resilience: 0.9,
      online_safety: 0.7,
    },
  },
  {
    field: "overallGrade",
    label: "Overall Outcome",
    weights: {
      financial_literacy: 0.3,
      employability_skills: 0.4,
      confidence_resilience: 0.5,
      online_safety: 0.4,
    },
  },
];

export function getMappings(
  inspectionBody: string,
  institutionType: string,
): SubJudgementMapping[] {
  if (inspectionBody === "isi") return ISI_MAPPINGS;
  if (
    institutionType === "itp" ||
    institutionType === "fe_college" ||
    institutionType === "sixth_form_college"
  )
    return FE_SKILLS_MAPPINGS;
  return SCHOOL_MAPPINGS;
}
