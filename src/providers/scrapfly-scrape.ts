import { z } from "zod";
import { AppError } from "../server/error.js";
import { validatePublicUrl } from "../server/target.js";
import { pageContent } from "../tools/page-content.js";
import { providerRequest } from "./http.js";
import type { ScrapeProvider } from "./types.js";

const responseSchema = z.object({
  context: z
    .object({ redirects: z.array(z.string()).max(20).optional() })
    .optional(),
  result: z.object({
    content: z.string().nullish(),
    status_code: z.number().int().min(100).max(599),
    success: z.boolean(),
    url: z.string(),
    error: z.object({ code: z.string() }).nullish(),
  }),
});

const challenge = () =>
  new AppError(
    "challenge",
    "Scrapfly could not resolve the target's anti-bot challenge.",
  );

export function scrapflyScrape(key: string): ScrapeProvider {
  return {
    async scrape(url, signal) {
      const target = await validatePublicUrl(url);
      target.hash = "";
      const endpoint = new URL("https://api.scrapfly.io/scrape");
      endpoint.search = new URLSearchParams({
        key,
        url: target.href,
        asp: "true",
        format: "markdown:only_content,no_images",
      }).toString();

      const parsed = responseSchema.safeParse(
        await providerRequest(
          "Scrapfly",
          endpoint,
          {
            headers: { Accept: "application/json" },
            signal,
          },
          (response) => {
            const code = response.headers.get("X-Scrapfly-Reject-Code");
            if (code?.startsWith("ERR::ASP::")) return challenge();
            if (response.status === 401 || response.status === 403)
              return new AppError(
                "provider_auth",
                "Scrapfly rejected the API credential.",
              );
            if (response.status === 429)
              return new AppError(
                "provider_limit",
                "Scrapfly rate or quota limit reached.",
              );
          },
        ),
      );
      if (!parsed.success) {
        throw new AppError(
          "provider_response",
          "Scrapfly returned an invalid scrape result.",
        );
      }
      const { context, result } = parsed.data;

      // Scrapfly controls redirect fetching and DNS on its infrastructure.
      // Check its reported hops and final URL before releasing the response.
      for (const hop of new Set([...(context?.redirects ?? []), result.url])) {
        signal?.throwIfAborted();
        if (hop !== target.href) await validatePublicUrl(hop);
      }
      if (result.error?.code.startsWith("ERR::ASP::")) {
        throw challenge();
      }
      const content = pageContent(result.content ?? "", {
        status: result.status_code,
        limit: Infinity,
      });
      if (!result.success) {
        throw new AppError(
          "provider_response",
          "Scrapfly reported an unsuccessful scrape.",
        );
      }
      return content;
    },
  };
}
