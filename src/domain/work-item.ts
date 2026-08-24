export type WorkItemKind = "requirement" | "spec" | "task";
export type RiskLevel = "consult" | "light" | "brief" | "standard" | "high";
export type WorkItemStatus =
  | "captured"
  | "clarifying"
  | "specified"
  | "approved"
  | "planned"
  | "implementing"
  | "verifying"
  | "completed"
  | "cancelled";

export interface WorkItemState {
  id: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  risk: RiskLevel;
  revision: number;
}

export interface TransitionRequest {
  to: WorkItemStatus;
  expectedRevision: number;
}
