import { mcpName, messages, noticeLabel } from "../config/messages.js";
import type { AppError } from "../server/error.js";
import type { BrowserImage } from "../providers/types.js";
import type { PageCheck } from "./page-check.js";

export const resultDivider = "#".repeat(60);

export type ResultPresentation = {
  operation: string;
  service?: "search" | "fetch" | "browser";
  target?: () => string | undefined;
  targets?: (string | undefined)[];
  page?: number;
  pages?: number[];
  imageWarning?: () => string | undefined;
};

type ResultError = { code: string; message: string } & NonNullable<
  AppError["details"]
>;
type ResultItem = {
  index: number;
  result?: unknown;
  error?: ResultError;
  cached?: true;
};
type PageResult = {
  markdown?: string;
  preview?: string;
  path?: string;
  htmlPath?: string;
  extractionWarning?: { code: string; reason: string };
  url?: string;
  check?: PageCheck;
  retry?: ResultError["retry"];
  note?: string;
  warning?: string;
  cached?: true;
};

const textBlock = (text: string) => ({ type: "text" as const, text });
const oneLine = (value: string) =>
  value.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim();

function frame(
  operation: string,
  target?: string,
  notices: string[] = [],
  body?: string,
  page?: number,
) {
  const heading = [
    mcpName,
    oneLine(operation),
    target && oneLine(target),
    page && messages.label.searchPage(page),
  ]
    .filter(Boolean)
    .join(" · ");
  return textBlock(
    [
      [heading, ...notices].join("\n"),
      resultDivider,
      ...(body ? [body, resultDivider] : []),
    ].join("\n\n"),
  );
}

function notice(level: keyof typeof noticeLabel, message: string) {
  return `${noticeLabel[level]} ${oneLine(message)}`;
}

const pageMessages: Readonly<Partial<Record<string, string>>> = {
  menus_only: messages.page.menus_only,
  paywall: messages.page.paywall,
  blocked: messages.page.blocked,
  challenge: messages.page.challenge,
  challenge_timeout: messages.page.challenge,
  sign_in: messages.page.sign_in,
  not_found: messages.page.not_found,
  content_moved: messages.page.content_moved,
};

const errorMessages: Readonly<Partial<Record<string, string>>> = {
  ...pageMessages,
  internal: messages.service.internal,
  tool_timeout: messages.service.timeout,
  provider_timeout: messages.service.timeout,
  browser_timeout: messages.service.timeout,
  provider_rate: messages.service.busy,
  local_rate_limit: messages.service.busy,
  local_site_limit: messages.service.siteLimit,
  mcp_session_busy: messages.service.inFlight,
  mcp_server_busy: messages.service.inFlight,
  local_browser_concurrency: messages.service.browserSlots,
  local_browser_daily_limit: messages.service.browserBudget,
  browser_busy: messages.browser.busy,
  browser_closed: messages.browser.closed,
  browser_connect: messages.service.browser,
  browser_socket: messages.service.browser,
  captcha_control: messages.service.browser,
  file_refused: messages.file.fetchFailed,
  binary_download: messages.file.fetchFailed,
  browser_protocol: messages.service.browser,
  browser_navigation: messages.browser.changed,
  browser_ref: messages.browser.staleRef,
  usage_state: messages.service.browser,
  dns: messages.input.dns,
  output_size: messages.file.storage,
  output_write: messages.file.save,
  output_directory: messages.file.save,
};

const specificErrors = new Set([
  "unsafe_url",
  "empty_page",
  "input",
  "target_http",
  "browser_action",
  "image_size",
  "page_size",
  "body_size",
]);

function retryLine(retry: ResultError["retry"]) {
  return `${messages.label.retry} ${JSON.stringify(retry)}`;
}

function publicError(
  error: ResultError,
  service: NonNullable<ResultPresentation["service"]>,
  batchItem = false,
) {
  let message = errorMessages[error.code] ?? messages.service[service];
  if (specificErrors.has(error.code)) message = error.message;
  if (error.code === "scrape_cost")
    message = error.retry ? messages.page.costRetry : messages.page.costStopped;
  if (error.code === "stronger_rung_required")
    message = messages.page.differentMode;
  if (error.code === "provider_auth")
    message = messages.service.credentials(service);
  if (error.code === "provider_credit" || error.code === "provider_limit")
    message = messages.service.quota(service);
  if (error.code === "not_configured")
    message = messages.service.unavailable(service);
  if (batchItem && error.code === "tool_timeout")
    message = messages.service.batchTimeout;
  const { publicReason, ...details } = error;
  const reason = publicReason ?? message;
  return { ...details, message: reason, reason };
}

function errorNotices(error: ResultError) {
  return [
    notice("error", error.message),
    ...(error.retry
      ? [retryLine(error.retry)]
      : error.retryAt
        ? [`${messages.label.retryAt} ${oneLine(error.retryAt)}`]
        : []),
  ];
}

function resultFrame(
  operation: string,
  target: string | undefined,
  value: unknown,
  cached = false,
  pageNumber?: number,
) {
  const page: PageResult =
    typeof value === "string"
      ? { markdown: value }
      : Array.isArray(value)
        ? value.length
          ? {
              markdown: JSON.stringify(value),
              cached: cached ? true : undefined,
            }
          : { note: messages.note.noResults }
        : (value as PageResult);
  const notices: string[] = [];
  const body = page.markdown ?? page.preview;
  const warning =
    page.extractionWarning?.reason ??
    page.warning ??
    (page.check && (page.check.warning || page.check.code !== "ok")
      ? (pageMessages[page.check.code] ?? page.check.reason)
      : undefined);
  if (warning) notices.push(notice("warning", warning));
  else if (page.preview !== undefined)
    notices.push(notice("note", messages.note.preview));
  else if (page.note || page.cached)
    notices.push(notice("note", page.note ?? messages.note.cached));
  if (page.url && target && page.url !== (URL.parse(target)?.href ?? target))
    notices.push(`${messages.label.requestedUrl} ${oneLine(target)}`);
  if (page.htmlPath)
    notices.push(`${messages.label.originalHtml} ${oneLine(page.htmlPath)}`);
  if (page.path)
    notices.push(
      `${page.preview !== undefined ? messages.label.fullText : messages.label.savedFile} ${oneLine(page.path)}`,
    );
  if (page.retry) notices.push(retryLine(page.retry));

  return frame(operation, page.url ?? target, notices, body, pageNumber);
}

export function presentedResult(
  presentation: ResultPresentation,
  value: unknown,
  cached: boolean,
) {
  const {
    operation,
    target,
    targets,
    page,
    pages,
    service = "fetch",
  } = presentation;
  if (targets) {
    const items = (value as ResultItem[]).map((item) => ({
      ...item,
      target: targets[item.index],
      ...(pages ? { page: pages[item.index] } : {}),
      ...(item.error ? { error: publicError(item.error, service, true) } : {}),
    }));
    return {
      content: items.map(({ result, error, target, cached, page }) =>
        error
          ? frame(operation, target, errorNotices(error), undefined, page)
          : resultFrame(operation, target, result, cached, page),
      ),
      structuredContent: { items },
    };
  }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "image"
  ) {
    const warning = presentation.imageWarning?.();
    return {
      content: [
        frame(
          operation,
          target?.(),
          warning ? [notice("warning", warning)] : [],
        ),
        value as BrowserImage,
        textBlock(resultDivider),
      ],
    };
  }
  return {
    content: [resultFrame(operation, target?.(), value, cached, page)],
    structuredContent: Array.isArray(value)
      ? {
          results: value,
          ...(page ? { page } : {}),
          ...(cached ? { cached: true } : {}),
        }
      : typeof value === "string"
        ? { text: value }
        : (value as PageResult),
  };
}

export function presentedError(
  presentation: ResultPresentation,
  failure: AppError,
) {
  const error = publicError(
    { code: failure.code, message: failure.message, ...failure.details },
    presentation.service ?? "fetch",
  );
  return {
    isError: true,
    content: [
      frame(
        presentation.operation,
        presentation.target?.(),
        errorNotices(error),
        undefined,
        presentation.page,
      ),
    ],
    structuredContent: {
      ...error,
      ...(presentation.page ? { page: presentation.page } : {}),
    },
  };
}
