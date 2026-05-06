import { and, desc, eq, gte, isNull } from "drizzle-orm";
import {
  complianceNotices,
  db,
  findings,
  inspections,
  institutions,
  newsItems,
  opportunityScores,
  polishedEmails,
} from "@/db";
import { isClaudeEnabled, polishEmail } from "@/lib/claude";
import { renderEmail } from "@/lib/templates";
import { gradeLabel } from "@/lib/grades";
import { formatDate } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isClaudeEnabled()) {
    return Response.json(
      { ok: false, message: "ANTHROPIC_API_KEY not set in .env" },
      { status: 503 },
    );
  }

  let body: { institutionId?: number; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { ok: false, message: "Invalid JSON" },
      { status: 400 },
    );
  }

  const id = Number(body.institutionId);
  if (!Number.isFinite(id)) {
    return Response.json(
      { ok: false, message: "institutionId required" },
      { status: 400 },
    );
  }

  const inst = (
    await db.select().from(institutions).where(eq(institutions.id, id)).limit(1)
  )[0];
  if (!inst) {
    return Response.json(
      { ok: false, message: "Institution not found" },
      { status: 404 },
    );
  }

  const score = (
    await db
      .select()
      .from(opportunityScores)
      .where(eq(opportunityScores.institutionId, id))
      .limit(1)
  )[0];
  if (!score) {
    return Response.json(
      { ok: false, message: "Institution not scored yet" },
      { status: 400 },
    );
  }

  const latest = (
    await db
      .select()
      .from(inspections)
      .where(eq(inspections.institutionId, id))
      .orderBy(desc(inspections.inspectionStartDate))
      .limit(1)
  )[0];

  const topFinding = score.topFindingId
    ? (
        await db
          .select()
          .from(findings)
          .where(eq(findings.id, score.topFindingId))
          .limit(1)
      )[0]
    : null;

  // Cache check — return existing polished version unless forced.
  const cached = (
    await db
      .select()
      .from(polishedEmails)
      .where(eq(polishedEmails.institutionId, id))
      .limit(1)
  )[0];
  if (cached && !body.force && cached.topFindingId === topFinding?.id) {
    return Response.json({
      ok: true,
      cached: true,
      subject: cached.subject,
      body: cached.body,
      model: cached.model,
      createdAt: cached.createdAt,
    });
  }

  const curriculum = score.topCurriculum ?? "confidence_resilience";
  const ctx = {
    institution_name: inst.name,
    region: inst.region,
    inspection_date: latest ? formatDate(latest.inspectionStartDate) : null,
    current_grade: latest?.overallGrade ?? null,
    previous_grade: latest?.previousOverallGrade ?? null,
    top_weakness: topFinding ? phraseLabel(topFinding.phraseId) : null,
    source_quote: topFinding?.sourceQuote ?? null,
    source_section: topFinding?.sectionKey ?? null,
    report_url: latest?.reportUrl ?? null,
    head_name: inst.headName,
  };
  const draft = renderEmail(curriculum, ctx);

  // Pull the freshest fresh signals to feed Claude. We pick:
  //   - the highest-severity active compliance notice (regulatory hook)
  //   - the highest-trigger news article in the last 6 months (timeliness)
  // Both are optional — if the institution has neither, the email falls
  // back to the inspection-quote-only version.
  const topCompliance = (
    await db
      .select()
      .from(complianceNotices)
      .where(
        and(
          eq(complianceNotices.institutionId, id),
          isNull(complianceNotices.withdrawnAt),
        ),
      )
      .orderBy(desc(complianceNotices.severity))
      .limit(1)
  )[0];

  const topNews = (
    await db
      .select()
      .from(newsItems)
      .where(
        and(
          eq(newsItems.institutionId, id),
          gte(newsItems.relevance, 60),
          gte(newsItems.triggerSeverity, 60),
        ),
      )
      .orderBy(desc(newsItems.triggerSeverity), desc(newsItems.publishedAt))
      .limit(1)
  )[0];

  try {
    const result = await polishEmail({
      institutionName: inst.name,
      region: inst.region,
      curriculum,
      topWeakness: ctx.top_weakness,
      sourceQuote: ctx.source_quote,
      headName: inst.headName,
      inspectionDate: ctx.inspection_date,
      currentGrade: gradeLabel(latest?.overallGrade),
      draft: { subject: draft.subject, body: draft.body },
      complianceSubject: topCompliance?.subject ?? null,
      complianceSeverity: topCompliance?.severity ?? null,
      newsTitle: topNews?.title ?? null,
      newsAngle: topNews?.angle ?? null,
      newsPublishedAt: topNews?.publishedAt ?? null,
    });

    await db
      .insert(polishedEmails)
      .values({
        institutionId: id,
        topFindingId: topFinding?.id ?? null,
        subject: result.subject,
        body: result.body,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      })
      .onConflictDoUpdate({
        target: polishedEmails.institutionId,
        set: {
          topFindingId: topFinding?.id ?? null,
          subject: result.subject,
          body: result.body,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          createdAt: new Date(),
        },
      });

    return Response.json({
      ok: true,
      cached: false,
      subject: result.subject,
      body: result.body,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, message: msg.slice(0, 300) }, {
      status: 500,
    });
  }
}

function phraseLabel(phraseId: string): string {
  return phraseId
    .replace(/^[a-z_]+\./, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
