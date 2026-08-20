import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CASE_FOLDING_SHA256 =
  "ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183";

const OUTPUT_PATH = resolve(import.meta.dirname, "../src/text/unicode-case-fold.ts");
const CASE_FOLD_LINE = /^([0-9A-F]+);\s+([A-Z]);\s+([0-9A-F ]+);/u;

function parseDefaultFullMappings(source: string): readonly string[] {
  const mappings = new Map<number, string>();
  for (const line of source.split(/\r?\n/u)) {
    const match = CASE_FOLD_LINE.exec(line);
    if (match === null || (match[2] !== "C" && match[2] !== "F")) continue;
    const sourceCodePoint = Number.parseInt(match[1]!, 16);
    if (mappings.has(sourceCodePoint)) {
      throw new Error(`Duplicate default full case-fold mapping for U+${match[1]}`);
    }
    mappings.set(sourceCodePoint, match[3]!.trim().split(/\s+/u).join(","));
  }
  if (mappings.size !== 1_585) {
    throw new Error(`Expected 1585 Unicode 17 default full mappings, found ${mappings.size}`);
  }
  return [...mappings.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sourceCodePoint, target]) =>
      `${sourceCodePoint.toString(16).toUpperCase().padStart(4, "0")}:${target}`,
    );
}

function formatRows(mappings: readonly string[]): string {
  const rows: string[] = [];
  for (let index = 0; index < mappings.length; index += 10) {
    rows.push(`  ${mappings.slice(index, index + 10).join(" ")}`);
  }
  return rows.join("\n");
}

export function generateUnicodeCaseFoldSource(sourceBytes: Uint8Array): string {
  const actualHash = createHash("sha256").update(sourceBytes).digest("hex");
  if (actualHash !== CASE_FOLDING_SHA256) {
    throw new Error(
      `CaseFolding.txt SHA-256 mismatch: expected ${CASE_FOLDING_SHA256}, received ${actualHash}`,
    );
  }
  const mappings = parseDefaultFullMappings(Buffer.from(sourceBytes).toString("utf8"));

  return `/*
 * Default Unicode case-fold mappings generated from Unicode 17.0.0 CaseFolding.txt
 * using status C + F and excluding the locale-specific status T mappings.
 * Source: https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt
 * Source SHA-256: ${CASE_FOLDING_SHA256}
 * Copyright © 1991-2025 Unicode, Inc.
 * License notice: licenses/UNICODE-LICENSE.txt
 */

const DEFAULT_CASE_FOLD_DATA = \`
${formatRows(mappings)}
\`;

const DEFAULT_CASE_FOLD = new Map<number, string>(
  DEFAULT_CASE_FOLD_DATA.trim().split(/\\s+/u).map((entry) => {
    const separator = entry.indexOf(":");
    const source = Number.parseInt(entry.slice(0, separator), 16);
    const target = entry.slice(separator + 1)
      .split(",")
      .map((codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
      .join("");
    return [source, target];
  }),
);

export function unicodeDefaultCaseFold(value: string): string {
  let folded = "";
  for (const character of value.normalize("NFKC")) {
    const codePoint = character.codePointAt(0);
    folded += codePoint === undefined ? character : (DEFAULT_CASE_FOLD.get(codePoint) ?? character);
  }
  return folded.normalize("NFKC");
}
`;
}

async function run(args: readonly string[]): Promise<void> {
  const check = args.includes("--check");
  const sourceArguments = args.filter((argument) => argument !== "--check");
  if (sourceArguments.length !== 1) {
    throw new Error(
      "usage: npm run generate:unicode-case-fold -- <local-CaseFolding.txt> [--check]",
    );
  }
  const sourcePath = resolve(sourceArguments[0]!);
  const generated = generateUnicodeCaseFoldSource(await readFile(sourcePath));
  if (check) {
    const committed = await readFile(OUTPUT_PATH, "utf8");
    if (committed !== generated) {
      throw new Error("src/text/unicode-case-fold.ts is not reproducible from the supplied source");
    }
    process.stdout.write("Unicode case-fold table is reproducible.\n");
    return;
  }
  await writeFile(OUTPUT_PATH, generated, "utf8");
  process.stdout.write(`Generated ${OUTPUT_PATH}\n`);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
