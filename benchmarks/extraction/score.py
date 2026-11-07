"""Report WCXB metrics using the pinned upstream implementation."""
import collections
import importlib.util
import json
from pathlib import Path
import statistics
import sys

LOCAL = Path(__file__).parent / ".local"
spec = importlib.util.spec_from_file_location("wcxb", LOCAL / "wcxb" / "evaluate.py")
wcxb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wcxb)
truth = wcxb.load_ground_truth("test")
types = ["article", "forum", "product", "collection", "listing", "documentation", "service"]


def load(name):
    return json.loads((LOCAL / name).read_text())


def average(values):
    return statistics.mean(values)


def metrics(text, gt):
    return (
        wcxb.word_f1(text, gt["main_content"])[2],
        wcxb.snippet_check(text, gt["with"]),
        wcxb.snippet_check(text, gt["without"]),
    )


def table(rows, ids, methods):
    print("| Page type | N | " + " | ".join(methods) + " |")
    print("|" + "---|" * (2 + len(methods)))
    for kind in ["Overall", *types]:
        group = [i for i in ids if kind == "Overall" or truth[i]["page_type"] == kind]
        cells = []
        for method in methods:
            for variant in ("linked", "stripped"):
                values = [metrics(rows[i][method][variant]["text"], truth[i]) for i in group]
                cells.append("/".join(f"{100 * average(column):.1f}" for column in zip(*values)) or "—")
        print(f"| {kind} | {len(group)} | " + " | ".join(
            f"{a} → {b}" for a, b in zip(cells[::2], cells[1::2])
        ) + " |")


def size_speed(rows, ids, methods):
    print("| Option | Median chars on → off | Median tokens on → off | Median / p95 ms on → off | Error / empty on → off |")
    print("|---|---:|---:|---:|---:|")
    for method in methods:
        cells = []
        for variant in ("linked", "stripped"):
            items = [rows[i][method][variant] for i in ids]
            if not items:
                continue
            chars = [item["chars"] for item in items]
            tokens = [item["tokens"] for item in items]
            times = sorted(item["ms"] for item in items)
            p95 = times[(95 * len(times) + 99) // 100 - 1]
            statuses = collections.Counter(item["status"] for item in items)
            cells.append((f"{statistics.median(chars):,.0f}", f"{statistics.median(tokens):,.0f}",
                          f"{statistics.median(times):.1f} / {p95:.1f}",
                          f"{statuses['error']} / {statuses['empty']}"))
        if cells:
            print(f"| {method} | " + " | ".join(f"{a} → {b}" for a, b in zip(*cells)) + " |")


def read_attempts(directory):
    return [json.loads(file.read_text()) for file in directory.glob("*.json")]


def live_stats(rows, offline):
    sample = load("sample.json")
    attempts = read_attempts(LOCAL / "live")
    history = [row for directory in LOCAL.glob("live-rejected*")
               for row in read_attempts(directory) if row.get("http") == 429]
    all_attempts = attempts + history
    known = sum(row["credits"] for row in all_attempts if "credits" in row)
    unknown = sum("credits" not in row for row in all_attempts)
    print("Live coverage:", len(sample), "sampled.", len(all_attempts), "requests.",
          known, "reported credits +", unknown, "unreported at 5 each =", known + 5 * unknown)
    print("HTTP counts:", collections.Counter(row.get("http") for row in all_attempts))
    stages = {mode: {row["id"]: row for row in attempts if row["mode"] == mode}
              for mode in ("raw", "only", "whole")}
    print("Latest outcomes:",
          {mode: collections.Counter(row["outcome"] for row in entries.values())
           for mode, entries in stages.items()})
    allowed = {"ok", "empty"}
    # A saved HTML response can be an anti-bot challenge instead of the page.
    challenges = {
        i for i, row in stages["raw"].items()
        if row.get("status") == 202 and row["outcome"] == "ok"
        and b"window.POW_CHALLENGE_DATA=" in (LOCAL / "live" / f"{i}-raw.txt").read_bytes()
    }
    print("Challenge shell IDs:", sorted(challenges))
    matched = [i for i in rows if i not in challenges
               and {"only", "defuddle", "replies"} <= rows[i].keys()
               and stages["raw"].get(i, {}).get("outcome") == "ok"
               and stages["only"].get(i, {}).get("outcome") in allowed]
    all_three = [i for i in matched if "whole" in rows[i]
                 and stages["whole"].get(i, {}).get("outcome") in allowed]
    print("Matched raw + only:", len(matched), "also whole:", len(all_three))
    table(rows, matched, ["defuddle", "replies", "only"])
    size_speed(rows, matched, ["defuddle", "replies", "only"])
    if all_three:
        methods = ["whole", "only", "defuddle", "replies", "readability"]
        table(rows, all_three, methods)
        size_speed(rows, all_three, methods)
        nonblank = [i for i in all_three if wcxb.tokenize(truth[i]["main_content"])]
        print("Nonblank-reference sensitivity:", len(nonblank), "pages")
        for method in ("whole", "only", "defuddle", "replies"):
            f1 = average(wcxb.word_f1(rows[i][method]["linked"]["text"], truth[i]["main_content"])[2]
                         for i in nonblank)
            savings = [1 - r["stripped"]["tokens"] / r["linked"]["tokens"] for i in all_three
                       if (r := rows[i][method])["linked"]["tokens"]]
            print(f"{method}: F1 {f1:.1%}, median per-page token savings {statistics.median(savings):.1%}")
        print("Matched snapshot subset:")
        table(offline, all_three, ["defuddle", "replies"])
        print("Live comparison without snapshot reference:")
        print("| Page type | N | Only vs Defuddle overlap F1 | Whole word retention Only / Defuddle / Replies |")
        print("|---|---:|---:|---:|")
        for kind in ["Overall", *types]:
            group = [i for i in all_three if kind == "Overall" or truth[i]["page_type"] == kind]
            if not group:
                continue
            def get(page, method):
                return rows[page][method]["linked"]["text"]

            agreement = average(wcxb.word_f1(get(i, "only"), get(i, "defuddle"))[2] for i in group)
            retention = [average(wcxb.word_f1(get(i, m), get(i, "whole"))[1] for i in group)
                         for m in ("only", "defuddle", "replies")]
            print(f"| {kind} | {len(group)} | {agreement:.1%} | "
                  + " / ".join(f"{x:.1%}" for x in retention) + " |")
    if matched:
        raw_times = sorted(stages["raw"][i]["ms"] for i in matched)
        for method in ("defuddle", "replies"):
            totals = sorted(stages["raw"][i]["ms"] + rows[i][method]["linked"]["ms"] for i in matched)
            print(f"Raw fetch + {method} median {statistics.median(totals):.1f} ms,"
                  f" p95 {totals[(95 * len(totals) + 99) // 100 - 1]:.1f} ms.")
        print(f"Raw fetch median {statistics.median(raw_times):.1f} ms,"
              f" p95 {raw_times[(95 * len(raw_times) + 99) // 100 - 1]:.1f} ms.")
    for mode, entries in stages.items():
        failures = collections.Counter((row["outcome"], row.get("status"), row.get("code"))
                                       for row in entries.values() if row["outcome"] != "ok")
        print(mode, failures)



def luna_cost(usage):
    long = usage["input_tokens"] > 272000
    details = usage.get("input_tokens_details", {})
    cached = details.get("cached_tokens", 0)
    writes = details.get("cache_write_tokens", 0)
    return (
        (usage["input_tokens"] - cached - writes) * (0.20 if long else 0.10)
        + cached * (0.02 if long else 0.01)
        + writes * (0.25 if long else 0.125)
        + usage["output_tokens"] * (0.75 if long else 0.50)
    ) / 1e6


def luna_stats():
    luna = load("luna-predictions.json")
    live = load("live-predictions.json")
    attempts = read_attempts(LOCAL / "luna")
    live_methods = ["whole", "only", "defuddle", "luna-markdown", "luna-html"]
    ids = [i for i in luna if {"luna-markdown", "luna-html"} <= luna[i].keys()]
    rows = {i: live[i] | luna[i] for i in ids}
    if ids:
        table(rows, ids, live_methods)
        print()
        size_speed(rows, ids, live_methods)
    offline_ids = [i for i in luna if "luna-snapshot" in luna[i]]
    if offline_ids:
        offline_methods = ["defuddle", "readability", "smoothie", "luna-snapshot"]
        rows = {i: offline[i] | luna[i] for i in offline_ids}
        print()
        table(rows, offline_ids, offline_methods)
        print()
        size_speed(rows, offline_ids, offline_methods)
    print()
    for mode in ("markdown", "html", "snapshot"):
        group = [r for r in attempts if r["mode"] == mode]
        if not group:
            continue
        used = [r for r in group if r.get("usage")]
        known = sum(luna_cost(r["usage"]) for r in used)
        unreported = sum(r["reserve"] for r in group if not r.get("usage"))
        print(mode, len(group), "attempts", collections.Counter(r["status"] for r in group),
              "models", collections.Counter(r.get("model") for r in group),
              "estimated dollars", round(known, 4), "unreported reserve", round(unreported, 4))
        measurements = [r["luna-" + mode]["linked"] for r in luna.values() if "luna-" + mode in r]
        if measurements:
            print("pages with HTML tags outside code", sum(r["htmlTags"] > 0 for r in measurements),
                  "median links", statistics.median(r["links"] for r in measurements))
        if used:
            print("tokens in, out, reasoning", *[
                sum(r["usage"].get(field, 0) for r in used) for field in ("input_tokens", "output_tokens")
            ], sum(r["usage"].get("output_tokens_details", {}).get("reasoning_tokens", 0) for r in used))


if __name__ == "__main__":
    offline = load("offline-predictions.json")
    assert set(offline) == set(truth), "Offline predictions must cover the full test split"
    if "--luna" in sys.argv:
        luna_stats()
    elif "--live" in sys.argv:
        live_stats(load("live-predictions.json"), offline)
    else:
        methods = ["defuddle", "replies", "readability", "smoothie"]
        table(offline, list(offline), methods)
        size_speed(offline, list(offline), methods)
