# Main-content extraction benchmark

November 7, 2026 · WCXB 1.0 held-out test split · Node 22.23.4

**Recommendation.** Use Defuddle on Scrapfly raw HTML with links retained.
Offer full-page Markdown when recall matters, especially for forum replies,
catalog cards, and product details. Use the whole-page path as a fallback
when extraction yields no usable text and the request budget allows it.

## Held-out HTML snapshots

All 511 test pages. Each cell shows **word F1 / wanted snippet recall / unwanted snippet inclusion** in percent, with links on → off. Higher is better for the first two and lower for the third. These are page means using WCXB's `word_f1` and `snippet_check`; WCXB gives 100% to an empty prediction against an empty reference and to a snippet check with no snippets. Six references are empty. Scores use visible Markdown text, with formatting and link destinations removed and whitespace collapsed. The size columns measure the Markdown delivered to the caller, before any server-side response cap. [WCXB dataset and evaluator](https://github.com/Murrough-Foley/web-content-extraction-benchmark/tree/c039d5ee9f5a3a984a0e167e63aacd04e76e78a9)

| Page type     | N   | Defuddle                        | Readability                     | DOM Smoothie                    |
| ------------- | --- | ------------------------------- | ------------------------------- | ------------------------------- |
| Overall       | 511 | 87.0/86.1/9.6 → 87.4/86.1/9.6   | 83.4/77.6/9.9 → 83.8/77.5/9.7   | 83.2/76.4/8.8 → 83.2/76.4/8.8   |
| article       | 257 | 94.4/91.6/9.7 → 94.6/91.6/9.7   | 93.9/88.4/9.2 → 94.3/88.4/9.1   | 94.2/87.8/8.9 → 94.2/87.8/8.9   |
| forum         | 51  | 82.3/89.7/11.4 → 82.3/89.7/11.4 | 71.1/61.3/10.0 → 71.4/61.3/10.0 | 69.9/56.9/9.0 → 69.9/56.9/9.0   |
| product       | 28  | 78.7/80.4/20.2 → 78.7/80.4/20.2 | 64.1/60.5/12.8 → 64.1/60.5/12.8 | 64.0/60.5/12.8 → 64.1/60.5/12.8 |
| collection    | 34  | 71.4/73.8/5.9 → 72.3/73.8/5.1   | 57.6/62.0/13.2 → 60.7/62.0/11.8 | 58.5/58.3/10.3 → 58.8/58.3/10.3 |
| listing       | 40  | 70.6/74.6/8.3 → 71.4/74.6/8.3   | 64.5/57.7/11.9 → 64.5/57.0/11.2 | 64.5/58.3/11.9 → 64.4/58.3/11.9 |
| documentation | 42  | 94.3/89.3/2.2 → 95.6/89.3/2.2   | 88.7/75.6/1.4 → 88.9/75.0/1.4   | 86.8/75.6/0.6 → 86.8/75.6/0.6   |
| service       | 59  | 77.8/74.9/11.2 → 77.9/74.9/11.2 | 80.8/76.7/14.0 → 81.1/76.7/14.0 | 79.9/74.2/9.3 → 80.0/74.2/9.3   |

| Option             | Median chars on → off | Median tokens on → off |    Median / p95 ms on → off | Error / empty on → off |
| ------------------ | --------------------: | ---------------------: | --------------------------: | ---------------------: |
| Defuddle           |         8,239 → 6,827 |          1,809 → 1,530 | 52.0 / 179.8 → 56.4 / 185.4 |          0 / 7 → 0 / 7 |
| Defuddle + replies |         8,239 → 6,827 |          1,809 → 1,530 | 51.2 / 175.9 → 56.3 / 187.3 |          0 / 7 → 0 / 7 |
| Readability        |         7,778 → 6,391 |          1,733 → 1,353 |   11.2 / 45.3 → 15.5 / 52.6 |          0 / 3 → 0 / 3 |
| DOM Smoothie       |         7,210 → 6,284 |          1,608 → 1,356 |   11.5 / 50.6 → 15.0 / 59.1 |          3 / 0 → 3 / 0 |

Defuddle's default preserves replies for site-specific extractors. Explicit `includeReplies: true` produced identical scored text on all 511 snapshots and identical reported scores on the 101 matched live pages. Its timings are listed separately. Extraction was local, with Defuddle's network fetch disabled. Readability is Mozilla’s standalone Firefox Reader View extractor. This run used `@mozilla/readability` 0.6.0 with linkedom and Turndown. DOM Smoothie used its WASM Markdown output. Each library was measured without images. Scrapfly formats require live requests and are measured separately below. [Defuddle options](https://github.com/kepano/defuddle)

## Live pages

Attempted **126 URLs**, 18 per type. **101** completed all three formats on the target page. The other 25 included 2 HTTP 404s, 4 redirects to a different URL, 14 raw fetch failures (13 upstream HTTP 403s and 1 upstream HTTP 429), 2 anti-bot challenge shells, and 1 upstream HTTP 429 on `only_content`. GitHub Docs (4408) and VolunteerNC (5343) each cost 25 credits on the raw request despite the requested five-credit cap. Both were skipped for the remaining formats.

Scrapfly reported **367 credits** across 466 attempts. Reserving five for each of 103 attempts with unreported charges gives **882 accounted credits**. This includes 132 provider-level HTTP 429s during setup. Requests used the US datacenter pool without browser rendering, unblocker, or automatic retries.

After the throttling, requests ran serially. Raw HTML came first to check cost and availability, followed by `markdown:no_images,only_content` and the current `markdown:no_images` format. Four successful raw responses from the initial pass were reused after the cooldown. The formats were fetched independently and could receive different site responses.

| Page type     | N   | Whole Markdown                  | Only content                    | Defuddle                        |
| ------------- | --- | ------------------------------- | ------------------------------- | ------------------------------- |
| Overall       | 101 | 61.6/77.2/78.6 → 61.6/77.2/78.6 | 64.6/67.9/24.1 → 64.6/67.9/23.8 | 76.3/70.6/8.3 → 76.7/70.6/8.3   |
| article       | 17  | 78.0/87.1/82.4 → 78.1/87.1/82.4 | 78.3/75.3/35.3 → 78.3/75.3/35.3 | 91.8/83.5/4.4 → 91.8/83.5/4.4   |
| forum         | 11  | 74.8/88.6/70.5 → 74.8/88.6/70.5 | 62.5/70.5/40.9 → 62.5/70.5/40.9 | 85.5/86.8/11.4 → 85.5/86.8/11.4 |
| product       | 15  | 56.5/85.3/63.9 → 56.5/85.3/63.9 | 67.1/81.3/16.1 → 67.1/81.3/16.1 | 71.0/70.0/8.9 → 71.1/70.0/8.9   |
| collection    | 14  | 36.2/51.8/71.4 → 36.2/51.8/71.4 | 44.7/44.0/8.9 → 44.7/44.0/7.1   | 46.8/34.0/0.0 → 47.1/34.0/0.0   |
| listing       | 12  | 46.9/55.6/88.9 → 46.9/55.6/88.9 | 48.3/55.6/28.5 → 48.3/55.6/28.5 | 65.3/59.7/15.3 → 66.2/59.7/15.3 |
| documentation | 16  | 75.7/96.9/87.0 → 75.7/96.9/87.0 | 73.8/78.1/18.8 → 73.8/78.1/18.8 | 90.8/92.2/5.7 → 91.6/92.2/5.7   |
| service       | 16  | 58.9/69.8/84.4 → 58.9/69.8/84.4 | 69.3/65.6/23.4 → 69.3/65.6/23.4 | 78.1/65.1/14.6 → 78.6/65.1/14.6 |

| Option             | Median chars on → off | Median tokens on → off |          Median / p95 ms on → off | Error / empty on → off |
| ------------------ | --------------------: | ---------------------: | --------------------------------: | ---------------------: |
| Whole Markdown     |       19,704 → 10,688 |          4,831 → 2,546 |   875.1 / 2882.0 → 878.9 / 2897.0 |          0 / 0 → 0 / 0 |
| Only content       |         9,066 → 5,906 |          2,093 → 1,487 | 1041.8 / 2736.3 → 1044.8 / 2742.7 |          0 / 0 → 0 / 0 |
| Defuddle           |         6,060 → 5,051 |          1,410 → 1,130 |       74.8 / 198.9 → 78.3 / 204.9 |          0 / 2 → 0 / 2 |
| Defuddle + replies |         6,060 → 5,051 |          1,410 → 1,130 |       75.1 / 196.1 → 76.0 / 201.1 |          0 / 2 → 0 / 2 |

On these same 101 URLs, Defuddle scored 83.3% on the archived HTML and 76.3% on live HTML against the same references. Changes in page content and differences between archived and live HTML contribute to that gap. Excluding the one blank reference gives F1 of 62.2% whole, 65.2% only content, and 76.1% Defuddle. Live Scrapfly timings include the API round trip and any content download. Live Defuddle timings in the table include local extraction only. Raw fetch plus Defuddle took 1.19 s at the median and 3.28 s at p95. The median decoded raw HTML body was 191 KiB. Offline timings include DOM parsing and Markdown conversion. Off timings add the local link removal pass. Approximate tokens use `o200k_base`.

On the same 101 saved live HTML pages, Mozilla Readability scored **70.8/61.2/8.2** with links on and **71.3/61.2/7.7** with links off. Local extraction took **15.0 ms median and 71.6 ms p95** with links on, excluding the fetch. Output was **1,240 median tokens** with links on and **971** with links off. Two pages returned empty output. [Mozilla Readability](https://github.com/mozilla/readability)

### Comparison on the retrieved pages

Word overlap compares the two trim outputs directly. Retention is the fraction of whole-page words retained, including navigation and other boilerplate. Neither measure labels what belongs in the main content. The cases below were checked against the retrieved outputs.

| Page type     |   N | Only vs Defuddle overlap F1 | Whole word retention Only / Defuddle |
| ------------- | --: | --------------------------: | -----------------------------------: |
| Overall       | 101 |                       72.0% |                        67.2% / 57.2% |
| article       |  17 |                       76.6% |                        75.3% / 66.2% |
| forum         |  11 |                       66.0% |                        78.0% / 74.4% |
| product       |  15 |                       71.7% |                        67.3% / 46.5% |
| collection    |  14 |                       58.4% |                        60.1% / 29.0% |
| listing       |  12 |                       66.3% |                        61.5% / 56.2% |
| documentation |  16 |                       76.2% |                        61.1% / 70.7% |
| service       |  16 |                       83.6% |                        67.4% / 57.8% |

- **Forums.** On Rivian Forums (5044), whole Markdown contained all four annotated thread snippets. Defuddle preserved the opening question and lost the three annotated reply snippets. `only_content` reduced the thread to a title and a navigation label. The explicit replies setting did not recover the thread.
- **Products.** On Kinetic Labs (4169), `only_content` retained keyboard specifications and price but dropped the annotated shipping and returns text. Defuddle and whole Markdown retained both. On LTT Labs (4168), Defuddle omitted two annotated technical specifications that both Scrapfly formats kept.
- **Listings.** The Cleveland Museum of Art (5277) returned current exhibition cards in all formats. All missed the archived exhibition snippets, a concrete case of drift. On Garmin (4066), `only_content` returned the title and Defuddle returned empty. The WCXB reference is empty there, so Defuddle gets full F1 on that page despite delivering no useful listing.
- **Collections.** On Armoury Fitness (5598), `only_content` kept the later testimonials and their annotated snippets. Defuddle retained the opening story and dropped those snippets. It returned empty for The Container Store (4335) while both Markdown formats returned text.

## Reproduce

Run these commands from `benchmarks/extraction` in this worktree.

```sh
mkdir -p .local
git clone https://github.com/Murrough-Foley/web-content-extraction-benchmark .local/wcxb
git -C .local/wcxb checkout c039d5ee9f5a3a984a0e167e63aacd04e76e78a9
npm ci --cache .local/npm-cache
node_modules/node/bin/node extract.mjs offline
python3 score.py
# Uses the configured Scrapfly key and consumes credits.
node_modules/node/bin/node live.mjs
node_modules/node/bin/node extract.mjs live
python3 score.py --live
```

The clone step is for a fresh worktree. Dataset, sample IDs, response bodies, request ledgers, and intermediate scores are in the gitignored `.local/` directory. The live runner reuses completed requests. If it stops on a provider HTTP 429, retain that attempt in a `.local/live-rejected-*/` directory before resuming after the reported delay. Link stripping is applied locally to the same Markdown, preserving anchor labels and removing URL-only autolinks. This avoids another fetch per format. [Scrapfly format documentation](https://scrapfly.github.io/python-scrapfly/scrapfly/scrape_config.html)

## GPT-6 Luna with low reasoning

Compared with Defuddle, Luna improved F1 by 1.2 points on held-out HTML
(paired bootstrap 95% interval −0.4 to +2.9) and 0.6 points on live whole-page
Markdown (−3.6 to +4.6). API latency and output size favor Defuddle for the
default. For an opt-in Luna pass, whole-page Markdown used roughly half as
many input tokens as HTML at similar overall live F1. HTML scored higher on
listings.

Luna received one page per Responses API request at the Standard tier, with no tools and `store: false`. The same prompt asked it to preserve original wording and order, remove page furniture and unnecessary formatting, and keep substantive code, links, posts, and listings. The HTML input kept the document body and structural tags after removing scripts, styles, templates, images, comments, and most attributes. The Markdown input was the saved whole-page Scrapfly response. The model saw no WCXB annotations. Links-off measurements used the same local removal pass as the previous experiments. [OpenAI Docs for GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

### All 511 held-out snapshots

See [held-out snapshots](#held-out-html-snapshots) for the Defuddle baseline and scoring convention. Incomplete API responses count as errors in the size table. Their returned text, when present, is included in the scores. One snapshot response ended with `content_filter` and returned partial text.

| Page type     | Luna / snapshot                 |
| ------------- | ------------------------------- |
| Overall       | 88.2/93.1/12.8 → 88.2/93.0/12.8 |
| article       | 91.8/94.1/14.4 → 91.8/94.0/14.4 |
| forum         | 84.1/92.2/2.1 → 84.1/92.2/2.1   |
| product       | 77.8/89.1/25.6 → 77.8/89.1/25.6 |
| collection    | 78.1/92.6/16.7 → 78.1/92.6/16.7 |
| listing       | 81.1/90.2/11.0 → 81.1/89.6/11.0 |
| documentation | 95.5/89.9/2.8 → 95.5/89.9/2.8   |
| service       | 86.6/95.8/15.5 → 86.6/95.8/15.5 |

| Option          | Median chars on → off | Median tokens on → off |              Median / p95 ms on → off | Error / empty on → off |
| --------------- | --------------------: | ---------------------: | ------------------------------------: | ---------------------: |
| Luna / snapshot |         9,485 → 8,059 |          2,128 → 1,730 | 13731.5 / 47006.3 → 13734.7 / 47016.4 |          1 / 6 → 1 / 6 |

### Same 101 live pages

See [live pages](#live-pages) for the Defuddle baseline. Luna timings are API
round trips under concurrent load, excluding source fetch and HTML preparation.

| Page type     | Luna / Markdown                 | Luna / HTML                     |
| ------------- | ------------------------------- | ------------------------------- |
| Overall       | 76.9/74.2/8.5 → 77.0/74.2/8.5   | 76.4/76.3/10.0 → 76.4/76.3/10.0 |
| article       | 89.1/81.2/7.4 → 89.1/81.2/7.4   | 86.5/82.6/16.2 → 86.5/82.6/16.2 |
| forum         | 82.9/86.4/2.3 → 82.9/86.4/2.3   | 83.5/86.4/0.0 → 83.4/86.4/0.0   |
| product       | 74.7/82.7/8.3 → 74.7/82.7/8.3   | 70.8/85.3/12.2 → 70.8/85.3/12.2 |
| collection    | 54.6/49.4/0.0 → 55.3/49.4/0.0   | 53.8/49.4/5.4 → 53.8/49.4/5.4   |
| listing       | 62.8/53.5/17.4 → 62.8/53.5/17.4 | 73.3/59.7/11.1 → 73.3/59.7/11.1 |
| documentation | 93.4/93.8/9.4 → 93.4/93.8/9.4   | 93.5/95.3/5.7 → 93.5/95.3/5.7   |
| service       | 75.2/68.2/14.1 → 75.2/68.2/14.1 | 70.8/70.8/15.6 → 70.8/70.8/15.6 |

| Option          | Median chars on → off | Median tokens on → off |              Median / p95 ms on → off | Error / empty on → off |
| --------------- | --------------------: | ---------------------: | ------------------------------------: | ---------------------: |
| Luna / Markdown |         8,518 → 5,852 |          2,040 → 1,449 | 13942.5 / 41243.3 → 13945.1 / 41255.6 |          0 / 1 → 0 / 1 |
| Luna / HTML     |         8,210 → 6,375 |          2,109 → 1,522 | 13462.1 / 40989.8 → 13464.9 / 40999.5 |          0 / 3 → 0 / 3 |

The Markdown parser detected HTML tags outside code on 0/101 Luna Markdown outputs, 1/101 live HTML outputs, and 11/511 snapshot outputs. This is a syntax check. It does not assess whether each remaining heading, link, or list was needed.

Both Luna inputs kept all four annotated snippets on the Rivian forum thread (5044) and the Armoury Fitness collection (5598). On the Astronomy forum (4145), the HTML pass returned empty. The raw response had the annotated thread inside `noscript`, which the HTML preparation removed. Luna on whole Markdown saw only the page title for that thread. On the decluttering article (5612), both Luna inputs retained reader comments and scored below Defuddle, which isolated the article. These cases show how the source representation and the prompt's rules for replies affect results.

### Token usage

| Input           | Requests | API input tokens | API output tokens | Reasoning tokens included in output | Largest API input | Estimated cost |
| --------------- | -------: | ---------------: | ----------------: | ----------------------------------: | ----------------: | -------------: |
| Luna / Markdown |      101 |          585,023 |           268,959 |                               7,127 |            28,779 |         $0.208 |
| Luna / HTML     |      101 |        1,175,103 |           254,530 |                               3,032 |            46,687 |         $0.274 |
| Luna / snapshot |      511 |        5,535,951 |         1,446,874 |                              16,795 |            37,933 |         $1.414 |

Total estimated spend was **$1.90** based on usage reported for 713 requests. The run reused the saved Scrapfly files. All inputs fit the advertised 1.05 million-token context. [OpenAI Docs pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)

To rerun from this worktree after preparing the original benchmark data, run the commands below. The runner reads `OPENAI_API_KEY` from the environment or `~/.zshrc.secrets` and saves responses and usage under the ignored `.local/luna/` directory. Existing request ledgers are reused.

```sh
node_modules/node/bin/node luna.mjs
node_modules/node/bin/node luna.mjs --snapshot
node_modules/node/bin/node extract.mjs luna
python3 score.py --luna
```
