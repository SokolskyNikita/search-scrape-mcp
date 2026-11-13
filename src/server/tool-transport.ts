import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CallToolRequest,
  CallToolResult,
  McpServer,
  RequestId,
} from "@modelcontextprotocol/server";
import { messages } from "../config/messages.js";
import { AppError } from "./error.js";
import {
  presentedError,
  type ResultPresentation,
} from "../tools/result-format.js";

export const toolCallContext = new AsyncLocalStorage<{
  id: RequestId;
  presentation: ResultPresentation;
  /** Aborts when the client closes the response stream before the result is sent. */
  disconnected?: AbortSignal;
  /** Which MCP revision family the client spoke: 2026-07-28 ("modern") or older. */
  era?: "legacy" | "modern";
  /** A shorter deadline the client asked for, in milliseconds. */
  deadlineMs?: number;
}>();

export function toolCallPresentation({
  name,
  arguments: args,
}: CallToolRequest["params"]): ResultPresentation {
  if (name === "search" || name === "search_batch")
    return {
      operation: messages.operation.search,
      service: "search",
      ...(name === "search"
        ? {
            page:
              args?.page === undefined
                ? 1
                : typeof args.page === "number" &&
                    Number.isInteger(args.page) &&
                    args.page >= 1 &&
                    args.page <= 10
                  ? args.page
                  : undefined,
          }
        : {}),
      target: () =>
        typeof args?.q === "string"
          ? args.q
          : typeof args?.query === "string"
            ? args.query
            : undefined,
    };
  if (name === "scrape" || name === "scrape_batch")
    return {
      operation: messages.operation.scrape,
      target: () => (typeof args?.url === "string" ? args.url : undefined),
    };
  if (name === "browser") {
    const command = args?.command as Record<string, unknown> | undefined;
    const action =
      typeof command?.action === "string" &&
      /^[a-z]{1,16}$/.test(command.action)
        ? command.action
        : undefined;
    return {
      operation: messages.operation.browser(action),
      service: "browser",
      target: () =>
        typeof command?.url === "string" ? command.url : undefined,
    };
  }
  return { operation: name };
}

/**
 * The SDK rejects invalid arguments before a tool handler runs, as a plain-text
 * error result. Present those the same way as the handlers' own errors.
 */
export function presentToolErrors(server: McpServer) {
  (
    server as unknown as { createToolError: (text: string) => CallToolResult }
  ).createToolError = (text) => {
    const issue =
      /^(?:Input validation error: )?Invalid arguments for tool [^:]+:\s*([\s\S]*)$/.exec(
        text,
      );
    const failure = issue
      ? new AppError("input", issue[1] || messages.input.invalid)
      : new AppError("internal", messages.service.internal);
    return presentedError(
      toolCallContext.getStore()?.presentation ?? { operation: "tool" },
      failure,
    );
  };
}
