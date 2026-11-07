import type { RequestLimits } from "../server/request-limits.js";
import type { Usage } from "../server/usage.js";
import { defaults } from "../config/tuning.js";
import { MAX_SEARCH_HIT_URL_CHARS } from "../config/safety-limits.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { writeProviderAttempt } from "../server/stats.js";
import { AppError, safeError } from "../server/error.js";
import { providerResponse } from "./http.js";
import type { SearchProvider } from "./types.js";

const responseSchema = z.object({
  organic: z
    .array(
      z.object({
        title: z.string(),
        link: z.string(),
        snippet: z.string().optional(),
        date: z.string().nullish(),
      }),
    )
    .default([]),
  credits: z.number().finite().nonnegative().optional(),
});

class SerperHttpError extends AppError {
  constructor(readonly status: number) {
    super("provider_http", `Serper returned HTTP ${status}.`);
  }
}

export function serper(
  key: string,
  settings = defaults,
  limits?: RequestLimits,
  usage?: Usage,
): SearchProvider {
  return {
    name: "serper",
    async search(
      {
        query,
        limit,
        recency,
        site,
        exclude_domains = [],
        location,
        gl = settings.searchGl,
        hl = settings.searchHl,
        page,
        autocorrect,
        tbs,
      },
      signal,
      retry,
      deadline = Infinity,
    ) {
      deadline = Math.min(
        deadline,
        performance.now() + settings.serperTimeoutMs,
      );
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(settings.serperTimeoutMs),
        ...(signal ? [signal] : []),
      ]);
      const queryWithOperators = [
        query,
        ...(site ? [`site:${site}`] : []),
        ...exclude_domains.map((host) => `-site:${host}`),
      ].join(" ");
      const freshness = { day: "d", week: "w", month: "m", year: "y" };
      async function request(hedgeTrigger?: "delay" | "failure") {
        await limits?.acquire(requestSignal, deadline, "serper");
        requestSignal.throwIfAborted();
        if (hedgeTrigger) retry?.();
        usage?.record("serper", null, Date.now());
        const start = performance.now();
        let credits: number | null = null;
        let errorCode: string | null = null;
        try {
          const { response, body } = await providerResponse(
            "Serper",
            new URL("https://google.serper.dev/search"),
            {
              method: "POST",
              headers: { "X-API-KEY": key, "Content-Type": "application/json" },
              body: JSON.stringify({
                q: queryWithOperators,
                num: limit,
                gl,
                hl,
                location,
                page,
                autocorrect,
                tbs: recency ? `qdr:${freshness[recency]}` : tbs,
              }),
              signal: requestSignal,
            },
          );
          const raw =
            body && typeof body === "object" && "credits" in body
              ? body.credits
              : undefined;
          if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0)
            credits = raw;
          if (response.status === 401 || response.status === 403)
            throw new AppError(
              "provider_auth",
              "Serper rejected the API credential.",
            );
          if (response.status === 402 || response.status === 429)
            throw new AppError(
              "provider_limit",
              "Serper rate or quota limit reached.",
            );
          if (!response.ok) throw new SerperHttpError(response.status);
          const parsed = responseSchema.safeParse(body);
          if (!parsed.success)
            throw new AppError("provider_response", "Invalid Serper response.");
          return parsed;
        } catch (error) {
          errorCode = safeError(error).code;
          throw error;
        } finally {
          writeProviderAttempt(
            {
              provider: "serper",
              rung: hedgeTrigger ? "hedge" : "primary",
              hedgeTrigger,
              credits,
              durationMs: Math.round(performance.now() - start),
              errorCode,
            },
            settings,
          );
        }
      }
      const primary = request();
      const startBackup = Promise.race([
        delay(settings.serperBackupDelayMs, "delay" as const, {
          signal: requestSignal,
        }),
        primary.then(
          () => undefined,
          (error: unknown) =>
            !requestSignal.aborted &&
            !(
              error instanceof SerperHttpError &&
              error.status < 500 &&
              error.status !== 408
            ) &&
            !(
              error instanceof AppError &&
              ["provider_auth", "provider_limit", "local_rate_limit"].includes(
                error.code,
              )
            )
              ? ("failure" as const)
              : undefined,
        ),
      ]);
      const backup = startBackup.then((start) => {
        if (!start) return primary;
        requestSignal.throwIfAborted();
        return request(start);
      });
      const response = await Promise.any([primary, backup])
        .catch((error: AggregateError) => {
          throw (
            error.errors.find(
              (failure: unknown) =>
                failure instanceof AppError &&
                failure.code === "local_rate_limit",
            ) ?? error.errors[0]
          );
        })
        .finally(() => controller.abort());
      return response.data.organic
        .filter(({ link }) => {
          if (
            !/^https?:\/\//i.test(link) ||
            link.length > MAX_SEARCH_HIT_URL_CHARS ||
            !URL.canParse(link)
          )
            return false;
          const host = new URL(link).hostname.replace(/\.$/, "");
          return !exclude_domains.some(
            (excluded) => host === excluded || host.endsWith(`.${excluded}`),
          );
        })
        .slice(0, limit)
        .map(({ title, link, snippet, date }) => ({
          title: title.slice(0, 160),
          url: link,
          snippet: snippet?.slice(0, 320),
          date: date?.slice(0, 80),
        }));
    },
  };
}
