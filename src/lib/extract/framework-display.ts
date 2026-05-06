/**
 * Framework-aware display structures for inspection sub-judgements.
 *
 * Ofsted judges schools and FE & Skills providers under DIFFERENT frameworks
 * with different judgement areas. The detail page renders the right one
 * based on the institution's `inspection_body` and `type`.
 *
 * Frameworks:
 *   - school_eif        — Ofsted Education Inspection Framework (legacy, pre-Nov 2025)
 *   - school_report_card — New post-Nov 2025 thematic report card (schools)
 *   - fe_skills         — Ofsted FE & Skills inspection framework (ITPs, FE colleges)
 *   - isi               — Independent Schools Inspectorate
 */

export type FrameworkLabel =
  | "school_eif"
  | "school_report_card"
  | "fe_skills"
  | "isi"
  | "employer";

export type GradeFieldDisplay = {
  field: string; // matches `inspections` column
  label: string;
  description?: string;
  curriculumNote?: string; // why Fledglings cares
};

export type FrameworkDisplay = {
  key: FrameworkLabel;
  title: string;
  blurb: string;
  groups: Array<{
    heading: string;
    fields: GradeFieldDisplay[];
  }>;
};

const SCHOOL_EIF: FrameworkDisplay = {
  key: "school_eif",
  title: "Ofsted EIF judgements",
  blurb:
    "Education Inspection Framework — used for school inspections before November 2025.",
  groups: [
    {
      heading: "Headline",
      fields: [
        { field: "overallGrade", label: "Overall effectiveness" },
        {
          field: "safeguardingEffective",
          label: "Safeguarding",
          curriculumNote: "Online Safety",
        },
      ],
    },
    {
      heading: "Sub-judgements",
      fields: [
        {
          field: "qualityOfEducation",
          label: "Quality of education",
        },
        {
          field: "behaviourAttitudes",
          label: "Behaviour and attitudes",
          curriculumNote: "Confidence & Resilience",
        },
        {
          field: "personalDevelopment",
          label: "Personal development",
          curriculumNote: "Confidence & Resilience · Financial Literacy · Employability",
        },
        { field: "leadershipManagement", label: "Leadership and management" },
        { field: "sixthFormProvision", label: "Sixth form provision", curriculumNote: "Employability Skills" },
      ],
    },
  ],
};

const SCHOOL_REPORT_CARD: FrameworkDisplay = {
  key: "school_report_card",
  title: "Ofsted report card (Nov 2025+)",
  blurb:
    "Post-Nov 2025 thematic standards. Five evaluation areas plus safeguarding (Met / Not met). No single overall grade.",
  groups: [
    {
      heading: "Safeguarding",
      fields: [
        {
          field: "safeguardingEffective",
          label: "Safeguarding standards",
          description: "Met / Not met",
          curriculumNote: "Online Safety (hard floor)",
        },
      ],
    },
    {
      heading: "Thematic standards",
      fields: [
        {
          field: "personalDevWellbeing",
          label: "Personal development and wellbeing",
          curriculumNote: "Confidence & Resilience · Financial Literacy · Employability",
        },
        {
          field: "attendanceBehaviour",
          label: "Attendance and behaviour",
          curriculumNote: "Confidence & Resilience",
        },
        {
          field: "inclusion",
          label: "Inclusion",
          curriculumNote: "Confidence & Resilience",
        },
        {
          field: "curriculumTeaching",
          label: "Curriculum and teaching",
        },
        {
          field: "achievement",
          label: "Achievement",
          curriculumNote: "Employability Skills",
        },
      ],
    },
  ],
};

const FE_SKILLS: FrameworkDisplay = {
  key: "fe_skills",
  title: "Ofsted FE & Skills framework",
  blurb:
    "Used for further education colleges, sixth-form colleges, and Independent Training Providers. Different judgement areas from the school framework.",
  groups: [
    {
      heading: "Headline",
      fields: [
        { field: "overallGrade", label: "Overall effectiveness" },
        {
          field: "safeguardingEffective",
          label: "Safeguarding standards",
          description: "Met / Not met",
          curriculumNote: "Online Safety (hard floor)",
        },
      ],
    },
    {
      heading: "Common judgements",
      fields: [
        { field: "qualityOfEducation", label: "Quality of education" },
        {
          field: "behaviourAttitudes",
          label: "Behaviour and attitudes",
          curriculumNote: "Confidence & Resilience",
        },
        {
          field: "personalDevelopment",
          label: "Personal development",
          curriculumNote: "Confidence & Resilience · Financial Literacy · Employability",
        },
        { field: "leadershipManagement", label: "Leadership and management" },
        {
          field: "contributionToSkills",
          label: "Contribution to meeting skills needs",
          curriculumNote: "Employability Skills",
        },
      ],
    },
    {
      heading: "Provision-type judgements",
      fields: [
        {
          field: "youngPeoplesProvision",
          label: "Education programmes for young people (16–19)",
          curriculumNote: "Employability Skills · Confidence & Resilience",
        },
        {
          field: "apprenticeships",
          label: "Apprenticeships",
          curriculumNote: "Employability Skills (hard floor)",
        },
        {
          field: "adultLearningProgrammes",
          label: "Adult learning programmes",
          curriculumNote: "Financial Literacy · Employability Skills",
        },
        {
          field: "highNeedsProvision",
          label: "Provision for learners with high needs",
          curriculumNote: "Confidence & Resilience · Employability",
        },
      ],
    },
  ],
};

const ISI: FrameworkDisplay = {
  key: "isi",
  title: "ISI framework",
  blurb:
    "Independent Schools Inspectorate. Inspections fall under Educational Quality, Compliance with the Independent School Standards (ISS Parts 1–8), and Personal Development.",
  groups: [
    {
      heading: "Headline",
      fields: [
        { field: "overallGrade", label: "Overall outcome" },
        {
          field: "safeguardingEffective",
          label: "Safeguarding (ISS Part 3)",
          description: "Met / Not met",
          curriculumNote: "Online Safety (hard floor)",
        },
      ],
    },
    {
      heading: "Educational quality + personal development",
      fields: [
        {
          field: "personalDevelopment",
          label: "Personal development",
          curriculumNote: "Confidence & Resilience",
        },
        { field: "qualityOfEducation", label: "Educational quality (achievement)" },
      ],
    },
  ],
};

const EMPLOYER: FrameworkDisplay = {
  key: "employer",
  title: "Employer (APAR Employer-Provider)",
  blurb:
    "Employers are not inspected by Ofsted as schools and providers are. Their fit for Fledglings comes from their training infrastructure: APAR-listed Employer-Providers run their own apprenticeship schemes in-house, so a pre-employment bootcamp drops straight into their existing trainee pipeline.",
  groups: [
    {
      heading: "ICP signal",
      fields: [
        {
          field: "_apar",
          label: "Listed on APAR as Employer-Provider",
          description: "Approved to deliver own apprenticeships",
          curriculumNote: "Employability Skills (lead) · Confidence & Resilience",
        },
      ],
    },
  ],
};

export function frameworkFor(
  inspectionBody: string | null | undefined,
  institutionType: string | null | undefined,
  hasReportCardGrades: boolean,
): FrameworkDisplay {
  if (institutionType === "employer") return EMPLOYER;
  if (inspectionBody === "isi") return ISI;
  if (
    institutionType === "itp" ||
    institutionType === "fe_college" ||
    institutionType === "sixth_form_college"
  ) {
    return FE_SKILLS;
  }
  // Schools: pick report-card if any of the new fields are populated, else
  // legacy EIF.
  return hasReportCardGrades ? SCHOOL_REPORT_CARD : SCHOOL_EIF;
}
