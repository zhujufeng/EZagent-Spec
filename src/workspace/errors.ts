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

export class WorkspaceLockedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceLockedError";
  }
}
