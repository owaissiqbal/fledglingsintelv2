import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import yaml from "yaml";
import { z } from "zod";

const PhraseSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1),
  regex: z.boolean().optional().default(false),
  severity: z.number().int().min(1).max(3),
  curricula: z.array(z.string()).min(1),
  guards: z.array(z.string()).optional().default([]),
});

const FileSchema = z.object({
  phrases: z.array(PhraseSchema),
});

export type RawPhrase = z.infer<typeof PhraseSchema>;

export type Phrase = RawPhrase & {
  re: RegExp;
  guardRegexes: RegExp[];
  sourceFile: string;
};

export type LoadedLibrary = {
  phrases: Phrase[];
  hash: string;
  files: string[];
};

const PHRASES_DIR = path.resolve(process.cwd(), "config/phrases");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadPhraseLibrary(): LoadedLibrary {
  const files = readdirSync(PHRASES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  const all: Phrase[] = [];
  const sources: string[] = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const fullPath = path.join(PHRASES_DIR, file);
    const raw = readFileSync(fullPath, "utf-8");
    sources.push(raw);

    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(yaml.parse(raw));
    } catch (err) {
      throw new Error(
        `Phrase library ${file} failed validation: ${(err as Error).message}`,
      );
    }

    for (const p of parsed.phrases) {
      if (seenIds.has(p.id)) {
        throw new Error(`Duplicate phrase id "${p.id}" (in ${file})`);
      }
      seenIds.add(p.id);

      const source = p.regex ? p.pattern : escapeRegExp(p.pattern);
      let re: RegExp;
      try {
        re = new RegExp(source, "gi");
      } catch (err) {
        throw new Error(
          `Invalid regex for phrase ${p.id} in ${file}: ${(err as Error).message}`,
        );
      }
      const guardRegexes = p.guards.map(
        (g) => new RegExp(escapeRegExp(g), "i"),
      );
      all.push({ ...p, re, guardRegexes, sourceFile: file });
    }
  }

  const hash = createHash("sha256")
    .update(sources.join("\n---\n"))
    .digest("hex");

  return { phrases: all, hash, files };
}
