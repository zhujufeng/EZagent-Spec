import type { ExpertTeamMode } from "./team-record.js";
import { parseProjectContext, type ProjectContext } from "./project-context.js";
import type { SpecialistMode } from "./specialist-plan.js";
import type { WorkMode } from "./work-contract.js";

export interface ResumeRequirement {
  readonly sourceSchemaVersion: 1 | 2;
  readonly id: string;
  readonly title: string;
  readonly status: "specified";
  readonly revision: number;
}

export interface ResumeSpec {
  readonly sourceSchemaVersion: 1 | 2;
  readonly id: string;
  readonly requirementId: string;
  readonly goal: string;
  readonly status: "approved";
  readonly revision: number;
  readonly mode: WorkMode | null;
}

export interface ResumeSlice {
  readonly id: string;
  readonly title: string;
  readonly intendedOutcome: string;
  readonly status: string;
  readonly humanCheckpoint: boolean;
}

export interface ResumeTask {
  readonly sourceSchemaVersion: 1 | 2;
  readonly id: string;
  readonly specId: string;
  readonly title: string;
  readonly status: string;
  readonly risk: string;
  readonly revision: number;
  readonly slices: readonly ResumeSlice[];
}

export interface ResumeTeamMember {
  readonly expertId: string;
  readonly nameZh: string;
  readonly mode: ExpertTeamMode;
  readonly reasons: readonly string[];
}

export interface ResumeExpertTeam {
  readonly teamRevision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly teamFingerprint: `sha256:${string}`;
  readonly catalogFingerprint: `sha256:${string}`;
  readonly members: readonly ResumeTeamMember[];
}

export interface ResumeSpecialistDelegation {
  readonly id: string;
  readonly expertId: string;
  readonly nameZh: string;
  readonly sliceId: string;
  readonly mode: SpecialistMode;
  readonly reasons: readonly string[];
}

export interface ResumeSpecialists {
  readonly status: "legacy-unassessed" | "not-needed" | "ready";
  readonly planRevision: number | null;
  readonly planFingerprint: `sha256:${string}` | null;
  readonly catalogFingerprint: `sha256:${string}` | null;
  readonly delegations: readonly ResumeSpecialistDelegation[];
}

export interface ResumeKnowledge {
  readonly specId: string;
  readonly taskId: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  readonly contentHash: `sha256:${string}`;
}

export interface ResumeWorkJournal {
  readonly sequence: number;
  readonly sliceId: string;
  readonly summary: string;
  readonly nextStep: string;
}

export interface WorkflowResumeContext {
  readonly workspaceRevision: number;
  readonly safeMode: boolean;
  readonly recovered: boolean;
  readonly recoveryStatus: "ready" | "inspection-required";
  readonly projectContext: ProjectContext | null;
  readonly requirement: ResumeRequirement | null;
  readonly spec: ResumeSpec | null;
  readonly task: ResumeTask | null;
  readonly team: ResumeExpertTeam | null;
  readonly specialists: ResumeSpecialists | null;
  readonly journal: ResumeWorkJournal | null;
  readonly knowledge: readonly ResumeKnowledge[];
  readonly blockers: readonly string[];
}

export function freezeWorkflowResumeContext(value: WorkflowResumeContext): WorkflowResumeContext {
  return Object.freeze({
    ...value,
    projectContext: value.projectContext === null ? null : parseProjectContext(value.projectContext),
    requirement: value.requirement === null ? null : Object.freeze({ ...value.requirement }),
    spec: value.spec === null ? null : Object.freeze({ ...value.spec }),
    task: value.task === null ? null : Object.freeze({
      ...value.task,
      slices: Object.freeze(value.task.slices.map((slice) => Object.freeze({ ...slice }))),
    }),
    team: value.team === null ? null : Object.freeze({
      ...value.team,
      members: Object.freeze(value.team.members.map((member) => Object.freeze({
        ...member,
        reasons: Object.freeze([...member.reasons]),
      }))),
    }),
    specialists: value.specialists === null ? null : Object.freeze({
      ...value.specialists,
      delegations: Object.freeze(value.specialists.delegations.map((delegation) => Object.freeze({
        ...delegation,
        reasons: Object.freeze([...delegation.reasons]),
      }))),
    }),
    journal: value.journal === null ? null : Object.freeze({ ...value.journal }),
    knowledge: Object.freeze(value.knowledge.map((record) => Object.freeze({ ...record }))),
    blockers: Object.freeze([...value.blockers]),
  });
}
