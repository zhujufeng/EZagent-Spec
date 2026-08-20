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

export interface ImportExpertsCommandOptions {
  readonly projectRoot?: string;
}

export interface ImportExpertsCommandRuntime {
  readonly readText: (path: string) => Promise<string>;
  readonly importCatalog: (options: ImportExpertCatalogOptions) => Promise<readonly Expert[]>;
  readonly writeCatalog: (
    experts: readonly Expert[],
    projectRoot: string,
    sourceLockJsonText: string,
    taxonomyYamlText: string,
  ) => Promise<void>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

const nodeRuntime: ImportExpertsCommandRuntime = Object.freeze<ImportExpertsCommandRuntime>({
  readText: readBoundedTextFile,
  importCatalog: importExpertCatalog,
  writeCatalog: async (experts, projectRoot, sourceLockJsonText, taxonomyYamlText) => writeNormalizedCatalog(
    join(projectRoot, "catalog", "normalized", "experts.json"),
    experts,
    { projectRoot, sourceLockJsonText, taxonomyYamlText },
  ),
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
    runtime.writeStderr(
      "catalog:import safety: do not concurrently replace catalog/normalized or its ancestors while this local release command runs\n",
    );
    const sourceLockJsonText = await runtime.readText(join(projectRoot, "catalog", "sources.lock.json"));
    const taxonomyYamlText = await runtime.readText(join(projectRoot, "catalog", "taxonomy.yaml"));
    const experts = await runtime.importCatalog({
      projectRoot,
      englishRoot: join(projectRoot, "vendor-sources", "agency-agents"),
      chineseRoot: join(projectRoot, "vendor-sources", "agency-agents-zh"),
      sourceLockText: sourceLockJsonText,
      taxonomyText: taxonomyYamlText,
    });
    await runtime.writeCatalog(experts, projectRoot, sourceLockJsonText, taxonomyYamlText);
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
