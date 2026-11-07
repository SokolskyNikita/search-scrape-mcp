import { z } from "zod";
import { AppError } from "../server/error.js";
import { providerRequest } from "./http.js";
import type { SearchProvider } from "./types.js";

const responseSchema = z.object({
  organic: z
    .array(
      z.object({
        title: z.string(),
        link: z.string(),
        snippet: z.string().optional(),
      }),
    )
    .default([]),
});

export function serper(key: string): SearchProvider {
  return {
    async search({ query, limit }) {
      const response = responseSchema.safeParse(
        await providerRequest(
          "Serper",
          new URL("https://google.serper.dev/search"),
          {
            method: "POST",
            headers: { "X-API-KEY": key, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: limit }),
          },
        ),
      );
      if (!response.success)
        throw new AppError("provider_response", "Invalid Serper response.");
      return response.data.organic
        .filter(({ link }) => /^https?:\/\//i.test(link) && link.length <= 1024)
        .slice(0, limit)
        .map(({ title, link, snippet }) => ({
          title: title.slice(0, 160),
          url: link,
          snippet: snippet?.slice(0, 320),
        }));
    },
  };
}
