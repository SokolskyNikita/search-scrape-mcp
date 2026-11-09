import { messages } from "../config/messages.js";
import type { ScrapeRung } from "../providers/types.js";

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: {
      tried?: string[];
      publicReason?: string;
      hint?: string;
      retryAt?: string;
      retryRung?: ScrapeRung;
      retry?: { name: string; arguments: Record<string, unknown> };
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
    : new AppError("internal", messages.service.internal);
}
