import { lockCatalogSources } from "../src/experts/source-lock.js";

try {
  const lock = await lockCatalogSources();
  process.stdout.write(
    `release-only: locked ${lock.sources.length} catalog sources from clean local checkouts; no network commands were run\n`,
  );
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "unknown local source-lock failure";
  process.stderr.write(`catalog source lock failed: ${message}\n`);
  process.exitCode = 1;
}
