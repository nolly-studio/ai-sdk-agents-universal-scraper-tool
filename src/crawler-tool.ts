import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  crawl,
  crawlBatch,
  type CrawlResult,
  type CrawlingProvider,
} from "./crawler.js";

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
  .describe("The URL of the web page to crawl");

const urlsSchema = z.array(urlSchema).min(1).describe("Array of URLs to crawl");

/**
 * Creates a crawling tool with optional default overrides
 * @param config - Configuration options for default values
 * @returns A crawling tool with the specified defaults
 *
 * @example
 * ```ts
 * // Create a tool with default provider
 * const tool = createCrawlTool({ defaultProvider: "exa" });
 *
 * // Create a tool with default maxSubpages
 * const tool = createCrawlTool({ defaultMaxSubpages: 5 });
 * ```
 */
export const createCrawlTool = ({
  defaultProvider,
  defaultMaxChars,
  defaultFallback,
  defaultMarkdown,
  defaultHtml,
  defaultLivecrawl,
  defaultMaxAge,
  defaultMaxSubpages,
  defaultMaxDepth,
  defaultConcurrency,
  defaultSameDomainOnly,
  defaultSubpageTarget,
}: {
  defaultProvider?: CrawlingProvider;
  defaultMaxChars?: number;
  defaultFallback?: boolean;
  defaultMarkdown?: boolean;
  defaultHtml?: boolean;
  defaultLivecrawl?: "never" | "fallback" | "always" | "preferred";
  defaultMaxAge?: number;
  defaultMaxSubpages?: number;
  defaultMaxDepth?: number;
  defaultConcurrency?: number;
  defaultSameDomainOnly?: boolean;
  defaultSubpageTarget?: string | string[];
} = {}): Tool => {
  return tool({
    description:
      "Crawl a web page with subpage discovery to extract content, metadata, and optionally markdown or HTML. Supports multiple providers (Exa, Firecrawl, Cheerio) with automatic fallback on rate limits. Can discover and crawl linked subpages.",
    inputSchema: z.object({
      url: urlSchema,
      provider: z
        .enum(["exa", "firecrawl", "cheerio"])
        .optional()
        .describe(
          "Preferred crawling provider to use. Options: 'exa', 'firecrawl', or 'cheerio'. If not specified, the best available provider will be selected."
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
      maxSubpages: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Maximum number of subpages to crawl per page. Set to 0 to disable subpage crawling. Defaults to 0."
        ),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum crawl depth. Defaults to 1 (only crawl the initial page and its immediate links)."
        ),
      concurrency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Number of concurrent requests for Cheerio provider. Defaults to 5."
        ),
      sameDomainOnly: z
        .boolean()
        .optional()
        .describe(
          "Only follow links from the same domain when crawling subpages. Defaults to true. Only applies to Cheerio provider."
        ),
      subpageTarget: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Keywords to find specific subpages. Can be a single string or array of strings. Only applies to Exa provider."
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
      maxSubpages,
      maxDepth,
      concurrency,
      sameDomainOnly,
      subpageTarget,
    }): Promise<CrawlResult> => {
      const result = await crawl(url, {
        provider: provider || defaultProvider,
        markdown: markdown ?? defaultMarkdown,
        html: html ?? defaultHtml,
        maxChars: maxChars || defaultMaxChars,
        fallback: fallback ?? defaultFallback,
        livecrawl: livecrawl || defaultLivecrawl,
        maxAge: maxAge || defaultMaxAge,
        maxSubpages: maxSubpages ?? defaultMaxSubpages,
        maxDepth: maxDepth || defaultMaxDepth,
        concurrency: concurrency || defaultConcurrency,
        sameDomainOnly:
          sameDomainOnly !== undefined ? sameDomainOnly : defaultSameDomainOnly,
        subpageTarget: subpageTarget || defaultSubpageTarget,
      });

      return result;
    },
  });
};

/**
 * Creates a batch crawling tool with optional default overrides
 * @param config - Configuration options for default values
 * @returns A batch crawling tool with the specified defaults
 *
 * @example
 * ```ts
 * // Create a batch tool with default provider
 * const tool = createCrawlBatchTool({ defaultProvider: "exa" });
 *
 * // Create a batch tool with default maxSubpages
 * const tool = createCrawlBatchTool({ defaultMaxSubpages: 3 });
 * ```
 */
export const createCrawlBatchTool = ({
  defaultProvider,
  defaultMaxChars,
  defaultFallback,
  defaultMarkdown,
  defaultHtml,
  defaultLivecrawl,
  defaultMaxAge,
  defaultMaxSubpages,
  defaultMaxDepth,
  defaultConcurrency,
  defaultSameDomainOnly,
  defaultSubpageTarget,
}: {
  defaultProvider?: CrawlingProvider;
  defaultMaxChars?: number;
  defaultFallback?: boolean;
  defaultMarkdown?: boolean;
  defaultHtml?: boolean;
  defaultLivecrawl?: "never" | "fallback" | "always" | "preferred";
  defaultMaxAge?: number;
  defaultMaxSubpages?: number;
  defaultMaxDepth?: number;
  defaultConcurrency?: number;
  defaultSameDomainOnly?: boolean;
  defaultSubpageTarget?: string | string[];
} = {}): Tool => {
  return tool({
    description:
      "Crawl multiple web pages with subpage discovery to extract content, metadata, and optionally markdown or HTML. Supports multiple providers (Exa, Firecrawl, Cheerio) with automatic fallback on rate limits. Can discover and crawl linked subpages for each URL.",
    inputSchema: z.object({
      urls: urlsSchema,
      provider: z
        .enum(["exa", "firecrawl", "cheerio"])
        .optional()
        .describe(
          "Preferred crawling provider to use. Options: 'exa', 'firecrawl', or 'cheerio'. If not specified, the best available provider will be selected."
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
      maxSubpages: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Maximum number of subpages to crawl per page. Set to 0 to disable subpage crawling. Defaults to 0."
        ),
      maxDepth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum crawl depth. Defaults to 1 (only crawl the initial page and its immediate links)."
        ),
      concurrency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Number of concurrent requests for Cheerio provider. Defaults to 5."
        ),
      sameDomainOnly: z
        .boolean()
        .optional()
        .describe(
          "Only follow links from the same domain when crawling subpages. Defaults to true. Only applies to Cheerio provider."
        ),
      subpageTarget: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Keywords to find specific subpages. Can be a single string or array of strings. Only applies to Exa provider."
        ),
    }),
    execute: async ({
      urls,
      provider,
      markdown,
      html,
      maxChars,
      fallback,
      livecrawl,
      maxAge,
      maxSubpages,
      maxDepth,
      concurrency,
      sameDomainOnly,
      subpageTarget,
    }) => {
      const result = await crawlBatch(urls, {
        provider: provider || defaultProvider,
        markdown: markdown ?? defaultMarkdown,
        html: html ?? defaultHtml,
        maxChars: maxChars || defaultMaxChars,
        fallback: fallback ?? defaultFallback,
        livecrawl: livecrawl || defaultLivecrawl,
        maxAge: maxAge || defaultMaxAge,
        maxSubpages: maxSubpages ?? defaultMaxSubpages,
        maxDepth: maxDepth || defaultMaxDepth,
        concurrency: concurrency || defaultConcurrency,
        sameDomainOnly:
          sameDomainOnly !== undefined ? sameDomainOnly : defaultSameDomainOnly,
        subpageTarget: subpageTarget || defaultSubpageTarget,
      });

      return result;
    },
  });
};

/**
 * Default crawling tool instance (backward compatibility)
 * Crawls web pages with subpage discovery and extracts content, metadata, and optionally markdown/HTML
 *
 * For custom defaults, use `createCrawlTool({ ... })` instead.
 */
export const crawlTool = createCrawlTool();

/**
 * Default batch crawling tool instance
 * Crawls multiple web pages with subpage discovery
 *
 * For custom defaults, use `createCrawlBatchTool({ ... })` instead.
 */
export const crawlBatchTool = createCrawlBatchTool();
