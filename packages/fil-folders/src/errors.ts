/** Base type for errors raised by fil-folders. */
export class FilFoldersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Two writers changed the same path. `paths` are absolute volume paths. */
export class CasConflictError extends FilFoldersError {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super(paths.length === 0 ? "write conflict" : `write conflict at ${paths.join(", ")}`);
    this.paths = paths;
  }
}

/** A compare-and-swap lost the race on every attempt after merging non-overlapping writes. */
export class CasRetryError extends FilFoldersError {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`commit conflicted after ${attempts} attempts`);
    this.attempts = attempts;
  }
}

export class NotFoundError extends FilFoldersError {
  readonly path: string;
  constructor(path: string) {
    super(`not found: ${path}`);
    this.path = path;
  }
}

export class AlreadyExistsError extends FilFoldersError {
  readonly path: string;
  constructor(path: string) {
    super(`already exists: ${path}`);
    this.path = path;
  }
}

export class NotADirectoryError extends FilFoldersError {
  readonly path: string;
  constructor(path: string) {
    super(`not a directory: ${path}`);
    this.path = path;
  }
}

export class IsADirectoryError extends FilFoldersError {
  readonly path: string;
  constructor(path: string) {
    super(`is a directory: ${path}`);
    this.path = path;
  }
}

export class DirectoryNotEmptyError extends FilFoldersError {
  readonly path: string;
  constructor(path: string) {
    super(`directory not empty: ${path}`);
    this.path = path;
  }
}

/** The registry head moved. `currentPieceCid` is the head observed on chain. */
export class RegistryCasConflict extends FilFoldersError {
  readonly currentPieceCid: Uint8Array;
  readonly currentVersion: bigint;

  constructor(currentPieceCid: Uint8Array, currentVersion: bigint) {
    super(`registry compare-and-swap conflict at version ${currentVersion}`);
    this.currentPieceCid = currentPieceCid;
    this.currentVersion = currentVersion;
  }
}

export class RegistryNotAuthorized extends FilFoldersError {
  constructor() {
    super("registry signer is not the owner or an approved writer");
  }
}

export class RegistryCallError extends FilFoldersError {
  readonly reason: string;
  constructor(reason: string) {
    super(`registry call failed: ${reason}`);
    this.reason = reason;
  }
}
