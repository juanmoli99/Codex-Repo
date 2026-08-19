export type ErrorSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type ErrorCategory =
  | 'CONFIGURATION'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'AUTHORIZATION'
  | 'CONFLICT'
  | 'DEPENDENCY'
  | 'DATABASE'
  | 'SAFETY'
  | 'INTERNAL';

export class AppError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly category: ErrorCategory,
    public readonly severity: ErrorSeverity,
    public readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends AppError {
  public constructor(
    code: string,
    message: string,
    public readonly details: readonly string[],
  ) {
    super(code, message, 500, 'CONFIGURATION', 'CRITICAL');
  }
}

export class InputValidationError extends AppError {
  public constructor(code: string, message: string) {
    super(code, message, 400, 'VALIDATION', 'WARNING');
  }
}

export class AuthenticationError extends AppError {
  public constructor(code = 'AUTHENTICATION_FAILED', message = 'Authentication failed') {
    super(code, message, 401, 'AUTHENTICATION', 'WARNING');
  }
}

export class AuthorizationError extends AppError {
  public constructor(code = 'AUTHORIZATION_FAILED', message = 'Operation is not authorized') {
    super(code, message, 403, 'AUTHORIZATION', 'WARNING');
  }
}

export class SafetyError extends AppError {
  public constructor(code: string, message: string) {
    super(code, message, 423, 'SAFETY', 'CRITICAL');
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    'INTERNAL_ERROR',
    'An internal error occurred',
    500,
    'INTERNAL',
    'CRITICAL',
    false,
    {
      cause: error,
    },
  );
}
