import { AsyncLocalStorage } from "node:async_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ErrorCode,
  isJSONRPCResultResponse,
  type CallToolRequest,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
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

export class ToolTransport extends StreamableHTTPServerTransport {
  override send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId },
  ) {
    const call = toolCallContext.getStore();
    // The SDK can reject arguments before our tool handlers run.
    if (
      call &&
      isJSONRPCResultResponse(message) &&
      message.id === call.id &&
      message.result.isError === true &&
      !message.result.structuredContent
    ) {
      const content = message.result.content;
      const text =
        Array.isArray(content) && typeof content[0]?.text === "string"
          ? content[0].text
          : "";
      const prefix = `MCP error ${ErrorCode.InvalidParams}: `;
      const detail = text.startsWith(prefix) ? text.slice(prefix.length) : "";
      const issue =
        /^(?:Input validation error: )?Invalid arguments for tool [^:]+:\s*([\s\S]*)$/.exec(
          detail,
        );
      const failure = detail
        ? new AppError(
            "input",
            issue?.[1] ||
              (/^Tool .* not found$/.test(detail)
                ? messages.input.unknownTool
                : messages.input.invalid),
          )
        : new AppError("internal", messages.service.internal);
      return super.send(
        { ...message, result: presentedError(call.presentation, failure) },
        options,
      );
    }
    return super.send(message, options);
  }
}
