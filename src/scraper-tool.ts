import { tool, type Tool } from "ai";
import { z } from "zod";
import { scrape, type ScrapeResult, type ScrapingProvider } from "./scraper.js";

const urlSchema = z
  .string()
  .refine(
    (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid URL format" }
  )
  .describe("The URL of the web page to scrape");

/**
 * Creates a scraping tool with optional default overrides
 * @param config - Configuration options for default values
 * @returns A scraping tool with the specified defaults
 *
 * @example
 * ```ts
 * // Create a tool with default provider
 * const tool = createScrapeTool({ defaultProvider: "exa" });
 *
 * // Create a tool with default maxChars
 * const tool = createScrapeTool({ defaultMaxChars: 5000 });
 * ```
 */
export const createScrapeTool = ({
  defaultProvider,
  defaultMaxChars,
  defaultFallback,
  defaultMarkdown,
  defaultHtml,
  defaultLivecrawl,
  defaultMaxAge,
}: {
  defaultProvider?: ScrapingProvider;
  defaultMaxChars?: number;
  defaultFallback?: boolean;
  defaultMarkdown?: boolean;
  defaultHtml?: boolean;
  defaultLivecrawl?: "never" | "fallback" | "always" | "preferred";
  defaultMaxAge?: number;
} = {}): Tool => {
  return tool({
    description:
      "Scrape a web page to extract its content, metadata, and optionally markdown or HTML. Supports multiple providers (Exa, Firecrawl, Cheerio) with automatic fallback on rate limits.",
    inputSchema: z.object({
      url: urlSchema,
      provider: z
        .enum(["exa", "firecrawl", "cheerio"])
        .optional()
        .describe(
          "Preferred scraping provider to use. Options: 'exa', 'firecrawl', or 'cheerio'. If not specified, the best available provider will be selected."
        ),
      markdown: z
        .boolean()
        .optional()
        .describe("Whether to return markdown format. Defaults to true."),
      html: z
        .boolean()
        .optional()
        .describe("Whether to return HTML format. Defaults to false."),
      maxChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of characters for text content. Content will be truncated if longer."
        ),
      fallback: z
        .boolean()
        .optional()
        .describe(
          "Whether to enable automatic fallback to alternative providers on rate limits. Defaults to true."
        ),
      livecrawl: z
        .enum(["never", "fallback", "always", "preferred"])
        .optional()
        .describe(
          "Live crawl preference for Exa provider. Options: 'never', 'fallback', 'always', 'preferred'. Only applies when using Exa."
        ),
      maxAge: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Cache max age in milliseconds for Firecrawl provider. Only applies when using Firecrawl."
        ),
    }),
    execute: async ({
      url,
      provider,
      markdown,
      html,
      maxChars,
      fallback,
      livecrawl,
      maxAge,
    }): Promise<ScrapeResult> => {
      const result = await scrape(url, {
        provider: provider || defaultProvider,
        markdown: markdown ?? defaultMarkdown,
        html: html ?? defaultHtml,
        maxChars: maxChars || defaultMaxChars,
        fallback: fallback ?? defaultFallback,
        livecrawl: livecrawl || defaultLivecrawl,
        maxAge: maxAge || defaultMaxAge,
      });

      return result;
    },
  });
};

/**
 * Default scraping tool instance (backward compatibility)
 * Scrapes web pages and extracts content, metadata, and optionally markdown/HTML
 *
 * For custom defaults, use `createScrapeTool({ ... })` instead.
 */
export const scrapeTool = createScrapeTool();
