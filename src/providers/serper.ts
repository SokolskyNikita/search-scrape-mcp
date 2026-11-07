import { setTimeout as delay } from "node:timers/promises";
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
    name: "serper",
    async search({ query, limit }, signal, retry) {
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(12_000),
        ...(signal ? [signal] : []),
      ]);
      async function request() {
        const response = responseSchema.safeParse(
          await providerRequest(
            "Serper",
            new URL("https://google.serper.dev/search"),
            {
              method: "POST",
              headers: { "X-API-KEY": key, "Content-Type": "application/json" },
              body: JSON.stringify({ q: query, num: limit }),
              signal: requestSignal,
            },
            ({ status }) => {
              if (status === 401 || status === 403)
                return new AppError(
                  "provider_auth",
                  "Serper rejected the API credential.",
                );
              if (status === 429)
                return new AppError(
                  "provider_limit",
                  "Serper rate or quota limit reached.",
                );
            },
          ),
        );
        if (!response.success)
          throw new AppError("provider_response", "Invalid Serper response.");
        return response;
      }
      const primary = request();
      const startBackup = Promise.race([
        delay(900, true, { signal: requestSignal }),
        primary.then(
          () => false,
          (error: unknown) =>
            !requestSignal.aborted &&
            !(
              error instanceof AppError &&
              ["provider_auth", "provider_limit"].includes(error.code)
            ),
        ),
      ]);
      const backup = startBackup.then((start) => {
        if (!start) return primary;
        requestSignal.throwIfAborted();
        retry?.();
        return request();
      });
      const response = await Promise.any([primary, backup])
        .catch((error: AggregateError) => {
          throw error.errors[0];
        })
        .finally(() => controller.abort());
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
