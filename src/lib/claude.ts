/**
 * Minimal server-side Claude wrapper.
 *
 * Used only by the optional "Polish with Claude" button on the opportunity
 * detail page. Cheap by design:
 *   - Model: Haiku 4.5 (fastest + lowest cost in the Claude 4 family)
 *   - Input: ~500 tokens (rendered email + source quote + curriculum tag)
 *   - No retrieval over the full report — just the verbatim quote
 *   - Cached per institution in the polished_emails table
 *
 * Cost ballpark per click on Haiku 4.5:
 *   ~500 input + ~300 output = roughly £0.001
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

// Some shell environments (notably Claude Code sessions) pre-export
// ANTHROPIC_API_KEY=  as a safety guard. That empty string then beats the
// project's .env file, leaving us with no key. Fall back to reading .env
// from disk at request time when the runtime value is missing or blank.
let cachedKey: string | null | undefined;
function readApiKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const envValue = process.env.ANTHROPIC_API_KEY;
  if (envValue && envValue.trim()) {
    cachedKey = envValue.trim();
    return cachedKey;
  }
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const contents = readFileSync(envPath, "utf-8");
    for (const line of contents.split(/\r?\n/)) {
      const m = line.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) {
        const raw = m[1].trim();
        const value = raw.replace(/^["']|["']$/g, "");
        if (value) {
          cachedKey = value;
          return cachedKey;
        }
      }
    }
  } catch {
    /* no .env file */
  }
  cachedKey = null;
  return null;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = readApiKey();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export function isClaudeEnabled(): boolean {
  return Boolean(readApiKey());
}

const SYSTEM_PROMPT = `You polish B2B sales emails for Fledglings, a UK EdTech provider that sells SCORM learning modules to schools, sixth forms, FE colleges and ITPs across England.

Brand voice: passionate, genuine, authentic, relatable, proactive, supportive, informative. Lean casual, lean enthusiastic. Direct and engaging without corporate jargon. British English.

Audience: headteachers, principals and senior leaders responsible for personal development, careers, PSHE, and safeguarding for learners aged Year 9 to 25.

Your job: rewrite the supplied draft so it lands. Keep the verbatim inspector quote unchanged (block quote in the middle). Punchier opener, clearer ask, single 20-minute CTA. Stay under 200 words for the body. Sign off with the slogan "Where Growth Takes Flight,". Never invent facts about the school. Never make claims about Fledglings beyond what's in the draft.

Output format: respond with JSON only, no markdown fences:
{"subject": "...", "body": "..."}`;

export type PolishInput = {
  institutionName: string;
  region: string | null;
  curriculum: string;
  topWeakness: string | null;
  sourceQuote: string | null;
  headName: string | null;
  inspectionDate: string | null;
  currentGrade: string | null;
  draft: { subject: string; body: string };
  // New fresh signals — all optional, used when present to give the email
  // a more specific, time-sensitive hook than a generic inspection quote.
  complianceSubject?: string | null;
  complianceSeverity?: number | null;
  newsTitle?: string | null;
  newsAngle?: string | null;
  newsPublishedAt?: string | null;
};

export type PolishResult = {
  subject: string;
  body: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

function buildUserMessage(input: PolishInput): string {
  const lines: (string | null)[] = [
    `Institution: ${input.institutionName}${input.region ? " (" + input.region + ")" : ""}`,
    `Lead-with curriculum: ${input.curriculum.replace(/_/g, " ")}`,
    input.topWeakness ? `Top weakness: ${input.topWeakness}` : null,
    input.inspectionDate ? `Inspection date: ${input.inspectionDate}` : null,
    input.currentGrade ? `Current grade: ${input.currentGrade}` : null,
    input.headName ? `Recipient: ${input.headName}` : null,
  ];

  // Fresher signals when we have them — these give the AE a more
  // time-sensitive hook than a 6-month-old inspection quote. Pick the
  // most recent / most severe and surface it.
  const fresh: string[] = [];
  if (input.complianceSubject) {
    fresh.push(
      `Active compliance signal: "${input.complianceSubject}" (severity ${input.complianceSeverity ?? "?"}). This is a public regulatory notice the prospect's leadership is currently dealing with — reference it lightly to show you're paying attention, but DO NOT lead with it (we never make the prospect feel ambushed).`,
    );
  }
  if (input.newsTitle) {
    fresh.push(
      `Recent news (${input.newsPublishedAt ?? "recent"}): "${input.newsTitle}"${input.newsAngle ? ` — angle: ${input.newsAngle}` : ""}. Reference this as the trigger for reaching out now, in a respectful way that shows we read trade press, not just inspection reports.`,
    );
  }
  if (fresh.length > 0) {
    lines.push("");
    lines.push("FRESH SIGNALS (optional — fold into the opener if a clean angle exists)");
    lines.push("==========");
    for (const f of fresh) lines.push(f);
    lines.push("==========");
  }

  lines.push("");
  lines.push("DRAFT TO POLISH");
  lines.push("==========");
  lines.push(`Subject: ${input.draft.subject}`);
  lines.push("");
  lines.push(input.draft.body);
  lines.push("==========");
  lines.push("");
  lines.push(
    input.sourceQuote
      ? `The verbatim inspector quote MUST appear unchanged inside the body, in a block quote (lines starting with "> "):\n${input.sourceQuote}`
      : "No quote supplied — keep the email's existing structure.",
  );
  return lines.filter((l): l is string => l !== null).join("\n");
}

export async function polishEmail(input: PolishInput): Promise<PolishResult> {
  const c = getClient();
  const message = await c.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

  const textBlock = message.content.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  if (!textBlock) throw new Error("No text content in Claude response");

  const raw = textBlock.text.trim();
  // Strip optional ```json fences if Haiku adds them.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Claude returned non-JSON: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
    throw new Error("Claude response missing subject or body");
  }

  return {
    subject: parsed.subject.trim(),
    body: parsed.body.trim(),
    model: MODEL,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

// ----- helpers -------------------------------------------------------------

// Extract the first balanced JSON object from a string. Tolerates leading
// ```json fences, surrounding prose, and trailing reasoning. Returns null
// if no plausible JSON object is found.
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ----- news extraction -----------------------------------------------------

const NEWS_EXTRACTION_SYSTEM = `You evaluate news articles about UK schools, FE colleges and apprenticeship training providers for relevance to a B2B education vendor called Fledglings.

Fledglings sells SCORM learning modules covering four curricula:
  - financial_literacy: budgeting, debt, tax, money management for Year 9–25 learners
  - employability_skills: CV, interview prep, workplace behaviour, careers, apprenticeships
  - confidence_resilience: behaviour, mental health, personal development, anti-bullying, transition
  - online_safety: digital citizenship, e-safety, sexting, grooming, social media risks, prevent

For each article, decide:
1. relevance (0-100) — is this article actually about THIS provider, and is it specific (not a passing mention or list-roundup)? 0 = unrelated namesake, 50 = mentioned but not the focus, 90+ = the article is about them
2. trigger_severity (0-100) — would this story make a sales rep at Fledglings want to reach out within the next month? Score on:
   - 90+: Inadequate Ofsted, safeguarding failure, financial collapse, leadership scandal, redundancies, staff strikes, behaviour crisis, government intervention
   - 70-89: Requires Improvement Ofsted, contract loss, merger, exec departure with operational implications, safeguarding concerns flagged
   - 40-69: Mild reputational story, building issues, exam results dip, minor incident
   - 0-39: Awards, sports wins, fundraising, generic curriculum updates, expansion, partnerships, positive PR
3. curricula_tagged — comma-separated list of any of the 4 curriculum keys above the article specifically suggests need (e.g. a behaviour story → confidence_resilience; a careers programme cut → employability_skills). Empty string if none.
4. angle — one short sentence (≤25 words) describing why a Fledglings AE should care, written for the AE not the prospect. e.g. "Staff strikes signal morale collapse — pre-employment programmes will be deprioritised, but D&I/wellbeing training pitched at students is in-favour." If irrelevant, write "no angle".

Output JSON only, no markdown fences:
{"relevance": <int>, "trigger_severity": <int>, "curricula_tagged": "<comma-separated keys>", "angle": "<short sentence>"}`;

export type NewsExtractionInput = {
  institutionName: string;
  institutionType: string;
  title: string;
  excerpt: string;
  source: string;
  publishedAt: string | null;
};

export type NewsExtractionResult = {
  relevance: number;
  triggerSeverity: number;
  curriculaTagged: string;
  angle: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export async function extractNewsSignal(
  input: NewsExtractionInput,
): Promise<NewsExtractionResult> {
  const c = getClient();
  const userMessage = [
    `Institution: ${input.institutionName} (${input.institutionType})`,
    `Source: ${input.source}${input.publishedAt ? ` — ${input.publishedAt}` : ""}`,
    `Title: ${input.title}`,
    `Excerpt: ${input.excerpt.slice(0, 800)}`,
  ].join("\n");

  const message = await c.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: NEWS_EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = message.content.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  if (!textBlock) throw new Error("No text content in Claude response");
  const raw = textBlock.text.trim();

  // Haiku sometimes appends reasoning after the JSON, or wraps it in
  // ```json fences. Extract just the first balanced {...} object.
  const cleaned = extractFirstJsonObject(raw);
  if (!cleaned) {
    throw new Error(
      `Claude news extraction returned no JSON object: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  let parsed: {
    relevance?: unknown;
    trigger_severity?: unknown;
    curricula_tagged?: unknown;
    angle?: unknown;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Claude news extraction returned non-JSON: ${cleaned.slice(0, 200).replace(/\s+/g, " ")}`,
    );
  }

  const clamp = (n: unknown, lo: number, hi: number): number => {
    const v = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(lo, Math.min(hi, Math.round(v)));
  };

  return {
    relevance: clamp(parsed.relevance, 0, 100),
    triggerSeverity: clamp(parsed.trigger_severity, 0, 100),
    curriculaTagged:
      typeof parsed.curricula_tagged === "string" ? parsed.curricula_tagged.trim() : "",
    angle: typeof parsed.angle === "string" ? parsed.angle.trim() : "no angle",
    model: MODEL,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
