export class WorkspaceNotInitializedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceNotInitializedError";
  }
}

export class WorkspaceCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceCorruptError";
  }
}

export type WorkspaceLockErrorCode = "LOCK_CONTENDED" | "LOCK_WAIT_TIMEOUT";

export interface WorkspaceLockedErrorOptions extends ErrorOptions {
  readonly code?: WorkspaceLockErrorCode;
}

export class WorkspaceLockedError extends Error {
  readonly code?: WorkspaceLockErrorCode;

  constructor(message: string, options?: WorkspaceLockedErrorOptions) {
    super(message, options);
    this.name = "WorkspaceLockedError";
    if (options?.code !== undefined) {
      this.code = options.code;
    }
  }
}
