/**
 * Splits an Ofsted or ISI inspection report's plain text into canonical
 * named sections. Each section carries a multiplier that the phrase
 * extractor uses to weight findings: action sections get 2.0,
 * recommendations get 1.5, body gets 1.0, strengths get 0.0 (excluded).
 *
 * Sections are bounded both by the *next* recognised section AND by an
 * "end marker" set — administrative tails like "Provider details",
 * "Information about this inspection", "Annex", that aren't sales-relevant
 * and cause briefs to spill into junk text if not trimmed.
 */

import { createHash } from "node:crypto";

export type ParsedSection = {
  sectionKey: string;
  sectionTitle: string;
  sectionText: string;
  multiplier: number;
  orderIndex: number;
};

// Section-detection regexes. Each entry can carry `keyForMatch` to override
// the section_key based on which specific pattern fired — so the FE/ITP
// "what does the provider need to do to improve" gets stored as
// `what_provider_needs_to_improve` rather than the school-flavoured key.
type Marker = {
  patterns: Array<{ re: RegExp; keyForMatch?: string }>;
  key: string;
  multiplier: number;
};

const SECTION_MARKERS: Marker[] = [
  {
    key: "what_school_needs_to_improve",
    multiplier: 2.0,
    patterns: [
      { re: /what does the school need to do to improve/i },
      {
        re: /what does the provider need to do to improve/i,
        keyForMatch: "what_provider_needs_to_improve",
      },
      { re: /what does the (?:college|sixth form) need to do to improve/i },
      { re: /how can the school improve further/i },
      { re: /the school must take the following actions/i },
    ],
  },
  {
    key: "areas_for_action",
    multiplier: 2.0,
    patterns: [
      { re: /areas (?:for|requiring) action/i },
      { re: /priority actions/i },
    ],
  },
  {
    key: "recommendations",
    multiplier: 1.5,
    patterns: [
      { re: /^\s*recommendations\b/im },
      { re: /^\s*recommended actions/im },
    ],
  },
  {
    key: "areas_for_improvement",
    multiplier: 1.5,
    patterns: [{ re: /areas for improvement/i }],
  },
  {
    key: "significant_strengths",
    multiplier: 0.0,
    patterns: [
      { re: /significant strengths/i },
      { re: /^\s*strengths\b/im },
      { re: /the school's strengths/i },
    ],
  },
  {
    key: "safeguarding",
    multiplier: 1.0,
    patterns: [
      { re: /^\s*safeguarding\b/im },
      { re: /safeguarding (?:is )?effective/i },
    ],
  },
  {
    key: "main_findings",
    multiplier: 1.0,
    patterns: [
      { re: /what is it like to attend this school/i },
      { re: /what is it like to be a learner/i },
      { re: /what is it like to attend this provider/i },
      { re: /what is it like to attend this college/i },
    ],
  },
  {
    key: "main_findings",
    multiplier: 1.0,
    patterns: [
      { re: /what does the school do well/i },
      { re: /what does the provider do well/i },
    ],
  },
  {
    // Standalone narrative sections in the F&S framework. Apprenticeships,
    // adult learning, young people's provision, high needs.
    key: "apprenticeships",
    multiplier: 1.5,
    patterns: [{ re: /^\s*apprenticeships\s*$/im }],
  },
  {
    key: "adult_learning",
    multiplier: 1.5,
    patterns: [{ re: /adult\s+learning\s+programmes/i }],
  },
  {
    key: "young_peoples_provision",
    multiplier: 1.5,
    patterns: [
      { re: /education\s+programmes\s+for\s+young\s+people/i },
      { re: /^\s*(?:16\s+to\s+19\s+study\s+programmes?|study\s+programmes?\s+for\s+young\s+people)/im },
    ],
  },
  {
    key: "high_needs_provision",
    multiplier: 1.5,
    patterns: [
      { re: /provision\s+for\s+learners\s+with\s+high\s+needs/i },
      { re: /high\s+needs\s+provision/i },
    ],
  },
  {
    key: "quality_of_education",
    multiplier: 1.0,
    patterns: [{ re: /^\s*quality\s+of\s+education\s*$/im }],
  },
  {
    key: "behaviour_attitudes",
    multiplier: 1.0,
    patterns: [{ re: /behaviour and attitudes/i }],
  },
  {
    key: "personal_development",
    multiplier: 1.0,
    patterns: [{ re: /^\s*personal\s+development\s*$/im }],
  },
  {
    key: "leadership_management",
    multiplier: 1.0,
    patterns: [{ re: /leadership\s+and\s+management/i }],
  },
  {
    key: "summary",
    multiplier: 0.5,
    patterns: [
      { re: /information about this school/i },
      { re: /information about this provider/i },
    ],
  },
];

// Markers that TERMINATE the current section without becoming a section
// of their own. Pure administrative trailers. Keeping these out of any
// section's `section_text` is what stops briefs spilling into 60 lines of
// "Provider details · UKPRN: ..." junk.
const END_MARKERS: RegExp[] = [
  /^\s*provider details\b/im,
  /^\s*school details\b/im,
  /^\s*information about this inspection\b/im,
  /^\s*the inspection team\b/im,
  /^\s*annex\b/im,
  /^\s*how can I feedback my views\b/im,
  /^\s*if you are not satisfied\b/im,
  /^\s*the parent view (?:online )?questionnaire\b/im,
  /^\s*you can use parent view\b/im,
  /^\s*interested in our work\b/im,
  /this publication is available at https?:\/\//i,
  // Footer / page-break artefacts repeated on every page of the PDF.
  /^\s*Inspection report:\s*[A-Z]/m,
  /^\s*Re-inspection report:\s*[A-Z]/m,
  /^\s*\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*$/im,
];

export function sectionise(text: string): ParsedSection[] {
  if (!text || text.length < 100) {
    return [
      {
        sectionKey: "body",
        sectionTitle: "Body",
        sectionText: text ?? "",
        multiplier: 1.0,
        orderIndex: 0,
      },
    ];
  }

  type Found = {
    key: string;
    multiplier: number;
    start: number;
    title: string;
  };
  const found: Found[] = [];

  for (const m of SECTION_MARKERS) {
    for (const p of m.patterns) {
      const match = text.match(p.re);
      if (match && match.index !== undefined) {
        found.push({
          key: p.keyForMatch ?? m.key,
          multiplier: m.multiplier,
          start: match.index,
          title: match[0].trim(),
        });
      }
    }
  }

  // Find positions of END_MARKERS — used later to truncate section_text.
  // Need *all* matches not just the first: page footers like
  // "Inspection report: Woodspeen Training" repeat once per PDF page,
  // and we want to truncate at the FIRST one that appears after a given
  // section's start. Build a `g`-flagged copy of each pattern so
  // `matchAll` works.
  const endPositions: number[] = [];
  for (const re of END_MARKERS) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const reGlobal = new RegExp(re.source, flags);
    for (const match of text.matchAll(reGlobal)) {
      if (match.index !== undefined) endPositions.push(match.index);
    }
  }
  endPositions.sort((a, b) => a - b);

  found.sort((a, b) => a.start - b.start);

  // Keep first occurrence per key; later mentions tend to be cross-references.
  const seen = new Set<string>();
  const unique: Found[] = [];
  for (const m of found) {
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    unique.push(m);
  }

  if (!unique.length) {
    return [
      {
        sectionKey: "body",
        sectionTitle: "Body",
        sectionText: text,
        multiplier: 1.0,
        orderIndex: 0,
      },
    ];
  }

  const sections: ParsedSection[] = [];
  let order = 0;

  // Anything before the first marker becomes a summary.
  if (unique[0].start > 200) {
    sections.push({
      sectionKey: "summary",
      sectionTitle: "Summary",
      sectionText: text.slice(0, unique[0].start).trim(),
      multiplier: 0.5,
      orderIndex: order++,
    });
  }

  // Keys that often match the grade table at the top of an F&S report
  // (e.g. "Apprenticeships  Requires improvement"). For these, require a
  // longer body or skip — the grade alone is already on the inspections
  // table, and a 1-line snippet adds nothing in a brief.
  const stricterMinLength: Record<string, number> = {
    apprenticeships: 250,
    adult_learning: 250,
    young_peoples_provision: 250,
    high_needs_provision: 250,
    quality_of_education: 250,
    behaviour_attitudes: 250,
    personal_development: 250,
    leadership_management: 250,
  };

  for (let i = 0; i < unique.length; i++) {
    const startIdx = unique[i].start;
    const nextSectionStart = i + 1 < unique.length ? unique[i + 1].start : text.length;
    // Truncate at the first END_MARKER that falls between this section's
    // start and the next section's start. That keeps "Provider details"
    // / "Annex" boilerplate out of every section it touches.
    let endIdx = nextSectionStart;
    for (const ep of endPositions) {
      if (ep > startIdx && ep < endIdx) {
        endIdx = ep;
        break;
      }
    }
    const body = text.slice(startIdx, endIdx).trim();
    const minLen = stricterMinLength[unique[i].key] ?? 60;
    if (body.length < minLen) continue;
    sections.push({
      sectionKey: unique[i].key,
      sectionTitle: unique[i].title,
      sectionText: body,
      multiplier: unique[i].multiplier,
      orderIndex: order++,
    });
  }

  return sections;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
