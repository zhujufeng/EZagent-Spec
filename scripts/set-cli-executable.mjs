import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/src/cli/main.js", import.meta.url));

await chmod(cliPath, 0o755);
