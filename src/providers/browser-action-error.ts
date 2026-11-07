import { AppError } from "../server/error.js";

export function browserActionError(error: unknown, action: string): AppError {
  const message = error instanceof Error ? error.message : "";
  const headline = message.split("\n", 1)[0] ?? "";
  const count =
    /strict mode violation: .* resolved to (\d{1,9}) elements:/.exec(
      headline,
    )?.[1];
  const timeout = /Timeout (\d{1,9})ms exceeded/.exec(headline)?.[1];
  const state = message
    .split("\n")
    .reverse()
    .map((line) =>
      /^\s*- (?:element is not (visible|enabled|editable|stable)|element is outside of the viewport)\s*$/.exec(
        line,
      ),
    )
    .find(Boolean);
  if (count)
    return new AppError(
      "browser_action",
      `The locator matched ${count} elements. Use a ref or a more specific selector.`,
    );
  if (
    /Selector "aria-ref=(?:f\d+)?e\d+" does not match any element/.test(
      headline,
    )
  )
    return new AppError(
      "browser_ref",
      "Unknown or stale element ref. Take a new snapshot.",
    );
  if (
    /Element is not an <input>, <textarea> or \[contenteditable\] element/.test(
      headline,
    )
  )
    return new AppError(
      "browser_action",
      "The target cannot be filled. Use an editable field.",
    );
  if (timeout) {
    const detail = state
      ? state[1]
        ? ` The element is not ${state[1]}.`
        : " The element is outside the viewport."
      : "";
    return new AppError(
      "browser_action",
      `Browser ${action} timed out after ${timeout} ms.${detail}`,
    );
  }
  return new AppError("browser_action", `Browser ${action} failed.`);
}
