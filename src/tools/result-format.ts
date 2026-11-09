import type { AppError } from "../server/error.js";
import type { BrowserImage } from "../providers/types.js";
import type { PageCheck } from "./page-check.js";

export const resultDivider = "#".repeat(60);

export type ResultPresentation = {
  operation: string;
  target?: () => string | undefined;
  targets?: (string | undefined)[];
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
  nextHint?: string;
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
) {
  const heading = ["search-scrape-mcp", operation, target && oneLine(target)]
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

function errorNotices(error: ResultError) {
  return [
    `Error (${error.code}): ${oneLine(error.message)}`,
    ...(error.retryAt ? [`Retry after: ${oneLine(error.retryAt)}`] : []),
    ...(error.hint ? [oneLine(error.hint)] : []),
    ...(error.retry ? [`Retry: ${JSON.stringify(error.retry)}`] : []),
  ];
}

function resultFrame(
  operation: string,
  target: string | undefined,
  value: unknown,
  cached = false,
) {
  if (typeof value === "string") return frame(operation, target, [], value);
  if (Array.isArray(value))
    return frame(
      operation,
      target,
      value.length ? [] : ["No results found."],
      value.length
        ? JSON.stringify(value) + (cached ? "\n\nCached result." : "")
        : undefined,
    );

  const page = value as PageResult;
  const notices: string[] = [];
  if (page.url && target && page.url !== (URL.parse(target)?.href ?? target))
    notices.push(`Requested URL: ${oneLine(target)}`);
  if (page.check && (page.check.warning || page.check.code !== "ok"))
    notices.push(`Warning (${page.check.code}): ${oneLine(page.check.reason)}`);
  if (page.extractionWarning)
    notices.push(
      `Warning (${page.extractionWarning.code}): ${oneLine(page.extractionWarning.reason)}`,
    );
  if (page.htmlPath) notices.push(`Original HTML: ${oneLine(page.htmlPath)}`);
  if (page.warning) notices.push(`Warning: ${oneLine(page.warning)}`);
  if (page.nextHint) notices.push(oneLine(page.nextHint));
  if (page.path)
    notices.push(
      page.preview !== undefined
        ? `Preview only. Full text: ${oneLine(page.path)}`
        : `Saved file: ${oneLine(page.path)}`,
    );
  const body = page.markdown ?? page.preview;
  return frame(
    operation,
    page.url ?? target,
    notices,
    page.cached ? [body, "Cached result."].filter(Boolean).join("\n\n") : body,
  );
}

export function presentedResult(
  presentation: ResultPresentation,
  value: unknown,
  cached: boolean,
) {
  const { operation, target, targets } = presentation;
  if (targets) {
    const items = (value as ResultItem[]).map((item) => ({
      ...item,
      target: targets[item.index],
    }));
    return {
      content: items.map(({ result, error, target, cached }) =>
        error
          ? frame(operation, target, errorNotices(error))
          : resultFrame(operation, target, result, cached),
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
          warning ? [`Warning: ${oneLine(warning)}`] : [],
        ),
        value as BrowserImage,
        textBlock(resultDivider),
      ],
    };
  }
  return {
    content: [resultFrame(operation, target?.(), value, cached)],
    structuredContent: Array.isArray(value)
      ? { results: value, ...(cached ? { cached: true } : {}) }
      : typeof value === "string"
        ? { text: value }
        : (value as PageResult),
  };
}

export function presentedError(
  presentation: ResultPresentation,
  failure: AppError,
) {
  const error = {
    code: failure.code,
    reason: failure.message,
    message: failure.message,
    ...failure.details,
  };
  return {
    isError: true,
    content: [
      frame(
        presentation.operation,
        presentation.target?.(),
        errorNotices(error),
      ),
    ],
    structuredContent: error,
  };
}
