/**
 * A business rule was violated (invalid state transition, missing value, …). `code` is stable and machine-readable and
 * becomes the ProblemDetails `code` extension (HTTP 400). Mirrors Ims.Domain.Common.DomainException.
 */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** The requested record does not exist (HTTP 404). Mirrors Ims.Application.Common.Errors.NotFoundException. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }

  /** Same message as `NotFoundException.For<T>(id)`: "Field '…' was not found." */
  static for(typeName: string, id: string): NotFoundError {
    return new NotFoundError(`${typeName} '${id}' was not found.`);
  }
}

/** The row was changed by someone else since it was read (EF Core's xmin concurrency check; HTTP 409). */
export class ConcurrencyError extends Error {
  constructor() {
    super('The record was changed by someone else.');
    this.name = 'ConcurrencyError';
  }
}

/** No e-mail provider is configured, so the message cannot be delivered (HTTP 503). */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('No e-mail provider is configured (EMAIL_PROVIDER).');
    this.name = 'EmailNotConfiguredError';
  }
}

/** The e-mail provider did not accept the message (HTTP 503). The cause is logged by its code only. */
export class EmailSendError extends Error {
  constructor() {
    super('The e-mail could not be sent.');
    this.name = 'EmailSendError';
  }
}

/** The Worker's configuration (vars, secrets, bindings) is missing or invalid (HTTP 500, details logged). */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
