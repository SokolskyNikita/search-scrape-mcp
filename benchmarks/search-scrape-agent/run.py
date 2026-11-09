#!/usr/bin/env python3
"""Run staggered Codex trials against the local Search Scrape MCP."""

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

RESEARCH = "How do I do the actor jump glitch in the Switch 2 remake of Ocarina of Time?"
DEFAULT_MCP_URL = "http://127.0.0.1:8765/mcp"
FEEDBACK = "what did you think about the search-scrape mcp? any suggestions for improvement?"


def run_trial(batch, index, args, env):
    trial = batch / f"trial-{index:02}"
    trial.mkdir()
    workspace = trial / "workspace"
    workspace.mkdir()
    command = [
        "codex", "-a", "never", "exec", "-s", "workspace-write",
        "--ignore-user-config", "--ignore-rules", "--json",
        "-c", "project_doc_max_bytes=0",
        "--skip-git-repo-check", "-C", str(workspace), "-m", args.model,
        "-c", f"model_reasoning_effort={json.dumps(args.effort)}",
        "-c", "sandbox_workspace_write.network_access=true",
        "-c", 'web_search="disabled"',
        "-c", f"mcp_servers.search-scrape.url={json.dumps(args.mcp_url)}",
        "-c", 'mcp_servers.search-scrape.bearer_token_env_var="SEARCH_SCRAPE_TOKEN"',
        "-c", "mcp_servers.search-scrape.required=true",
        "--enable", "skip_host_skill_discovery",
    ]
    for feature in ("shell_tool", "memories", "multi_agent", "apps", "plugins", "browser_use"):
        command.extend(("--disable", feature))

    def turn(name, arguments):
        trace = trial / f"{name}.jsonl"
        with trace.open("w") as out, (trial / f"{name}.stderr").open("w") as err:
            subprocess.run(command + arguments, stdin=subprocess.DEVNULL,
                           stdout=out, stderr=err, env=env, check=True, timeout=240)
        events = [json.loads(line) for line in trace.read_text().split("\n") if line]
        if not any(event["type"] == "turn.completed" for event in events):
            raise RuntimeError(f"{name} did not complete")
        return events

    def thread(events):
        return next(event["thread_id"] for event in events if event["type"] == "thread.started")

    prompt = RESEARCH
    if args.research != "original":
        prompt += " The remake was announced after your training cutoff, so you can't rely on your own knowledge of it."
    if args.research in ("mcp", "ten-references"):
        prompt += " Use the Search Scrape MCP to research your answer."
    if args.research == "ten-references":
        prompt += " Check at least 10 distinct references before replying."

    if args.inventory_first:
        inventory = turn("inventory", ["Print the full list of commands available from the Search Scrape MCP. For each command, include its exact name and all input parameters."])
        thread_id = thread(inventory)
        turn("research", ["resume", thread_id, prompt])
    else:
        thread_id = thread(turn("research", [prompt]))
    turn("feedback", ["resume", thread_id, FEEDBACK])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=10, choices=range(1, 11), metavar="1–10")
    parser.add_argument("--delay", type=float, default=5)
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--effort", default="medium")
    parser.add_argument("--mcp-url", default=DEFAULT_MCP_URL)
    parser.add_argument("--research", choices=("original", "cutoff", "mcp", "ten-references"), default="original")
    parser.add_argument("--inventory-first", action="store_true")
    args = parser.parse_args()
    if args.delay < 0:
        parser.error("--delay must be nonnegative")

    endpoint = urlsplit(args.mcp_url)
    if endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "localhost", "::1") or endpoint.username is not None or endpoint.password is not None:
        parser.error("--mcp-url must be a loopback HTTP URL without credentials")

    env = dict(os.environ)
    env.pop("CODEX_APP_TOOLS_PIPE_PATH", None)
    if not env.get("SEARCH_SCRAPE_TOKEN"):
        if args.mcp_url != DEFAULT_MCP_URL:
            parser.error("Set SEARCH_SCRAPE_TOKEN for a custom MCP endpoint")
        settings = Path.home() / ".config/search-scrape-mcp/config.json"
        env["SEARCH_SCRAPE_TOKEN"] = json.loads(settings.read_text())["token"]

    local = Path(__file__).resolve().parent / ".local"
    local.mkdir(exist_ok=True)
    batch = Path(tempfile.mkdtemp(prefix="batch-", dir=local))
    (batch / "settings.json").write_text(json.dumps(vars(args), indent=2) + "\n")
    print(batch, flush=True)
    failures = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.trials) as pool:
        trials = {}
        for index in range(1, args.trials + 1):
            print(f"Starting trial {index:02}", flush=True)
            future = pool.submit(run_trial, batch, index, args, env)
            trials[future] = index
            if index < args.trials:
                time.sleep(args.delay)
        for future in concurrent.futures.as_completed(trials):
            index = trials[future]
            try:
                future.result()
            except (subprocess.SubprocessError, RuntimeError, StopIteration, ValueError) as error:
                failures += 1
                print(f"Trial {index:02} failed: {error}", flush=True)
            else:
                print(f"Trial {index:02} completed", flush=True)
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
