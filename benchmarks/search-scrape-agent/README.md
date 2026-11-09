# Search Scrape agent benchmark

This benchmark checks whether a fresh Codex CLI session chooses Search Scrape on its own, answers a recent factual question, and can give firsthand feedback on the tools it used.

## Run locally

Install and start Search Scrape MCP on `http://127.0.0.1:8765/mcp` and sign in to the Codex CLI. The runner reads the MCP bearer token from `SEARCH_SCRAPE_TOKEN` or the installed private settings file.

```sh
python3 benchmarks/search-scrape-agent/run.py
```

The default is ten GPT-6 Luna trials at medium effort, starting five seconds apart. Each trial starts with an empty workspace and resumes its own session for the feedback question. See `--help` for model, effort, count, and pacing options.

To repeat the five-agent, inventory-first ten-reference trial against a test server, set `SEARCH_SCRAPE_TOKEN` to that server's token and run:

```sh
python3 benchmarks/search-scrape-agent/run.py --trials 5 --inventory-first \
  --research ten-references --mcp-url http://127.0.0.1:8766/mcp
```

Use `--research cutoff` for the training-cutoff prompt or `--research mcp` to also explicitly ask the agent to use the MCP.

The CLI runs with network access enabled and Search Scrape configured. The runner disables shell execution, built-in web search, and desktop app tools, and suppresses project instructions. Check the traces for the tools the model actually calls.

## Read the results

Each batch writes settings, per-turn CLI event traces, and stderr under `.local/`, which Git ignores. Use the research trace to check the first tool choice, whether results substantiate the answer, and any failed requests. Use the feedback trace to distinguish firsthand observations from reactions to tool descriptions. Compare provider attempts in the MCP service log over the batch window to estimate usage. Other clients of the shared service can contribute to that total.

For this question, a general answer describes standing on an object such as a chest or movable tombstone, firing an aimable item such as the Hookshot, pressing ZL before the item animation finishes, and jumping as it ends. [Polygon's actor jump guide](https://www.polygon.com/ocarina-of-time-remake-speedrunning-actor-jumping/)

A route-specific answer can also be useful if it identifies the location and preserves the source's setup requirements. [Silver Gauntlets setups](https://twistedvoxel.com/zelda-ocarina-of-time-switch-2-silver-gauntlets-actor-jump/)
