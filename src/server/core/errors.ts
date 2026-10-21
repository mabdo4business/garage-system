/**
 * Errors with a stable machine-readable code. The HTTP layer maps codes to status codes;
 * messages are for logs and developers, never shown to customers verbatim.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Same idempotency key reused with a different request (Amendment v0.2.2 §A.3). */
export class IdempotencyConflictError extends DomainError {
  constructor(commandName: string) {
    super(
      "idempotency_payload_mismatch",
      `Idempotency key for ${commandName} was already used with a different request`,
    );
  }
}

/** A transient conflict (deadlock, lock timeout) persisted after the automatic retry. */
export class TryAgainError extends DomainError {
  constructor(commandName: string, cause: unknown) {
    super("try_again", `${commandName} could not complete because of a concurrent update. Please try again.`);
    this.cause = cause;
  }
}

/** A programming error: locks acquired out of the canonical order (P0-03). */
export class LockOrderViolationError extends DomainError {
  constructor(message: string) {
    super("lock_order_violation", message);
  }
}

/** A programming error: a command finished without writing an audit event. */
export class AuditMissingError extends DomainError {
  constructor(commandName: string) {
    super("audit_missing", `Command ${commandName} did not record an audit event`);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super("not_found", `${what} ${id} was not found`, { what, id });
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_failed", message, details);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor() {
    super("unauthenticated", "Sign-in required");
  }
}

export class ForbiddenError extends DomainError {
  constructor(permission: string) {
    super("forbidden", `Missing permission ${permission}`, { permission });
  }
}
