import { desc, eq } from "drizzle-orm";
import {
  db,
  findings,
  inspections,
  institutions,
  opportunityScores,
  outreachLog,
} from "@/db";
import { createLead, splitName } from "@/lib/instantly";
import { gradeLabel } from "@/lib/grades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { institutionId?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }

  const id = Number(body.institutionId);
  if (!Number.isFinite(id)) {
    return Response.json({ ok: false, message: "institutionId required" }, {
      status: 400,
    });
  }

  const inst = (
    await db.select().from(institutions).where(eq(institutions.id, id)).limit(1)
  )[0];
  if (!inst) {
    return Response.json({ ok: false, message: "Institution not found" }, {
      status: 404,
    });
  }

  const email = inst.headEmail || inst.generalEmail;
  if (!email) {
    return Response.json(
      {
        ok: false,
        message:
          "No contact email on record. Add head_email or general_email manually before pushing.",
      },
      { status: 400 },
    );
  }

  const score = (
    await db
      .select()
      .from(opportunityScores)
      .where(eq(opportunityScores.institutionId, id))
      .limit(1)
  )[0];

  const latest = (
    await db
      .select()
      .from(inspections)
      .where(eq(inspections.institutionId, id))
      .orderBy(desc(inspections.inspectionStartDate))
      .limit(1)
  )[0];

  let topFinding = null;
  if (score?.topFindingId) {
    topFinding = (
      await db
        .select()
        .from(findings)
        .where(eq(findings.id, score.topFindingId))
        .limit(1)
    )[0];
  }

  const { first, last } = splitName(inst.headName);

  try {
    const result = await createLead({
      email,
      firstName: first,
      lastName: last,
      companyName: inst.name,
      campaignId: process.env.INSTANTLY_DEFAULT_CAMPAIGN_ID,
      listId: process.env.INSTANTLY_DEFAULT_LIST_ID,
      customVariables: {
        top_curriculum: score?.topCurriculum,
        top_weakness: topFinding?.phraseId,
        top_weakness_quote: topFinding?.sourceQuote,
        latest_grade: gradeLabel(latest?.overallGrade),
        previous_grade: gradeLabel(latest?.previousOverallGrade),
        inspection_date: latest?.inspectionStartDate,
        inspection_url: latest?.reportUrl,
        opportunity_score: score?.score?.toString(),
        region: inst.region,
        institution_type: inst.type,
      },
    });

    await db.insert(outreachLog).values({
      institutionId: id,
      instantlyLeadId: result.ok ? result.leadId : null,
      instantlyCampaignId: process.env.INSTANTLY_DEFAULT_CAMPAIGN_ID ?? null,
      instantlyListId: process.env.INSTANTLY_DEFAULT_LIST_ID ?? null,
      topCurriculum: score?.topCurriculum,
      topWeakness: topFinding?.phraseId,
      templateId: score?.topCurriculum,
      status: result.ok ? "success" : "failed",
      errorMessage: result.ok ? null : result.error,
    });

    if (result.ok) {
      return Response.json({
        ok: true,
        message: `Pushed to Instantly (lead ${result.leadId || "id pending"}).`,
      });
    }
    return Response.json(
      { ok: false, message: result.error.slice(0, 200) },
      { status: result.status >= 400 ? result.status : 502 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.insert(outreachLog).values({
      institutionId: id,
      status: "failed",
      errorMessage: msg.slice(0, 500),
    });
    return Response.json(
      { ok: false, message: msg.slice(0, 200) },
      { status: 500 },
    );
  }
}
