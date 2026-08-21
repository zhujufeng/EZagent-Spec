import { readFile } from "node:fs/promises";

import { z } from "zod";

const policySchema = z.enum([
  "consult-no-work",
  "no-workflow",
  "initialize",
  "router-light",
  "router-standard",
  "router-high",
]);

const ruleAnchorSchema = z.enum([
  "standard-new-capability",
  "light-cosmetic",
  "consult-no-work",
  "uninitialized-no-workflow",
  "explicit-initialize",
  "high-risk",
]);

const categorySchema = z.enum([
  "explicit",
  "implicit",
  "negative",
  "boundary",
  "follow-up",
]);

const hostEvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  name: z.string().min(1),
  prompt: z.string().min(1),
  initialized: z.boolean(),
  expectedPolicy: policySchema,
  ruleAnchor: ruleAnchorSchema,
  categories: z.array(categorySchema).min(1),
  reviewCriteria: z.array(z.string().min(1)).min(1),
  followUpPrompt: z.string().min(1).optional(),
});

export const hostEvalSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pluginId: z.literal("ezagent-spec@ezagent"),
  cases: z.array(hostEvalCaseSchema).min(7),
}).superRefine(({ cases }, context) => {
  const ids = new Set<string>();
  for (const fixture of cases) {
    if (ids.has(fixture.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate host evaluation case id: ${fixture.id}`,
      });
    }
    ids.add(fixture.id);
  }
});

export type HostEvalSuite = z.infer<typeof hostEvalSuiteSchema>;

export async function loadHostEvalSuite(path: string): Promise<HostEvalSuite> {
  return hostEvalSuiteSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}
