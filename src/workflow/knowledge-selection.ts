import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export const KNOWLEDGE_QUERY_MAX_BYTES = 8 * 1024;

export interface KnowledgeContextQuery {
  readonly schemaVersion: 1;
  readonly terms: readonly string[];
}

interface KnowledgeSource {
  readonly kind: "pattern" | "decision";
  readonly specId: string;
}

interface CandidateBase {
  readonly source: KnowledgeSource;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly constraints: readonly string[];
  readonly contentHash: `sha256:${string}`;
}

export interface PatternKnowledgeCandidate extends CandidateBase {
  readonly source: KnowledgeSource & { readonly kind: "pattern" };
  readonly tags: readonly string[];
  readonly guidance: readonly string[];
}

export interface DecisionKnowledgeCandidate extends CandidateBase {
  readonly source: KnowledgeSource & { readonly kind: "decision" };
  readonly decisions: readonly string[];
}

export type KnowledgeCandidate = PatternKnowledgeCandidate | DecisionKnowledgeCandidate;

export interface SelectedKnowledge {
  readonly source: KnowledgeSource;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly contentHash: `sha256:${string}`;
  readonly relevanceScore: number;
}

export interface KnowledgeSelection {
  readonly schemaVersion: 1;
  readonly relevant: readonly SelectedKnowledge[];
  readonly recent: readonly SelectedKnowledge[];
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;

function textSchema(label: string, maximum: number) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function folded(value: string): string {
  return unicodeDefaultCaseFold(value.normalize("NFKC")).normalize("NFKC");
}

const querySchema = z.object({
  schemaVersion: z.literal(1),
  terms: z.array(textSchema("knowledge query term", 128)).min(1).max(16)
    .superRefine((terms, context) => {
      const seen = new Set<string>();
      for (const [index, term] of terms.entries()) {
        const key = folded(term);
        if (seen.has(key)) {
          context.addIssue({ code: "custom", path: [index], message: "knowledge query contains a duplicate term" });
        }
        seen.add(key);
      }
    }),
}).strict();

function rawJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error: unknown) {
    throw new TypeError("knowledge query must be JSON serializable", { cause: error });
  }
}

export function parseKnowledgeContextQuery(value: unknown): KnowledgeContextQuery {
  if (rawJsonBytes(value) > KNOWLEDGE_QUERY_MAX_BYTES) {
    throw new TypeError(`knowledge query exceeds ${KNOWLEDGE_QUERY_MAX_BYTES} bytes`);
  }
  const parsed = querySchema.parse(value);
  return Object.freeze({ ...parsed, terms: Object.freeze([...parsed.terms]) });
}

function isSpecId(value: string): boolean {
  return value.startsWith("SPEC-") && isWorkItemId(value);
}

function assertCandidate(candidate: KnowledgeCandidate): void {
  if (!isSpecId(candidate.source.specId)) throw new TypeError("knowledge candidate has invalid Spec ID");
  const expectedPath = `knowledge/${candidate.source.kind === "pattern" ? "patterns" : "decisions"}/${candidate.source.specId}.md`;
  if (candidate.path !== expectedPath) throw new TypeError("knowledge candidate path does not match its source");
  if (!HASH.test(candidate.contentHash)) throw new TypeError("knowledge candidate has invalid content hash");
}

function isPatternCandidate(candidate: KnowledgeCandidate): candidate is PatternKnowledgeCandidate {
  return candidate.source.kind === "pattern";
}

function relevanceScore(candidate: KnowledgeCandidate, terms: readonly string[]): number {
  const title = folded(candidate.title);
  const summary = folded(candidate.summary);
  const constraints = candidate.constraints.map(folded);
  const details = isPatternCandidate(candidate)
    ? candidate.guidance.map(folded)
    : candidate.decisions.map(folded);
  const tags = isPatternCandidate(candidate) ? candidate.tags.map(folded) : [];
  let score = 0;
  for (const rawTerm of terms) {
    const term = folded(rawTerm);
    if (tags.includes(term)) score += 4;
    if (title.includes(term)) score += 3;
    if (summary.includes(term)) score += 2;
    if ([...details, ...constraints].some((value) => value.includes(term))) score += 1;
  }
  return score;
}

function portableDescending(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0;
}

interface RankedCandidate {
  readonly candidate: KnowledgeCandidate;
  readonly score: number;
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.candidate.source.kind !== right.candidate.source.kind) {
    return left.candidate.source.kind === "pattern" ? -1 : 1;
  }
  return portableDescending(left.candidate.source.specId, right.candidate.source.specId);
}

function selected(candidate: KnowledgeCandidate, score: number): SelectedKnowledge {
  return Object.freeze({
    source: Object.freeze({ ...candidate.source }),
    path: candidate.path,
    title: candidate.title,
    summary: candidate.summary,
    contentHash: candidate.contentHash,
    relevanceScore: score,
  });
}

export function selectKnowledge(
  queryValue: KnowledgeContextQuery,
  candidates: readonly KnowledgeCandidate[],
): KnowledgeSelection {
  const query = parseKnowledgeContextQuery(queryValue);
  if (!Array.isArray(candidates) || candidates.length > 4_096) {
    throw new TypeError("knowledge candidates must be a bounded array");
  }
  for (const candidate of candidates) assertCandidate(candidate);

  const scores = new Map<KnowledgeCandidate, number>();
  for (const candidate of candidates) scores.set(candidate, relevanceScore(candidate, query.terms));
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scores.get(candidate)! }))
    .filter(({ score }) => score > 0)
    .sort(compareRanked);

  const selectedSpecIds = new Set<string>();
  const relevant: SelectedKnowledge[] = [];
  for (const { candidate, score } of ranked) {
    if (selectedSpecIds.has(candidate.source.specId)) continue;
    relevant.push(selected(candidate, score));
    selectedSpecIds.add(candidate.source.specId);
    if (relevant.length === 3) break;
  }

  const recent: SelectedKnowledge[] = [];
  const recentCandidates = candidates
    .filter((candidate): candidate is DecisionKnowledgeCandidate => candidate.source.kind === "decision")
    .sort((left, right) => portableDescending(left.source.specId, right.source.specId));
  for (const candidate of recentCandidates) {
    if (selectedSpecIds.has(candidate.source.specId)) continue;
    recent.push(selected(candidate, scores.get(candidate)!));
    selectedSpecIds.add(candidate.source.specId);
    if (recent.length === 2) break;
  }

  return Object.freeze({
    schemaVersion: 1,
    relevant: Object.freeze(relevant),
    recent: Object.freeze(recent),
  });
}
