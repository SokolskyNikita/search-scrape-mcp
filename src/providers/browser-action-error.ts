import { messages } from "../config/messages.js";
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
    return new AppError("browser_action", messages.browser.ambiguous(count));
  if (
    /Selector "aria-ref=(?:f\d+)?e\d+" does not match any element/.test(
      headline,
    )
  )
    return new AppError("browser_ref", messages.browser.staleRef);
  if (
    /Element is not an <input>, <textarea> or \[contenteditable\] element/.test(
      headline,
    )
  )
    return new AppError("browser_action", messages.browser.notEditable);
  if (timeout) {
    const detail = state
      ? state[1]
        ? messages.browser.elementState(state[1])
        : messages.browser.elementOffscreen
      : messages.browser.actionTimeout(action);
    return new AppError("browser_action", detail);
  }
  return new AppError("browser_action", messages.browser.actionFailed(action));
}
