import { messages } from "../config/messages.js";
import { fileTypeFromBuffer } from "file-type";
import { extension, lookup } from "mime-types";
import { AppError } from "../server/error.js";

export { MAX_SCRAPE_FILE_BYTES as maxFileBytes } from "../config/safety-limits.js";
export const datacenterFilePool = "public_datacenter_pool";
export type FileHeaders = { type: string; size?: number };

export function looksLikeFile(url: URL) {
  // Decode ASCII escapes used in filenames without rejecting malformed paths.
  const path = url.pathname.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  const mime = lookup(path);
  return (
    /(?:^|\/)pdf\//i.test(path) ||
    /\.(?:pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|docx|xlsx|pptx|epub|exe|dmg|iso)$/i.test(
      path,
    ) ||
    (!!mime && /^(?:image|audio|video|font)\//.test(mime))
  );
}

export function fileHeaders(
  type?: string | null,
  length?: string | null,
): FileHeaders {
  const mime = type?.split(";", 1)[0]?.trim().toLowerCase();
  const size = length && /^\d+$/.test(length) ? Number(length) : undefined;
  return {
    type:
      mime && /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/.test(mime)
        ? mime
        : "unknown",
    size: Number.isSafeInteger(size) ? size : undefined,
  };
}

export function refuseFile(
  { type, size }: FileHeaders,
  reason: string,
  publicReason: string = messages.file.fetchFailed,
) {
  return new AppError(
    "file_refused",
    `File refused (${type}, ${size === undefined ? "unknown size" : `${size} bytes`}): ${reason}`,
    { publicReason },
  );
}

export function isHtml(type: string) {
  return type === "text/html" || type === "application/xhtml+xml";
}

export async function identifyDownload(bytes: Buffer, type: string) {
  const detected = await fileTypeFromBuffer(bytes).catch((error: unknown) => {
    if (!(error instanceof Error) || error.name !== "EndOfStreamError")
      throw error;
    return undefined;
  });
  const prefix = bytes
    .toString("utf8", 0, 1024)
    .replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, "");
  if (
    isHtml(type) ||
    /^(?:<!doctype\s+html\b|<(?:html|head|body|title|script|meta|h1)\b)/i.test(
      prefix,
    )
  ) {
    throw new AppError("binary_download", "The file response contains HTML.", {
      publicReason: messages.file.html,
    });
  }
  if (
    (type === "application/pdf" && detected?.mime !== type) ||
    (detected &&
      extension(type) &&
      type !== "application/octet-stream" &&
      type !== detected.mime &&
      extension(type) !== detected.ext)
  ) {
    throw new AppError(
      "binary_download",
      `File content does not match ${type}${detected ? ` (detected ${detected.mime})` : ""}.`,
    );
  }
  return {
    bytes,
    mimeType:
      detected?.mime ??
      (type === "unknown" ? "application/octet-stream" : type),
    extension: detected?.ext,
  };
}
