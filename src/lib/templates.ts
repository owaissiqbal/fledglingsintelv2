/**
 * Deterministic email-template renderer.
 *
 * No generation, no API calls — just merge-variable substitution against
 * Markdown templates in config/email-angles/. The dashboard picks the
 * template matching the institution's top-scoring curriculum, fills the
 * variables, and exposes "Copy to clipboard" in the UI.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { gradeLabel } from "./grades";

export type EmailContext = {
  institution_name: string;
  region?: string | null;
  inspection_date?: string | null;
  current_grade?: string | null;
  previous_grade?: string | null;
  top_weakness?: string | null;
  source_quote?: string | null;
  source_section?: string | null;
  report_url?: string | null;
  head_name?: string | null;
};

const TEMPLATE_DIR = path.resolve(process.cwd(), "config/email-angles");

const SLUG_MAP: Record<string, string> = {
  financial_literacy: "financial-literacy",
  employability_skills: "employability-skills",
  confidence_resilience: "confidence-resilience",
  online_safety: "online-safety",
};

function templatePath(curriculum: string): string {
  return path.join(TEMPLATE_DIR, `${SLUG_MAP[curriculum] ?? curriculum}.md`);
}

export function loadTemplate(curriculum: string): string {
  return readFileSync(templatePath(curriculum), "utf-8");
}

export function renderEmail(
  curriculum: string,
  ctx: EmailContext,
): { subject: string; body: string; raw: string } {
  let template: string;
  try {
    template = loadTemplate(curriculum);
  } catch {
    return {
      subject: `(no template for ${curriculum})`,
      body: "",
      raw: "",
    };
  }

  const renderedRaw = template.replace(
    /\{\{\s*([a-z_]+)\s*\}\}/g,
    (_, key: string) => {
      if (key === "current_grade") return gradeLabel(ctx.current_grade);
      if (key === "previous_grade") return gradeLabel(ctx.previous_grade);
      if (key === "head_name" && !ctx.head_name) return "there";
      const value = (ctx as Record<string, unknown>)[key];
      if (value == null || value === "") return `[${key}]`;
      return String(value);
    },
  );

  // Pull the first "Subject: ..." line out as the subject, the rest as body.
  const subjectMatch = renderedRaw.match(/^Subject:\s*(.+)$/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : "";
  const body = renderedRaw
    .replace(/^Subject:\s*.+\n\n?/m, "")
    .trim();

  return { subject, body, raw: renderedRaw };
}
