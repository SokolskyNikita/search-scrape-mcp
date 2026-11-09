import { messages } from "../config/messages.js";
import type { Page } from "playwright-core";
import { AppError } from "../server/error.js";

type Scope = "viewport" | "page" | "full";
type Box = { x: number; y: number; width: number; height: number };
type Node = {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  url?: string;
  box?: Box;
  children?: (Node | string)[];
};

const interactive = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "option",
  "spinbutton",
]);

function shorten(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function displayUrl(value: string): string {
  if (value.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const url = URL.parse(value, "https://snapshot.invalid");
    if (!url) return "";
    if (url.username || url.password) {
      url.username = url.password = "";
      value = url.href;
    }
  }
  return shorten(value, 100);
}

function describe(node: Node, matchedText?: string): string {
  const name = matchedText ?? node.name;
  const url = node.url && displayUrl(node.url);
  return [
    node.role,
    name && JSON.stringify(shorten(name, 100)),
    url && `-> ${url}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function intersection(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.min(a.x + a.width, b.x + b.width) - x,
    height: Math.min(a.y + a.height, b.y + b.height) - y,
  };
}

export function browserSnapshots(page: Page) {
  const refs = new Set<string>();
  let epoch = 0;
  const invalidate = () => {
    epoch++;
    refs.clear();
  };
  page.on("framenavigated", invalidate);
  page.on("framedetached", invalidate);

  function locator(ref?: string) {
    if (!ref || !refs.has(ref))
      throw new AppError("browser_ref", messages.browser.staleRef);
    return page.getByRef(ref);
  }

  async function read(
    options: { scope?: Scope; target?: string; query?: string } = {},
  ) {
    const version = epoch;
    const snapshotOptions = { mode: "ai", boxes: true } as const;
    const tree = (await (options.target
      ? locator(options.target).ariaSnapshotJSON(snapshotOptions)
      : page.ariaSnapshotJSON(snapshotOptions))) as (Node | string)[];
    const full = !!options.target || options.scope === "full";
    const query = options.query?.toLowerCase();
    const viewportOnly = !full && !query && options.scope !== "page";
    const clip = viewportOnly
      ? await page.evaluate(() => ({
          x: 0,
          y: 0,
          width: innerWidth,
          height: innerHeight,
        }))
      : undefined;
    if (version !== epoch)
      throw new AppError("browser_navigation", messages.browser.changed);

    const lines: Promise<string>[] = [];
    let outside = 0;
    function visit(nodes: (Node | string)[], viewport?: Box, context?: string) {
      for (const node of nodes) {
        if (typeof node === "string") continue;
        let include = full;
        let matchedText: string | undefined;
        if (query) {
          matchedText = [
            node.name,
            node.text,
            ...(node.children?.filter((child) => typeof child === "string") ??
              []),
          ].find((value) => value?.toLowerCase().includes(query));
          include =
            matchedText !== undefined ||
            !!node.url?.toLowerCase().includes(query);
        } else if (
          !full &&
          (interactive.has(node.role) || node.role === "heading")
        ) {
          const visible =
            viewport && node.box && intersection(viewport, node.box);
          include =
            !viewportOnly ||
            (!!visible && visible.width > 1 && visible.height > 1);
          if (
            !include &&
            node.box &&
            node.box.width > 1 &&
            node.box.height > 1 &&
            interactive.has(node.role)
          )
            outside++;
        }
        if (include && node.ref) {
          refs.add(node.ref);
          if (!full) {
            const detail = describe(node, matchedText);
            lines.push(
              (async () => {
                const value =
                  node.text &&
                  ["textbox", "searchbox", "combobox", "spinbutton"].includes(
                    node.role,
                  ) &&
                  (await page
                    .getByRef(node.ref!)
                    .evaluate(
                      (element) => !element.matches('input[type="password"]'),
                      undefined,
                      { timeout: 1_000 },
                    )
                    .catch(() => false))
                    ? ` value=${JSON.stringify(node.text.slice(0, 200))}`
                    : "";
                return `${node.ref} ${detail}${value}${query && context ? ` (in ${context})` : ""}`;
              })(),
            );
          }
        }
        if (!node.children) continue;
        let childViewport = viewport;
        if (viewport && node.role === "iframe") {
          // Playwright reports descendant boxes relative to the iframe viewport.
          const overlap = node.box && intersection(viewport, node.box);
          childViewport =
            overlap && node.box
              ? {
                  ...overlap,
                  x: overlap.x - node.box.x,
                  y: overlap.y - node.box.y,
                }
              : { x: 0, y: 0, width: 0, height: 0 };
        }
        visit(
          node.children,
          childViewport,
          query && node.name ? describe(node) : context,
        );
      }
    }
    visit(tree, clip);
    if (full) return { text: JSON.stringify(tree, null, 2) };
    const rendered = await Promise.all(lines);
    if (version !== epoch)
      throw new AppError("browser_navigation", messages.browser.changed);
    const text = rendered.join("\n").trimStart();
    const note =
      viewportOnly && outside
        ? messages.note.offscreen(outside)
        : text
          ? undefined
          : query
            ? messages.note.noElements
            : messages.note.emptyView;
    return { text, note };
  }

  return { locator, read };
}
