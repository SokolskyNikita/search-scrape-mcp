export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: {
      tried?: string[];
      hint?: string;
      retryAt?: string;
      expectedCredits?: number;
      credits?: number;
    },
  ) {
    super(message);
  }
}

export function safeError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : new AppError("internal", "Unexpected server error.");
}
