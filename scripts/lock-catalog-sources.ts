import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  lockCatalogSources,
  type SourceLockPublishWarning,
} from "../src/experts/source-lock.js";

function safeErrorCode(error: unknown): string {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : "SOURCE_LOCK_FAILED";
}

export function publicationStateAdvice(error: unknown): string | undefined {
  return (error as { readonly publicationState?: unknown }).publicationState === "unknown"
    ? "publication state unknown; inspect catalog/sources.lock.json and do not rerun or overwrite blindly\n"
    : undefined;
}

export async function main(): Promise<number> {
  process.stdout.write(
    "release-only: keep catalog/sources.yaml and vendor-sources checkouts unchanged until verification finishes; network is disabled\n",
  );
  try {
    const warnings: SourceLockPublishWarning[] = [];
    const lock = await lockCatalogSources(process.cwd(), {
      onPublishWarning: (warning) => warnings.push(warning),
    });
    process.stdout.write(
      `release-only: locked ${lock.sources.length} catalog sources from clean local checkouts; no network commands were run\n`,
    );
    for (const warning of warnings) {
      process.stderr.write(`catalog source lock warning [${warning.code}]: ${warning.message}\n`);
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown local source-lock failure";
    process.stderr.write(`catalog source lock failed [${safeErrorCode(error)}]: ${message}\n`);
    const advice = publicationStateAdvice(error);
    if (advice !== undefined) process.stderr.write(advice);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  process.exitCode = await main();
}
