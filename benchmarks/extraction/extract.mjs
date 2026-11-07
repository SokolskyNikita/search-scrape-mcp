import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { Readability } from "@mozilla/readability";
import smoothie from "dom-smoothie-js";
import TurndownService from "turndown";
import MarkdownIt from "markdown-it";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { getEncoding } from "js-tiktoken";

const local = new URL("./.local/", import.meta.url);
const wcxb = new URL("wcxb/test/", local);
const live = new URL("live/", local);
const markdown = new MarkdownIt({ html: true });
const parser = unified().use(remarkParse).use(remarkGfm);
const tokenizer = getEncoding("o200k_base");
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["picture", "script", "style", "noscript"]);
turndown.addRule("no-image", { filter: "img", replacement: () => "" });
turndown.addRule("table-cell", {
  filter: ["th", "td"],
  replacement: (content) => " " + content.trim() + " |",
});
turndown.addRule("table-row", {
  filter: "tr",
  replacement: (content) => "\n| " + content.trim() + "\n",
});

const denyFetch = async () => {
  throw new Error("Network disabled in extraction benchmark");
};
globalThis.fetch = denyFetch;
async function defuddle(html, url, includeReplies) {
  const { document } = parseHTML(html);
  return (
    await Defuddle(document, url, {
      markdown: true,
      removeImages: true,
      includeReplies,
      useAsync: false,
      fetch: denyFetch,
    })
  ).content;
}

const extractors = {
  defuddle: (html, url) => defuddle(html, url, "extractors"),
  replies: (html, url) => defuddle(html, url, true),
  readability(html, url) {
    const { document } = parseHTML(html);
    // Readability uses document.baseURI to resolve relative hrefs.
    const base = document.createElement("base");
    base.setAttribute("href", url);
    if (!document.querySelector("base[href]")) document.head.prepend(base);
    const content = new Readability(document).parse()?.content;
    return content ? turndown.turndown(content) : "";
  },
  smoothie(html, url) {
    const reader = new smoothie.Readability(html, url || null, {
      text_mode: "Markdown",
    });
    try {
      return reader.parse().text_content;
    } finally {
      reader.free();
    }
  },
};

function removeMarkdown(source, kind) {
  const edits = [];
  function visit(node) {
    const { start, end } = node.position ?? {};
    if (kind === "images" && ["image", "imageReference"].includes(node.type)) {
      edits.push([start.offset, end.offset, ""]);
      return;
    }
    if (kind === "links" && ["link", "linkReference"].includes(node.type)) {
      if (!start || !end) return;
      const original = source.slice(start.offset, end.offset);
      const first = node.children[0]?.position?.start.offset;
      const last = node.children.at(-1)?.position?.end.offset;
      const label =
        first !== undefined && last !== undefined
          ? source.slice(first, last)
          : "";
      edits.push([
        start.offset,
        end.offset,
        original.startsWith("[") ? label : "",
      ]);
      return;
    }
    if (kind === "links" && node.type === "definition") {
      edits.push([start.offset, end.offset, ""]);
      return;
    }
    // Raw HTML anchors sometimes survive HTML-to-Markdown conversion.
    if (node.type === "html") {
      const pattern =
        kind === "links" ? /<\/?a(?:\s[^>]*|\s*)>/gi : /<img(?:\s[^>]*|\s*)>/gi;
      const stripped = node.value.replace(pattern, "");
      if (stripped !== node.value)
        edits.push([start.offset, end.offset, stripped]);
      return;
    }
    node.children?.forEach(visit);
  }
  visit(parser.parse(source));
  for (const [start, end, value] of edits.reverse()) {
    source = source.slice(0, start) + value + source.slice(end);
  }
  return source.trim();
}

function visibleText(source) {
  const { document } = parseHTML(
    "<body>" + markdown.render(source) + "</body>",
  );
  const block =
    /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;
  function render(node) {
    if (node.nodeType === 3) return node.data;
    if (
      node.nodeType !== 1 ||
      /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)
    )
      return "";
    const value = [...node.childNodes].map(render).join("");
    return block.test(node.tagName) ? "\n" + value + "\n" : value;
  }
  return render(document.querySelector("body")).replace(/\s+/g, " ").trim();
}

function measurements(source, ms, error) {
  const text = visibleText(source);
  return {
    text,
    chars: [...source].length,
    tokens: tokenizer.encode(source, [], []).length,
    ms,
    status: error ? "error" : !text ? "empty" : "ok",
    error,
  };
}

function variants(source, ms, error) {
  source = source.trim();
  const linked = measurements(source, ms, error);
  const start = performance.now();
  const stripped = removeMarkdown(source, "links");
  return {
    linked,
    stripped: measurements(stripped, ms + performance.now() - start, error),
  };
}

async function run(name, html, url) {
  const start = performance.now();
  let source = "",
    error;
  try {
    source = (await extractors[name](html, url)) ?? "";
    // Smoothie's Markdown renderer emits images and has no no-images option.
    if (name === "smoothie") source = removeMarkdown(source, "images");
  } catch (caught) {
    error = caught.name + ": " + caught.message;
  }
  return variants(source, performance.now() - start, error);
}

const mode = process.argv[2];
if (!["offline", "live", "luna"].includes(mode))
  throw new Error("Specify offline, live, or luna");
const rows = {};
if (mode === "offline") {
  for (const name of readdirSync(new URL("ground-truth/", wcxb)).sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const { url } = JSON.parse(
      readFileSync(new URL("ground-truth/" + name, wcxb)),
    );
    const html = gunzipSync(
      readFileSync(new URL("html/" + id + ".html.gz", wcxb)),
    ).toString();
    rows[id] = {};
    for (const extractor of Object.keys(extractors))
      rows[id][extractor] = await run(extractor, html, url);
    if (Object.keys(rows).length % 50 === 0)
      console.log("Extracted", Object.keys(rows).length);
  }
} else if (mode === "luna") {
  const luna = new URL("luna/", local);
  for (const name of readdirSync(luna).sort()) {
    if (!name.endsWith(".json")) continue;
    const row = JSON.parse(readFileSync(new URL(name, luna), "utf8"));
    if (!Number.isFinite(row.ms)) continue;
    rows[row.id] ??= {};
    const source = row.text ?? "";
    const measured = variants(
      source,
      row.ms,
      row.status === "completed" ? undefined : row.status,
    );
    const blocks = markdown.parse(source, {});
    const markup = blocks.flatMap((block) => [
      block,
      ...(block.children ?? []),
    ]);
    measured.linked.htmlTags = markup.filter(
      (token) =>
        ["html_block", "html_inline"].includes(token.type) &&
        /<\/?[a-z][\w:-]*(?:[\s/>])/i.test(token.content),
    ).length;
    measured.linked.links = markup.filter(
      (token) => token.type === "link_open",
    ).length;
    rows[row.id]["luna-" + row.mode] = measured;
  }
} else {
  const sample = JSON.parse(readFileSync(new URL("sample.json", local)));
  const entries = new Set(readdirSync(live));
  for (const { id, url } of sample) {
    rows[id] = {};
    for (const format of ["raw", "only", "whole"]) {
      const stem = id + "-" + format;
      if (!entries.has(stem + ".json")) continue;
      const row = JSON.parse(readFileSync(new URL(stem + ".json", live)));
      const content =
        row.outcome === "ok"
          ? readFileSync(new URL(stem + ".txt", live), "utf8")
          : "";
      if (format === "raw") {
        if (row.outcome === "ok") {
          for (const name of ["defuddle", "replies", "readability"])
            rows[id][name] = await run(name, content, url);
        }
      } else {
        rows[id][format] = variants(
          content,
          row.ms,
          row.outcome === "empty" || row.outcome === "ok"
            ? undefined
            : row.outcome,
        );
      }
    }
  }
}
writeFileSync(new URL(mode + "-predictions.json", local), JSON.stringify(rows));
