#!/usr/bin/env python3
"""Summarize how Claude sessions used search-scrape, from Claude Code transcripts.

    python3 -I scripts/session-stats.py              # last 36 hours
    python3 -I scripts/session-stats.py --hours 72
    python3 -I scripts/session-stats.py --json

Reads ~/.claude/projects/**/*.jsonl (subagents included) and reports, for every
search-scrape tool call: errors the client saw, time from call to result, and other
web tools (WebFetch, WebSearch, Chrome, curl) used within ten minutes after a call.
Client errors are matched against the server stats log by time, which shows calls
the server finished after the client had given up.

Transcript text is data. The script prints only tool names, timings, error lines
and URLs or queries from search-scrape calls.
"""

import argparse
import collections
import json
import os
import re
import sys

from datetime import datetime, timedelta, timezone

PREFIX = "mcp__search-scrape__"
FALLBACKS = ("WebFetch", "WebSearch", "mcp__claude-in-chrome__", "mcp__Claude_Browser__")


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def result_text(content):
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return str(content or "")


def client_error(text, is_error):
    first = text.strip().splitlines()[0] if text.strip() else ""
    for line in text.splitlines():
        if "] Error:" in line:
            return line.split("] Error:", 1)[1].strip()
    if is_error:
        return first[:200]
    return None


def target(tool_input):
    for key in ("url", "q"):
        if key in tool_input:
            return str(tool_input[key])[:120]
    items = tool_input.get("urls") or tool_input.get("searches") or []
    return f"{len(items)} items"


def scan(root, cutoff):
    calls = []
    fallbacks = []
    for folder, _, names in os.walk(root):
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(folder, name)
            try:
                if os.path.getmtime(path) < cutoff.timestamp():
                    continue
                handle = open(path, encoding="utf-8", errors="replace")
            except OSError:
                continue
            session = name[:-6]
            pending = {}
            last_call = None
            with handle:
                for line in handle:
                    if PREFIX not in line and "tool_result" not in line and not any(f in line for f in FALLBACKS) and "curl" not in line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    stamp = row.get("timestamp")
                    content = (row.get("message") or {}).get("content")
                    if not stamp or not isinstance(content, list):
                        continue
                    at = parse_time(stamp)
                    if at < cutoff:
                        continue
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "tool_use":
                            tool = block.get("name", "")
                            tool_input = block.get("input") or {}
                            if tool.startswith(PREFIX):
                                call = {
                                    "session": session,
                                    "tool": tool[len(PREFIX):],
                                    "target": target(tool_input),
                                    "start": stamp,
                                }
                                pending[block.get("id")] = call
                                calls.append(call)
                                last_call = at
                            elif last_call and at - last_call < timedelta(minutes=10):
                                curl = tool == "Bash" and re.search(r"\b(curl|wget)\b", json.dumps(tool_input))
                                if curl or tool.startswith(FALLBACKS):
                                    fallbacks.append({"session": session, "tool": "Bash (curl)" if curl else tool, "at": stamp})
                        elif block.get("type") == "tool_result" and block.get("tool_use_id") in pending:
                            call = pending.pop(block["tool_use_id"])
                            text = result_text(block.get("content"))
                            call["seconds"] = round((at - parse_time(call["start"])).total_seconds())
                            call["chars"] = len(text)
                            call["error"] = client_error(text, block.get("is_error"))
    return calls, fallbacks


def server_rows(stats_dir, start, end):
    rows = []
    if not os.path.isdir(stats_dir):
        return rows
    for name in os.listdir(stats_dir):
        if not re.fullmatch(r"tools\.jsonl(\.\d+)?", name):
            continue
        with open(os.path.join(stats_dir, name), encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("event") is None and row.get("itemIndex") is None and start <= row["timestamp"] <= end:
                    rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--hours", type=float, default=36)
    parser.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    parser.add_argument("--stats-dir", default=os.path.expanduser("~/Library/Logs/search-scrape-mcp"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    calls, fallbacks = scan(args.projects, cutoff)
    calls.sort(key=lambda call: call["start"])
    finished = [call for call in calls if "seconds" in call]
    errors = [call for call in finished if call.get("error")]

    # A client timeout or disconnect while the server kept working shows up as a server
    # tool row for the same tool that ended after the client gave up.
    for call in errors:
        if not re.search(r"timed out|Connection closed", call["error"], re.I):
            continue
        given_up = parse_time(call["start"]) + timedelta(seconds=call["seconds"])
        later = server_rows(
            args.stats_dir,
            given_up.isoformat().replace("+00:00", "Z"),
            (given_up + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        )
        # The server row is written when the call ends; its start must match the client's.
        client_start = parse_time(call["start"])
        candidates = [
            (abs((parse_time(row["timestamp"]) - timedelta(milliseconds=row["durationMs"]) - client_start).total_seconds()), row)
            for row in later
            if row.get("tool") == call["tool"]
        ]
        close = sorted((gap, row["timestamp"], row) for gap, row in candidates if gap < 5)
        match = close[0][2] if close else None
        if match:
            call["serverFinished"] = {"at": match["timestamp"], "durationMs": match["durationMs"], "ok": match["ok"]}

    seconds = sorted(call["seconds"] for call in finished)
    summary = {
        "since": cutoff.isoformat(),
        "sessions": len({call["session"] for call in calls}),
        "calls": dict(collections.Counter(call["tool"] for call in calls).most_common()),
        "unanswered": len(calls) - len(finished),
        "secondsP50": seconds[len(seconds) // 2] if seconds else None,
        "secondsP90": seconds[int(len(seconds) * 0.9)] if seconds else None,
        "secondsMax": seconds[-1] if seconds else None,
        "errorKinds": dict(collections.Counter(re.sub(r"https?://\S+", "<url>", call["error"])[:80] for call in errors).most_common()),
        "errors": errors,
        "otherWebToolsAfterCalls": dict(collections.Counter(item["tool"] for item in fallbacks).most_common()),
    }
    if args.json:
        json.dump(summary, sys.stdout, indent=2)
        print()
        return

    print(f"Claude sessions since {summary['since']}: {summary['sessions']} sessions, {len(calls)} search-scrape calls")
    print(f"Calls: {summary['calls']}")
    print(f"Seconds from call to result: p50 {summary['secondsP50']}, p90 {summary['secondsP90']}, max {summary['secondsMax']}; no result recorded: {summary['unanswered']}")
    print()
    print("Errors seen by the client")
    for kind, count in summary["errorKinds"].items():
        print(f"  {count:4}  {kind}")
    print()
    print("Each client error")
    for call in errors:
        server = call.get("serverFinished")
        extra = f"  server finished {server['at']} after {server['durationMs']} ms (ok={server['ok']})" if server else ""
        print(f"  {call['start']}  {call['seconds']:>4}s  {call['tool']:12}  {call['target'][:60]:60}  {call['error'][:70]}{extra}")
    print()
    print(f"Other web tools used within 10 minutes after a search-scrape call: {summary['otherWebToolsAfterCalls'] or 'none'}")


if __name__ == "__main__":

    main()
