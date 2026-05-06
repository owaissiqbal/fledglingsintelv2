/**
 * Splits an Ofsted or ISI inspection report's plain text into canonical
 * named sections. Each section carries a multiplier that the phrase
 * extractor uses to weight findings: action sections get 2.0, recommendations
 * get 1.5, body gets 1.0, strengths get 0.0 (excluded entirely).
 */

import { createHash } from "node:crypto";

export type ParsedSection = {
  sectionKey: string;
  sectionTitle: string;
  sectionText: string;
  multiplier: number;
  orderIndex: number;
};

const SECTION_MARKERS: Array<{
  patterns: RegExp[];
  key: string;
  multiplier: number;
}> = [
  {
    patterns: [
      /what does the school need to do to improve/i,
      /what does the provider need to do to improve/i,
      /what does the (?:college|sixth form) need to do to improve/i,
      /how can the school improve further/i,
      /the school must take the following actions/i,
    ],
    key: "what_school_needs_to_improve",
    multiplier: 2.0,
  },
  {
    patterns: [/areas (?:for|requiring) action/i, /priority actions/i],
    key: "areas_for_action",
    multiplier: 2.0,
  },
  {
    patterns: [/^\s*recommendations\b/im, /^\s*recommended actions/im],
    key: "recommendations",
    multiplier: 1.5,
  },
  {
    patterns: [/areas for improvement/i],
    key: "areas_for_improvement",
    multiplier: 1.5,
  },
  {
    patterns: [
      /significant strengths/i,
      /^\s*strengths\b/im,
      /the school's strengths/i,
    ],
    key: "significant_strengths",
    multiplier: 0.0,
  },
  {
    patterns: [/^\s*safeguarding\b/im, /safeguarding (?:is )?effective/i],
    key: "safeguarding",
    multiplier: 1.0,
  },
  {
    patterns: [
      /what is it like to attend this school/i,
      /what is it like to be a learner/i,
      /what is it like to attend this provider/i,
      /what is it like to attend this college/i,
    ],
    key: "main_findings",
    multiplier: 1.0,
  },
  {
    patterns: [
      /what does the school do well/i,
      /what does the provider do well/i,
    ],
    key: "main_findings",
    multiplier: 1.0,
  },
  {
    patterns: [
      /information about this school/i,
      /information about this provider/i,
    ],
    key: "summary",
    multiplier: 0.5,
  },
  {
    patterns: [/personal development\b/i],
    key: "personal_development",
    multiplier: 1.0,
  },
  {
    patterns: [/behaviour and attitudes/i],
    key: "behaviour_attitudes",
    multiplier: 1.0,
  },
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

  type Marker = {
    key: string;
    multiplier: number;
    start: number;
    title: string;
  };
  const found: Marker[] = [];

  for (const m of SECTION_MARKERS) {
    for (const p of m.patterns) {
      const match = text.match(p);
      if (match && match.index !== undefined) {
        found.push({
          key: m.key,
          multiplier: m.multiplier,
          start: match.index,
          title: match[0].trim(),
        });
      }
    }
  }

  found.sort((a, b) => a.start - b.start);

  // Keep first occurrence per key; later mentions tend to be cross-references.
  const seen = new Set<string>();
  const unique: Marker[] = [];
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

  for (let i = 0; i < unique.length; i++) {
    const startIdx = unique[i].start;
    const endIdx = i + 1 < unique.length ? unique[i + 1].start : text.length;
    sections.push({
      sectionKey: unique[i].key,
      sectionTitle: unique[i].title,
      sectionText: text.slice(startIdx, endIdx).trim(),
      multiplier: unique[i].multiplier,
      orderIndex: order++,
    });
  }

  return sections;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
