import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import {
  client,
  db,
  findings,
  inspections,
  institutions,
  opportunityScores,
} from "@/db";
import { gradeLabel } from "@/lib/grades";

export const dynamic = "force-dynamic";

const HEADERS = [
  "name",
  "type",
  "region",
  "local_authority",
  "postcode",
  "ukprn",
  "urn",
  "head_name",
  "head_email",
  "general_email",
  "phone",
  "website",
  "tier",
  "score",
  "urgency_score",
  "pipeline_value_score",
  "raw_score",
  "top_curriculum",
  "top_curriculum_score",
  "finding_count",
  "current_grade",
  "previous_grade",
  "grade_dropped",
  "latest_inspection_date",
  "report_url",
  "top_weakness_phrase",
  "top_weakness_quote",
  "active_compliance_count",
  "compliance_top_subject",
  "compliance_top_severity",
  "compliance_top_url",
  "active_news_count",
  "news_top_title",
  "news_top_severity",
  "news_top_curricula",
  "news_top_angle",
  "news_top_url",
  "critical_signals",
];

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = Object.fromEntries(url.searchParams);

  const conds = [];
  if (params.q) {
    const like1 = `%${params.q}%`;
    conds.push(
      or(like(institutions.name, like1), like(institutions.postcode, like1)),
    );
  }
  if (params.region) conds.push(eq(institutions.region, params.region));
  if (params.type) conds.push(eq(institutions.type, params.type));
  if (params.curriculum)
    conds.push(eq(opportunityScores.topCurriculum, params.curriculum));
  if (params.tier) conds.push(eq(opportunityScores.tier, params.tier));
  if (params.min_score)
    conds.push(gte(opportunityScores.score, Number(params.min_score)));
  if (params.max_score)
    conds.push(lte(opportunityScores.score, Number(params.max_score)));

  const baseQuery = db
    .select({
      id: institutions.id,
      name: institutions.name,
      type: institutions.type,
      region: institutions.region,
      la: institutions.localAuthority,
      postcode: institutions.postcode,
      ukprn: institutions.ukprn,
      urn: institutions.urn,
      headName: institutions.headName,
      headEmail: institutions.headEmail,
      generalEmail: institutions.generalEmail,
      phone: institutions.phone,
      website: institutions.website,
      tier: opportunityScores.tier,
      score: opportunityScores.score,
      urgencyScore: opportunityScores.urgencyScore,
      pipelineValueScore: opportunityScores.pipelineValueScore,
      rawScore: opportunityScores.rawScore,
      topCurriculum: opportunityScores.topCurriculum,
      topCurriculumScore: opportunityScores.topCurriculumScore,
      topFindingId: opportunityScores.topFindingId,
      findingCount: opportunityScores.findingCount,
      criticalSignals: opportunityScores.criticalSignals,
      currentGrade: inspections.overallGrade,
      previousGrade: inspections.previousOverallGrade,
      gradeDropped: inspections.gradeDropped,
      inspectionDate: inspections.inspectionStartDate,
      reportUrl: inspections.reportUrl,
    })
    .from(opportunityScores)
    .innerJoin(
      institutions,
      eq(institutions.id, opportunityScores.institutionId),
    )
    .leftJoin(
      inspections,
      eq(inspections.id, opportunityScores.lastInspectionId),
    )
    .orderBy(desc(opportunityScores.score), desc(opportunityScores.rawScore))
    .limit(5000);

  const rows = await (conds.length
    ? baseQuery.where(and(...conds))
    : baseQuery);

  // Lookup top finding details for everything in the result.
  const findingIds = rows
    .map((r) => r.topFindingId)
    .filter((id): id is number => id != null);
  const findingMap = new Map<
    number,
    { phraseId: string; quote: string }
  >();
  if (findingIds.length) {
    const fRows = await db
      .select({
        id: findings.id,
        phraseId: findings.phraseId,
        quote: findings.sourceQuote,
      })
      .from(findings)
      .where(
        sql`${findings.id} IN (${sql.join(
          findingIds.map((i) => sql`${i}`),
          sql`,`,
        )})`,
      );
    for (const f of fRows)
      findingMap.set(f.id, { phraseId: f.phraseId, quote: f.quote });
  }

  // Compliance + news aggregates per institution. We pull the active
  // counts and the highest-severity row per institution in two queries
  // and key by institution_id.
  const instIds = rows.map((r) => r.id);
  const complianceMap = new Map<
    number,
    { count: number; subject: string; severity: number; url: string }
  >();
  const newsMap = new Map<
    number,
    { count: number; title: string; severity: number; curricula: string; angle: string; url: string }
  >();

  if (instIds.length) {
    const placeholders = instIds.map(() => "?").join(",");
    const cRes = await client.execute({
      sql: `SELECT institution_id,
                   COUNT(*) AS count,
                   MAX(severity) AS top_sev
            FROM compliance_notices
            WHERE withdrawn_at IS NULL
              AND institution_id IN (${placeholders})
            GROUP BY institution_id`,
      args: instIds as unknown as Array<string | number>,
    });
    for (const r of cRes.rows as unknown as {
      institution_id: number;
      count: number;
      top_sev: number;
    }[]) {
      complianceMap.set(r.institution_id, {
        count: r.count,
        subject: "",
        severity: r.top_sev,
        url: "",
      });
    }
    // Now get the actual top-severity row per institution
    const cTopRes = await client.execute({
      sql: `SELECT cn.institution_id, cn.subject, cn.severity, cn.source_url
            FROM compliance_notices cn
            WHERE cn.withdrawn_at IS NULL
              AND cn.institution_id IN (${placeholders})
              AND cn.severity = (
                SELECT MAX(c2.severity) FROM compliance_notices c2
                WHERE c2.institution_id = cn.institution_id AND c2.withdrawn_at IS NULL
              )`,
      args: instIds as unknown as Array<string | number>,
    });
    for (const r of cTopRes.rows as unknown as {
      institution_id: number;
      subject: string;
      severity: number;
      source_url: string;
    }[]) {
      const entry = complianceMap.get(r.institution_id);
      if (entry) {
        entry.subject = r.subject;
        entry.url = r.source_url;
      }
    }

    const nRes = await client.execute({
      sql: `SELECT institution_id,
                   COUNT(*) AS count
            FROM news_items
            WHERE relevance >= 50 AND trigger_severity > 0
              AND institution_id IN (${placeholders})
            GROUP BY institution_id`,
      args: instIds as unknown as Array<string | number>,
    });
    for (const r of nRes.rows as unknown as {
      institution_id: number;
      count: number;
    }[]) {
      newsMap.set(r.institution_id, {
        count: r.count,
        title: "", severity: 0, curricula: "", angle: "", url: "",
      });
    }
    const nTopRes = await client.execute({
      sql: `SELECT n.institution_id, n.title, n.trigger_severity, n.curricula_tagged, n.angle, n.url
            FROM news_items n
            WHERE n.relevance >= 50 AND n.trigger_severity > 0
              AND n.institution_id IN (${placeholders})
              AND n.trigger_severity = (
                SELECT MAX(n2.trigger_severity) FROM news_items n2
                WHERE n2.institution_id = n.institution_id
                  AND n2.relevance >= 50 AND n2.trigger_severity > 0
              )`,
      args: instIds as unknown as Array<string | number>,
    });
    for (const r of nTopRes.rows as unknown as {
      institution_id: number;
      title: string;
      trigger_severity: number;
      curricula_tagged: string | null;
      angle: string | null;
      url: string;
    }[]) {
      const entry = newsMap.get(r.institution_id);
      if (entry) {
        entry.title = r.title;
        entry.severity = r.trigger_severity;
        entry.curricula = r.curricula_tagged ?? "";
        entry.angle = r.angle ?? "";
        entry.url = r.url;
      }
    }
  }

  const lines: string[] = [HEADERS.join(",")];
  for (const r of rows) {
    const tf = r.topFindingId ? findingMap.get(r.topFindingId) : null;
    const c = complianceMap.get(r.id);
    const n = newsMap.get(r.id);
    lines.push(
      [
        r.name,
        r.type,
        r.region,
        r.la,
        r.postcode,
        r.ukprn,
        r.urn,
        r.headName,
        r.headEmail,
        r.generalEmail,
        r.phone,
        r.website,
        r.tier,
        r.score,
        r.urgencyScore,
        r.pipelineValueScore,
        r.rawScore,
        r.topCurriculum,
        r.topCurriculumScore,
        r.findingCount,
        gradeLabel(r.currentGrade),
        gradeLabel(r.previousGrade),
        r.gradeDropped ? "yes" : "no",
        r.inspectionDate,
        r.reportUrl,
        tf?.phraseId ?? "",
        tf?.quote ?? "",
        c?.count ?? 0,
        c?.subject ?? "",
        c?.severity ?? "",
        c?.url ?? "",
        n?.count ?? 0,
        n?.title ?? "",
        n?.severity ?? "",
        n?.curricula ?? "",
        n?.angle ?? "",
        n?.url ?? "",
        r.criticalSignals ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  const csv = lines.join("\n") + "\n";
  const filename = `fledglings-opportunities-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
