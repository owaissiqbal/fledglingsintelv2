import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestampMs = (name: string) =>
  integer(name, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const institutions = sqliteTable(
  "institutions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    urn: text("urn"),
    ukprn: text("ukprn"),
    isiId: text("isi_id"),

    name: text("name").notNull(),
    type: text("type").notNull(),
    phase: text("phase"),
    region: text("region"),
    localAuthority: text("local_authority"),
    postcode: text("postcode"),
    address: text("address"),
    gender: text("gender"),
    religiousCharacter: text("religious_character"),
    website: text("website"),
    phone: text("phone"),
    generalEmail: text("general_email"),
    headName: text("head_name"),
    headEmail: text("head_email"),

    inScope: integer("in_scope", { mode: "boolean" }).notNull().default(true),
    outOfScopeReason: text("out_of_scope_reason"),
    source: text("source"),

    // Number of apprenticeship standards this provider delivers (extracted
    // from gov.uk Find Apprenticeship Training pages). A reliable size
    // proxy: big providers offer 50+ standards, niche ones offer 2-5.
    apprenticeshipStandards: integer("apprenticeship_standards").default(0),

    createdAt: timestampMs("created_at"),
    updatedAt: timestampMs("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_inst_urn").on(t.urn),
    uniqueIndex("uq_inst_ukprn").on(t.ukprn),
    uniqueIndex("uq_inst_isi_id").on(t.isiId),
    index("idx_inst_postcode").on(t.postcode),
    index("idx_inst_region_type").on(t.region, t.type),
    index("idx_inst_in_scope").on(t.inScope),
    index("idx_inst_name").on(t.name),
  ],
);

export const inspections = sqliteTable(
  "inspections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),

    inspectionBody: text("inspection_body").notNull(),
    framework: text("framework"),
    inspectionType: text("inspection_type"),

    inspectionStartDate: text("inspection_start_date").notNull(),
    inspectionEndDate: text("inspection_end_date"),
    publicationDate: text("publication_date"),

    reportUrl: text("report_url").notNull(),
    reportPdfPath: text("report_pdf_path"),
    reportText: text("report_text"),
    reportTextHash: text("report_text_hash"),

    overallGrade: text("overall_grade"),
    qualityOfEducation: text("quality_of_education"),
    behaviourAttitudes: text("behaviour_attitudes"),
    personalDevelopment: text("personal_development"),
    leadershipManagement: text("leadership_management"),
    sixthFormProvision: text("sixth_form_provision"),
    apprenticeships: text("apprenticeships"),
    adultLearningProgrammes: text("adult_learning_programmes"),
    safeguardingEffective: integer("safeguarding_effective", {
      mode: "boolean",
    }),
    isiOverall: text("isi_overall"),

    // Post-Nov-2025 Ofsted "report card" thematic standards (schools)
    inclusion: text("inclusion"),
    attendanceBehaviour: text("attendance_behaviour"),
    personalDevWellbeing: text("personal_dev_wellbeing"),
    achievement: text("achievement"),
    curriculumTeaching: text("curriculum_teaching"),

    // Ofsted FE & Skills judgement areas (ITPs and FE colleges)
    youngPeoplesProvision: text("young_peoples_provision"),
    highNeedsProvision: text("high_needs_provision"),
    contributionToSkills: text("contribution_to_skills"),

    previousOverallGrade: text("previous_overall_grade"),
    previousInspectionId: integer("previous_inspection_id"),
    gradeDropped: integer("grade_dropped", { mode: "boolean" })
      .notNull()
      .default(false),

    createdAt: timestampMs("created_at"),
    updatedAt: timestampMs("updated_at"),
  },
  (t) => [
    uniqueIndex("uq_inspection_event").on(
      t.institutionId,
      t.inspectionStartDate,
      t.inspectionBody,
    ),
    index("idx_insp_institution").on(t.institutionId, t.inspectionStartDate),
    index("idx_insp_grade").on(t.overallGrade),
    index("idx_insp_grade_dropped").on(t.gradeDropped),
    index("idx_insp_publication").on(t.publicationDate),
  ],
);

export const reportSections = sqliteTable(
  "report_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    inspectionId: integer("inspection_id")
      .notNull()
      .references(() => inspections.id, { onDelete: "cascade" }),

    sectionKey: text("section_key").notNull(),
    sectionTitle: text("section_title"),
    sectionText: text("section_text").notNull(),
    multiplier: real("multiplier").notNull().default(1.0),
    orderIndex: integer("order_index").notNull().default(0),
  },
  (t) => [
    index("idx_section_inspection").on(t.inspectionId, t.orderIndex),
    index("idx_section_key").on(t.sectionKey),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    inspectionId: integer("inspection_id")
      .notNull()
      .references(() => inspections.id, { onDelete: "cascade" }),
    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),

    phraseId: text("phrase_id").notNull(),
    phrasePattern: text("phrase_pattern").notNull(),

    sectionKey: text("section_key").notNull(),
    sourceQuote: text("source_quote").notNull(),
    quoteStart: integer("quote_start"),
    quoteEnd: integer("quote_end"),

    baseSeverity: integer("base_severity").notNull(),
    multiplier: real("multiplier").notNull(),
    finalSeverity: real("final_severity").notNull(),

    suppressed: integer("suppressed", { mode: "boolean" })
      .notNull()
      .default(false),
    suppressionReason: text("suppression_reason"),

    phraseLibraryVersion: integer("phrase_library_version_id"),

    createdAt: timestampMs("created_at"),
  },
  (t) => [
    index("idx_finding_institution").on(t.institutionId, t.finalSeverity),
    index("idx_finding_inspection").on(t.inspectionId),
    index("idx_finding_phrase").on(t.phraseId),
    index("idx_finding_suppressed").on(t.suppressed),
  ],
);

export const curriculumMatches = sqliteTable(
  "curriculum_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    findingId: integer("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),

    curriculum: text("curriculum").notNull(),
    weight: real("weight").notNull(),
  },
  (t) => [
    index("idx_match_curriculum").on(t.curriculum, t.weight),
    index("idx_match_finding").on(t.findingId),
    index("idx_match_institution").on(t.institutionId, t.curriculum),
  ],
);

export const opportunityScores = sqliteTable(
  "opportunity_scores",
  {
    institutionId: integer("institution_id")
      .primaryKey()
      .references(() => institutions.id, { onDelete: "cascade" }),

    score: real("score").notNull().default(0),
    rawScore: real("raw_score").notNull().default(0),

    // Per-curriculum sub-scores (0-100). Each is independent — a school can
    // be a 95 for Online Safety and a 12 for Financial Literacy at the
    // same time. The headline `score` is max of these.
    financialLiteracyScore: integer("financial_literacy_score").notNull().default(0),
    employabilitySkillsScore: integer("employability_skills_score").notNull().default(0),
    confidenceResilienceScore: integer("confidence_resilience_score").notNull().default(0),
    onlineSafetyScore: integer("online_safety_score").notNull().default(0),

    topCurriculum: text("top_curriculum"),
    topCurriculumScore: real("top_curriculum_score"),
    topFindingId: integer("top_finding_id"),

    // Comma-separated explicit signals (e.g. "Safeguarding Not met",
    // "Personal Development Inadequate", "2nd consecutive RI"). Drives the
    // "Why this is a Fledglings opportunity" panel on the detail page.
    criticalSignals: text("critical_signals"),

    // Tier label: critical / high / worth_a_look / skip — for fast filtering
    tier: text("tier"),

    // Pipeline value: separate-axis score reflecting how good a sales prospect
    // this institution is regardless of inspection urgency. Captures size,
    // recency of activity, contactability, APAR registration, track record.
    // The headline `score` is max(urgency_score, pipeline_value_score).
    pipelineValueScore: integer("pipeline_value_score").notNull().default(0),
    urgencyScore: integer("urgency_score").notNull().default(0),
    inspectionCount: integer("inspection_count").notNull().default(0),
    firstInspectionDate: text("first_inspection_date"),
    latestInspectionDate: text("latest_inspection_date"),

    findingCount: integer("finding_count").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),

    lastInspectionId: integer("last_inspection_id"),
    lastCalculatedAt: timestampMs("last_calculated_at"),
  },
  (t) => [
    index("idx_score_score").on(t.score),
    index("idx_score_top_curriculum").on(t.topCurriculum, t.score),
  ],
);

export const phraseLibraryVersions = sqliteTable(
  "phrase_library_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    loadedAt: timestampMs("loaded_at"),
    yamlHash: text("yaml_hash").notNull(),
    phraseCount: integer("phrase_count").notNull(),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("uq_phrase_lib_hash").on(t.yamlHash)],
);

export const ingestionRuns = sqliteTable(
  "ingestion_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    startedAt: timestampMs("started_at"),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    status: text("status").notNull().default("running"),
    recordsSeen: integer("records_seen").notNull().default(0),
    recordsUpserted: integer("records_upserted").notNull().default(0),
    errorMessage: text("error_message"),
    triggeredBy: text("triggered_by"),
  },
  (t) => [
    index("idx_run_source").on(t.source, t.startedAt),
    index("idx_run_status").on(t.status),
  ],
);

export const outreachLog = sqliteTable(
  "outreach_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    pushedAt: timestampMs("pushed_at"),
    instantlyLeadId: text("instantly_lead_id"),
    instantlyCampaignId: text("instantly_campaign_id"),
    instantlyListId: text("instantly_list_id"),
    topCurriculum: text("top_curriculum"),
    topWeakness: text("top_weakness"),
    templateId: text("template_id"),
    status: text("status").notNull().default("success"),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("idx_outreach_institution").on(t.institutionId, t.pushedAt),
    index("idx_outreach_status").on(t.status),
  ],
);

export const rawDocuments = sqliteTable(
  "raw_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    contentType: text("content_type"),
    fetchedAt: timestampMs("fetched_at"),
    statusCode: integer("status_code"),
    sha256: text("sha256"),
    localPath: text("local_path"),
    bytes: integer("bytes"),
  },
  (t) => [
    uniqueIndex("uq_raw_url").on(t.url),
    index("idx_raw_sha").on(t.sha256),
  ],
);

export const savedViews = sqliteTable(
  "saved_views",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    filterJson: text("filter_json").notNull(),
    createdAt: timestampMs("created_at"),
  },
  (t) => [uniqueIndex("uq_view_name").on(t.name)],
);

// Compliance / regulatory / financial-health signals that aren't captured
// by an Ofsted/ISI inspection report. Sources include ESFA Notices to
// Improve, DfE financial intervention notices, RoATP register changes
// (added / restricted / removed), and Companies House filing health.
//
// One row per public notice / event. Severity drives how much it
// contributes to the institution's overall opportunity score (higher =
// more urgent buying trigger, since the provider is under public pressure
// to fix something Fledglings can address).
//
// Same evidence-rule as findings: every row stores its `sourceUrl` and a
// human-readable `subject`. If we can't link a claim to a specific public
// page we don't ship it.
export const complianceNotices = sqliteTable(
  "compliance_notices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),

    // 'esfa' | 'dfe' | 'roatp' | 'companies_house'
    noticeBody: text("notice_body").notNull(),

    // Detailed type — controls scoring contribution and UI label.
    // Examples:
    //   esfa.notice_to_improve_quality
    //   esfa.notice_to_improve_financial
    //   esfa.notice_to_improve_governance
    //   dfe.financial_intervention
    //   dfe.minimum_standards_intervention
    //   roatp.removed
    //   roatp.restricted
    //   roatp.added
    //   companies_house.accounts_overdue
    //   companies_house.gazette_strike_off
    //   companies_house.gazette_dissolution
    //   companies_house.ccj
    //   companies_house.insolvency
    noticeType: text("notice_type").notNull(),

    issuedAt: text("issued_at"),       // ISO date when notice was issued
    withdrawnAt: text("withdrawn_at"), // ISO date if/when notice was withdrawn
    expiresAt: text("expires_at"),     // for time-limited notices

    // 0-100 — how much of a buying trigger this notice is on its own.
    // Indicative bands:
    //   95-100  Active ESFA NTI for quality, RoATP removed, insolvency
    //   80-94   Active ESFA NTI financial / governance, RoATP restricted
    //   60-79   Companies House accounts overdue, CCJ
    //   40-59   Recent name change, minor filings flag
    //   <40     Withdrawn / historic / advisory only
    severity: integer("severity").notNull().default(50),

    subject: text("subject").notNull(),     // 1-line summary
    details: text("details"),               // longer body / parsed text
    sourceUrl: text("source_url").notNull(),
    sourceTitle: text("source_title"),

    // Raw scraper payload for debug / re-extraction without re-fetching.
    rawPayload: text("raw_payload"),

    firstSeenAt: timestampMs("first_seen_at"),
    lastSeenAt: timestampMs("last_seen_at"),
  },
  (t) => [
    // Dedup by (institution, source URL, notice type). `issued_at` is
    // omitted because it's often NULL — SQLite treats NULLs as distinct in
    // unique indexes which would let duplicates slip in. Notice type is
    // included so a single Companies House profile URL can yield multiple
    // notice rows (accounts_overdue + insolvency, etc.).
    uniqueIndex("uq_compliance_inst_url").on(
      t.institutionId,
      t.sourceUrl,
      t.noticeType,
    ),
    index("idx_compliance_institution").on(t.institutionId, t.severity),
    index("idx_compliance_body_type").on(t.noticeBody, t.noticeType),
    index("idx_compliance_issued").on(t.issuedAt),
    index("idx_compliance_active").on(t.withdrawnAt, t.severity),
  ],
);

// News items mentioning institutions — pulled from FE Week, Tes FE Focus,
// Schools Week, gov.uk press releases, and per-provider Google News
// queries. One row per (source, url, institution) so a single article
// linked to multiple providers gets one record per provider.
//
// `relevance` separates wheat from chaff: a piece in FE Week about a major
// ITP being acquired is high relevance; a passing-mention in a list of
// hundreds of providers is low relevance. The LLM extraction step writes
// this score.
export const newsItems = sqliteTable(
  "news_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),

    source: text("source").notNull(), // 'fe_week' | 'tes_fe' | 'schools_week' | 'gov_uk' | 'google_news' | ...
    url: text("url").notNull(),
    title: text("title").notNull(),
    excerpt: text("excerpt"),         // <= 800 chars
    body: text("body"),               // full extracted text if we have it
    publishedAt: text("published_at"),

    // 0-100 — how confident we are this article actually concerns this
    // provider (not just a passing mention or namesake match). Below 40 we
    // suppress from UI by default.
    relevance: integer("relevance").notNull().default(50),

    // 0-100 — how much of a Fledglings buying trigger the story is.
    // High when the article is about a safeguarding / behaviour / culture
    // / financial-stress / leadership-change event. Low for product launches
    // or generic awards.
    triggerSeverity: integer("trigger_severity").notNull().default(0),

    // Comma-separated curriculum tags from extraction
    // ('financial_literacy', 'employability_skills', etc.)
    curriculaTagged: text("curricula_tagged"),

    // 1-line LLM-written summary of why this matters for Fledglings.
    angle: text("angle"),

    contentHash: text("content_hash"),
    firstSeenAt: timestampMs("first_seen_at"),
    lastSeenAt: timestampMs("last_seen_at"),
  },
  (t) => [
    uniqueIndex("uq_news_url_inst").on(t.url, t.institutionId),
    index("idx_news_institution").on(t.institutionId, t.triggerSeverity),
    index("idx_news_source").on(t.source, t.publishedAt),
    index("idx_news_published").on(t.publishedAt),
    index("idx_news_relevance").on(t.relevance),
  ],
);

// Cache of Claude-polished email drafts. One row per institution; we only
// re-call the API when the user clicks "Re-polish" or the underlying top
// finding changes. Lets us bound spend even on heavy interactive use.
export const polishedEmails = sqliteTable(
  "polished_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    institutionId: integer("institution_id")
      .notNull()
      .references(() => institutions.id, { onDelete: "cascade" }),
    topFindingId: integer("top_finding_id"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestampMs("created_at"),
  },
  (t) => [uniqueIndex("uq_polished_institution").on(t.institutionId)],
);

export type Institution = typeof institutions.$inferSelect;
export type NewInstitution = typeof institutions.$inferInsert;
export type Inspection = typeof inspections.$inferSelect;
export type NewInspection = typeof inspections.$inferInsert;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type CurriculumMatch = typeof curriculumMatches.$inferSelect;
export type OpportunityScore = typeof opportunityScores.$inferSelect;
export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type OutreachLogEntry = typeof outreachLog.$inferSelect;
export type RawDocument = typeof rawDocuments.$inferSelect;
export type SavedView = typeof savedViews.$inferSelect;
export type ComplianceNotice = typeof complianceNotices.$inferSelect;
export type NewComplianceNotice = typeof complianceNotices.$inferInsert;
export type NewsItem = typeof newsItems.$inferSelect;
export type NewNewsItem = typeof newsItems.$inferInsert;

export const INSTITUTION_TYPES = [
  "state_school",
  "independent_school",
  "sixth_form_college",
  "fe_college",
  "itp",
  "university",
  "employer",
  "other",
] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const INSPECTION_BODIES = ["ofsted", "isi"] as const;
export type InspectionBody = (typeof INSPECTION_BODIES)[number];

export const GRADES = [
  "outstanding",
  "good",
  "requires_improvement",
  "inadequate",
  "meets_standard",
  "does_not_meet_standard",
  "not_judged",
] as const;
export type Grade = (typeof GRADES)[number];

export const CURRICULA = [
  "financial_literacy",
  "employability_skills",
  "confidence_resilience",
  "online_safety",
] as const;
export type Curriculum = (typeof CURRICULA)[number];

export const SECTION_KEYS = [
  "summary",
  "main_findings",
  "what_school_needs_to_improve",
  "what_provider_needs_to_improve",
  "recommendations",
  "areas_for_action",
  "areas_for_improvement",
  "significant_strengths",
  "strengths",
  "safeguarding",
  "personal_development",
  "behaviour_attitudes",
  "quality_of_education",
  "leadership_management",
  "sixth_form",
  "apprenticeships",
  "body",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
