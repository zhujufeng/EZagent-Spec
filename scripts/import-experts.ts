import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  CatalogImportError,
  importExpertCatalog,
  readBoundedTextFile,
  writeNormalizedCatalog,
  type ImportExpertCatalogOptions,
} from "../src/experts/importer.js";
import { type Expert } from "../src/experts/expert.js";
import { atomicWriteText } from "../src/workspace/atomic-write.js";

export interface ImportExpertsCommandOptions {
  readonly projectRoot?: string;
}

export interface ImportExpertsCommandRuntime {
  readonly readText: (path: string) => Promise<string>;
  readonly importCatalog: (options: ImportExpertCatalogOptions) => Promise<readonly Expert[]>;
  readonly writeCatalog: (
    path: string,
    experts: readonly Expert[],
    projectRoot: string,
  ) => Promise<void>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

const nodeRuntime: ImportExpertsCommandRuntime = Object.freeze<ImportExpertsCommandRuntime>({
  readText: readBoundedTextFile,
  importCatalog: importExpertCatalog,
  writeCatalog: async (target, experts, projectRoot) => writeNormalizedCatalog(target, experts, {
    atomicWriteText,
    projectRoot,
  }),
  writeStdout: (message) => { process.stdout.write(message); },
  writeStderr: (message) => { process.stderr.write(message); },
});

export async function main(
  options: ImportExpertsCommandOptions = {},
  runtime: ImportExpertsCommandRuntime = nodeRuntime,
): Promise<number> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputPath = join(projectRoot, "catalog", "normalized", "experts.json");
  try {
    const experts = await runtime.importCatalog({
      projectRoot,
      englishRoot: join(projectRoot, "vendor-sources", "agency-agents"),
      chineseRoot: join(projectRoot, "vendor-sources", "agency-agents-zh"),
      sourceLockText: await runtime.readText(join(projectRoot, "catalog", "sources.lock.json")),
      taxonomyText: await runtime.readText(join(projectRoot, "catalog", "taxonomy.yaml")),
    });
    await runtime.writeCatalog(outputPath, experts, projectRoot);
    runtime.writeStdout(`Imported ${experts.length} Chinese experts into ${outputPath}\n`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof CatalogImportError ? error.message : "Catalog import failed";
    runtime.writeStderr(`${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
