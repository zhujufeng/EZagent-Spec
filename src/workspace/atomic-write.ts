import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export async function atomicWriteText(target: string, content: string): Promise<void> {
  const parent = dirname(target);
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;

  await mkdir(parent, { recursive: true });

  try {
    file = await open(temporary, "wx");
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, target);
  } finally {
    if (file !== undefined) {
      await file.close();
    }
    await rm(temporary, { force: true });
  }
}
