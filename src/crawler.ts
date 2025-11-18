/**
 * Unified crawling library
 * Simple, declarative API with great defaults for crawling multiple sites with subpage discovery
 *
 * @example
 * import { crawl } from '@/lib/crawler';
 * const result = await crawl('https://example.com', { maxSubpages: 5 });
 */

import Exa from "exa-js";
import Firecrawl from "@mendable/firecrawl-js";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import DOMPurify from "isomorphic-dompurify";
import pMap from "p-map";

// ============================================================================
// Types
// ============================================================================

export type ScrapingProvider = "exa" | "firecrawl" | "cheerio";

export interface ScrapeOptions {
  /** Preferred provider to use (if available) */
  provider?: ScrapingProvider;

  /** Whether to enable automatic fallback on rate limits */
  fallback?: boolean;

  /** Whether to return markdown format */
  markdown?: boolean;

  /** Whether to return HTML format */
  html?: boolean;

  /** Maximum characters for text content */
  maxChars?: number;

  /** Live crawl preference for Exa */
  livecrawl?: "never" | "fallback" | "always" | "preferred";

  /** Cache max age in milliseconds (for Firecrawl) */
  maxAge?: number;
}

export interface ScrapeResult {
  url: string;
  text: string;
  markdown?: string;
  html?: string;
  metadata: {
    title?: string;
    description?: string;
    language?: string;
    author?: string;
    publishedDate?: string;
    image?: string;
    favicon?: string;
    statusCode?: number;
    [key: string]: unknown;
  };
  provider: ScrapingProvider;
}

export type CrawlingProvider = ScrapingProvider; // "exa" | "firecrawl" | "cheerio"

export interface CrawlOptions extends Omit<ScrapeOptions, "provider"> {
  /** Preferred provider to use (if available) */
  provider?: CrawlingProvider;

  /** Maximum number of subpages to crawl per page (default: 0) */
  maxSubpages?: number;

  /** Maximum crawl depth (default: 1) */
  maxDepth?: number;

  /** Keywords to find specific subpages (for Exa) */
  subpageTarget?: string | string[];

  /** Concurrent requests for Cheerio (default: 5) */
  concurrency?: number;

  /** Only follow same-domain links for Cheerio (default: true) */
  sameDomainOnly?: boolean;
}

export interface CrawlResult extends ScrapeResult {
  /** Array of discovered subpages */
  subpages?: CrawlResult[];

  /** Crawl depth of this page */
  depth?: number;
}

export interface CrawlBatchResult {
  results: CrawlResult[];
  statuses?: Array<{
    id: string;
    status: "success" | "error";
    error?: { tag: string; httpStatusCode?: number };
  }>;
}

// Internal types
interface CrawlerAdapter {
  name: CrawlingProvider;
  available: () => boolean;
  crawl: (url: string, options: CrawlOptions) => Promise<CrawlResult>;
  crawlBatch: (
    urls: string[],
    options: CrawlOptions
  ) => Promise<CrawlBatchResult>;
}

// Error type with rate limit flag
interface RateLimitError extends Error {
  isRateLimit: boolean;
}

// Exa API types (reuse from scraper)
interface ExaResult {
  url?: string;
  text?: string;
  html?: string;
  title?: string | null;
  summary?: string;
  author?: string;
  publishedDate?: string;
  image?: string;
  favicon?: string;
  subpages?: ExaResult[];
  [key: string]: unknown;
}

interface ExaStatus {
  id?: string;
  status?: string;
  error?: {
    tag?: string;
    httpStatusCode?: number;
  };
}

type ExaOptions = Record<string, unknown>;

// Firecrawl API types (reuse from scraper)
interface FirecrawlMetadata {
  sourceURL?: string;
  title?: string;
  description?: string;
  language?: string;
  keywords?: string;
  ogImage?: string;
  statusCode?: number;
  [key: string]: unknown;
}

interface FirecrawlResult {
  markdown?: string;
  html?: string;
  metadata?: FirecrawlMetadata;
  links?: string[];
  [key: string]: unknown;
}

interface FirecrawlResponse {
  data?: FirecrawlResult;
  markdown?: string;
  html?: string;
  metadata?: FirecrawlMetadata;
  links?: string[];
  [key: string]: unknown;
}

type FirecrawlOptions = Record<string, unknown>;

interface RateLimitState {
  isLimited: boolean;
  resetAt?: Date;
  errors: number;
}

interface ProviderState {
  available: boolean;
  rateLimit: RateLimitState;
  lastSuccess?: Date;
}

// ============================================================================
// Rate Limit State Management (reused from scraper)
// ============================================================================

const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 1 minute

const createInitialState = (): ProviderState => ({
  available: false,
  rateLimit: {
    isLimited: false,
    errors: 0,
  },
});

const createRateLimitState = (): Record<CrawlingProvider, ProviderState> => ({
  exa: createInitialState(),
  firecrawl: createInitialState(),
  cheerio: createInitialState(),
});

const state = createRateLimitState();

const setAvailable = (provider: CrawlingProvider, available: boolean): void => {
  state[provider].available = available;
};

const recordSuccess = (provider: CrawlingProvider): void => {
  state[provider].lastSuccess = new Date();
  state[provider].rateLimit.isLimited = false;
  state[provider].rateLimit.errors = 0;
};

const recordRateLimit = (provider: CrawlingProvider): void => {
  state[provider].rateLimit.isLimited = true;
  state[provider].rateLimit.errors += 1;
  state[provider].rateLimit.resetAt = new Date(
    Date.now() + RATE_LIMIT_COOLDOWN_MS
  );
};

const recordError = (provider: CrawlingProvider): void => {
  state[provider].rateLimit.errors += 1;
};

const isRateLimited = (provider: CrawlingProvider): boolean => {
  const providerState = state[provider];
  if (!providerState.rateLimit.isLimited) return false;

  if (
    providerState.rateLimit.resetAt &&
    new Date() >= providerState.rateLimit.resetAt
  ) {
    providerState.rateLimit.isLimited = false;
    providerState.rateLimit.resetAt = undefined;
    return false;
  }

  return true;
};

const getAvailableProvidersInternal = (): CrawlingProvider[] => {
  return (["exa", "firecrawl", "cheerio"] as CrawlingProvider[]).filter((p) => {
    const adapter =
      p === "exa"
        ? exaAdapter
        : p === "firecrawl"
        ? firecrawlAdapter
        : cheerioAdapter;
    return adapter.available() && !isRateLimited(p);
  });
};

const selectProvider = (
  prefer?: CrawlingProvider,
  fallback: boolean = true,
  options?: CrawlOptions
): CrawlingProvider | null => {
  const available = getAvailableProvidersInternal();

  if (available.length === 0) return null;

  // If html is requested, prefer Firecrawl since it has better HTML support
  if (options?.html && !prefer) {
    if (available.includes("firecrawl")) return "firecrawl";
  }

  if (prefer && available.includes(prefer)) return prefer;

  if (prefer && !fallback) return null;

  // Default priority order: Cheerio > Exa > Firecrawl
  const priorityOrder: CrawlingProvider[] = ["cheerio", "exa", "firecrawl"];

  // First, try providers in priority order
  for (const provider of priorityOrder) {
    if (available.includes(provider)) {
      return provider;
    }
  }

  // Fallback: Sort by recent success and fewer errors if priority doesn't match
  const sorted = [...available].sort((a, b) => {
    const sa = state[a];
    const sb = state[b];

    if (sa.lastSuccess && !sb.lastSuccess) return -1;
    if (!sa.lastSuccess && sb.lastSuccess) return 1;
    if (sa.rateLimit.errors < sb.rateLimit.errors) return -1;
    if (sa.rateLimit.errors > sb.rateLimit.errors) return 1;
    return 0;
  });

  return sorted[0] || null;
};

// ============================================================================
// Helper Functions
// ============================================================================

const normalizeExaResultToCrawl = (
  result: ExaResult,
  url: string,
  options: CrawlOptions,
  depth: number = 0
): CrawlResult => {
  // Reuse normalization logic from scraper
  const exaText = result.text || "";
  const exaHtml = result.html || "";

  const isHtml = exaText.includes("<") && exaText.includes(">");
  const htmlContent = exaHtml || (isHtml ? exaText : "");

  let text = exaText;
  if (isHtml) {
    const dom = new JSDOM(exaText);
    text = dom.window.document.body.textContent || "";
  }

  let markdown: string | undefined;
  if (options.markdown !== false) {
    if (!isHtml && exaText) {
      markdown = exaText;
    } else if (htmlContent) {
      const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
      });

      const sanitizedHtml = DOMPurify.sanitize(htmlContent, {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "em",
          "u",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "ul",
          "ol",
          "li",
          "blockquote",
          "pre",
          "code",
          "a",
          "img",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "div",
          "span",
          "article",
          "section",
        ],
        ALLOWED_ATTR: [
          "href",
          "src",
          "alt",
          "title",
          "class",
          "id",
          "width",
          "height",
          "align",
        ],
        ALLOW_DATA_ATTR: false,
      });
      markdown = turndown.turndown(sanitizedHtml);
    }

    if (markdown && options.maxChars && markdown.length > options.maxChars) {
      markdown = markdown.substring(0, options.maxChars);
    }
  }

  if (options.maxChars && text.length > options.maxChars) {
    text = text.substring(0, options.maxChars);
  }

  // Process subpages recursively
  const subpages: CrawlResult[] = [];
  if (result.subpages && result.subpages.length > 0) {
    const maxSubpages = options.maxSubpages || 0;
    const subpagesToProcess = result.subpages.slice(0, maxSubpages);

    for (const subpage of subpagesToProcess) {
      subpages.push(
        normalizeExaResultToCrawl(
          subpage,
          subpage.url || url,
          options,
          depth + 1
        )
      );
    }
  }

  return {
    url: result.url || url,
    text,
    markdown,
    html: options.html ? htmlContent : undefined,
    metadata: {
      title: result.title ?? undefined,
      description: result.summary,
      author: result.author,
      publishedDate: result.publishedDate,
      image: result.image,
      favicon: result.favicon,
      sourceURL: result.url || url,
      ...(Object.fromEntries(
        Object.entries(result).filter(
          ([key]) =>
            ![
              "url",
              "text",
              "html",
              "title",
              "summary",
              "author",
              "publishedDate",
              "image",
              "favicon",
              "subpages",
            ].includes(key)
        )
      ) as Record<string, unknown>),
    },
    provider: "exa",
    subpages: subpages.length > 0 ? subpages : undefined,
    depth,
  };
};

const normalizeCheerioResultToCrawl = (
  html: string,
  url: string,
  options: CrawlOptions,
  depth: number = 0
): CrawlResult => {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Failed to parse readable content from: ${url}`);
  }

  const $ = cheerio.load(html);
  const title =
    article.title ||
    $("title").text() ||
    $('meta[property="og:title"]').attr("content") ||
    "";
  const description =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";
  const author =
    $('meta[name="author"]').attr("content") ||
    $('meta[property="article:author"]').attr("content") ||
    article.byline ||
    "";
  const publishedDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('meta[name="date"]').attr("content") ||
    "";
  const image =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    "";
  const favicon =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    "";

  let htmlContent = article.content || html;

  htmlContent = DOMPurify.sanitize(htmlContent, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "u",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "div",
      "span",
      "article",
      "section",
    ],
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "title",
      "class",
      "id",
      "width",
      "height",
      "align",
    ],
    ALLOW_DATA_ATTR: false,
  });

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  let markdown: string | undefined;
  if (options.markdown !== false) {
    markdown = turndownService.turndown(htmlContent);
  }

  let text = article.textContent || "";
  if (options.maxChars && text.length > options.maxChars) {
    text = text.substring(0, options.maxChars);
  }

  if (markdown && options.maxChars && markdown.length > options.maxChars) {
    markdown = markdown.substring(0, options.maxChars);
  }

  return {
    url,
    text,
    markdown,
    html: options.html ? htmlContent : undefined,
    metadata: {
      title,
      description,
      author,
      publishedDate,
      image,
      favicon,
      language: article.lang || document.documentElement.lang || "",
      excerpt: article.excerpt,
      siteName: article.siteName,
      sourceURL: url,
    },
    provider: "cheerio",
    depth,
  };
};

const extractLinks = (
  html: string,
  baseUrl: string,
  sameDomainOnly: boolean = true
): string[] => {
  const $ = cheerio.load(html);
  const links: string[] = [];
  const baseDomain = new URL(baseUrl).hostname;

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) {
      return;
    }

    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      const urlDomain = new URL(absoluteUrl).hostname;

      if (sameDomainOnly && urlDomain !== baseDomain) {
        return;
      }

      // Only include http/https URLs
      if (
        absoluteUrl.startsWith("http://") ||
        absoluteUrl.startsWith("https://")
      ) {
        links.push(absoluteUrl);
      }
    } catch {
      // Invalid URL, skip
    }
  });

  // Deduplicate
  return Array.from(new Set(links));
};

// ============================================================================
// Exa Adapter
// ============================================================================

const createExaClient = (): Exa | null => {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return null;

  try {
    return new Exa(apiKey);
  } catch {
    return null;
  }
};

const isExaRateLimitError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return /rate limit|429|quota|limit/i.test(msg);
};

const buildExaOptions = (options: CrawlOptions): ExaOptions => {
  const exaOptions: ExaOptions = {
    livecrawl: options.livecrawl || "fallback",
  };

  if (options.markdown !== false) {
    if (options.maxChars || options.html !== undefined) {
      exaOptions.text = {
        maxCharacters: options.maxChars,
        includeHtmlTags: options.html || false,
      };
    } else {
      exaOptions.text = true;
    }
  }

  // Add subpages support
  if (options.maxSubpages && options.maxSubpages > 0) {
    exaOptions.subpages = options.maxSubpages;

    if (options.subpageTarget) {
      exaOptions.subpageTarget = Array.isArray(options.subpageTarget)
        ? options.subpageTarget.join(",")
        : options.subpageTarget;
    }
  }

  return exaOptions;
};

const exaAdapter: CrawlerAdapter = {
  name: "exa",

  available: () => {
    const apiKey = process.env.EXA_API_KEY;
    return !!apiKey;
  },

  crawl: async (url: string, options: CrawlOptions): Promise<CrawlResult> => {
    const client = createExaClient();
    if (!client) {
      throw new Error("Exa not available: EXA_API_KEY not set");
    }

    try {
      const exaOptions = buildExaOptions(options);
      const response = await client.getContents([url], exaOptions);

      if (!response.results?.[0]) {
        throw new Error(`No results from Exa for: ${url}`);
      }

      return normalizeExaResultToCrawl(response.results[0], url, options, 0);
    } catch (error) {
      if (isExaRateLimitError(error)) {
        const err = new Error(
          `Exa rate limit: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        (err as RateLimitError).isRateLimit = true;
        throw err;
      }
      throw error;
    }
  },

  crawlBatch: async (
    urls: string[],
    options: CrawlOptions
  ): Promise<CrawlBatchResult> => {
    const client = createExaClient();
    if (!client) {
      throw new Error("Exa not available: EXA_API_KEY not set");
    }

    try {
      const exaOptions = buildExaOptions(options);
      const response = await client.getContents(urls, exaOptions);

      const results: CrawlResult[] = [];
      for (const r of response.results || []) {
        results.push(
          normalizeExaResultToCrawl(r, (r.url || "") as string, options, 0)
        );
      }

      const statuses: CrawlBatchResult["statuses"] = (
        response.statuses || []
      ).map((s: ExaStatus) => ({
        id: s.id || "",
        status: (s.status === "success" ? "success" : "error") as
          | "success"
          | "error",
        error: s.error
          ? {
              tag: s.error.tag || "UNKNOWN_ERROR",
              httpStatusCode: s.error.httpStatusCode,
            }
          : undefined,
      }));

      return { results, statuses };
    } catch (error) {
      if (isExaRateLimitError(error)) {
        const err = new Error(
          `Exa rate limit: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        (err as RateLimitError).isRateLimit = true;
        throw err;
      }
      throw error;
    }
  },
};

// ============================================================================
// Firecrawl Adapter
// ============================================================================

const createFirecrawlClient = (): Firecrawl | null => {
  const apiKey = process.env.FIRECRAWL_API_KEY || process.env.FC_API_KEY;
  if (!apiKey) return null;

  try {
    return new Firecrawl({ apiKey });
  } catch {
    return null;
  }
};

const isFirecrawlRateLimitError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return /rate limit|429|quota|limit|RateLimitError/i.test(msg);
};

const normalizeFirecrawlResultToCrawl = (
  data: FirecrawlResult,
  url: string,
  depth: number = 0
): CrawlResult => ({
  url: data.metadata?.sourceURL || url,
  markdown: data.markdown,
  html: data.html,
  text: data.markdown || data.html || "",
  metadata: {
    title: data.metadata?.title,
    description: data.metadata?.description,
    language: data.metadata?.language,
    keywords: data.metadata?.keywords,
    image: data.metadata?.ogImage,
    statusCode: data.metadata?.statusCode,
    sourceURL: data.metadata?.sourceURL || url,
    ...data.metadata,
  },
  provider: "firecrawl",
  depth,
});

const buildFirecrawlOptions = (options: CrawlOptions): FirecrawlOptions => {
  const formats: string[] = [];

  if (options.markdown !== false) formats.push("markdown");
  if (options.html) formats.push("html");
  if (formats.length === 0) formats.push("markdown");

  const firecrawlOptions: FirecrawlOptions = {
    formats: formats as unknown as string[],
  };

  if (options.maxAge !== undefined) firecrawlOptions.maxAge = options.maxAge;
  if (options.maxAge === 0) firecrawlOptions.storeInCache = false;

  return firecrawlOptions;
};

const firecrawlAdapter: CrawlerAdapter = {
  name: "firecrawl",

  available: () => {
    const apiKey = process.env.FIRECRAWL_API_KEY || process.env.FC_API_KEY;
    return !!apiKey;
  },

  crawl: async (url: string, options: CrawlOptions): Promise<CrawlResult> => {
    const client = createFirecrawlClient();
    if (!client) {
      throw new Error("Firecrawl not available: FIRECRAWL_API_KEY not set");
    }

    try {
      const firecrawlOptions = buildFirecrawlOptions(options);
      const response = await client.scrape(url, firecrawlOptions);

      const firecrawlResponse = response as FirecrawlResponse;
      const data: FirecrawlResult =
        firecrawlResponse.data ||
        ({
          markdown: firecrawlResponse.markdown,
          html: firecrawlResponse.html,
          metadata: firecrawlResponse.metadata,
          links: firecrawlResponse.links,
        } as FirecrawlResult);

      if (!data) {
        throw new Error(`No data from Firecrawl for: ${url}`);
      }

      const result = normalizeFirecrawlResultToCrawl(data, url, 0);

      // If subpages are requested, crawl them using Cheerio adapter
      if (options.maxSubpages && options.maxSubpages > 0 && data.links) {
        const maxSubpages = Math.min(options.maxSubpages, data.links.length);
        const subpageUrls = data.links.slice(0, maxSubpages);

        // Use cheerio adapter to crawl subpages
        const subpageResults = await cheerioAdapter.crawlBatch(subpageUrls, {
          ...options,
          maxSubpages: 0,
          maxDepth: (options.maxDepth || 1) - 1,
        });

        result.subpages = subpageResults.results.map((r) => ({
          ...r,
          depth: (r.depth || 0) + 1,
        }));
      }

      return result;
    } catch (error) {
      if (isFirecrawlRateLimitError(error)) {
        const err = new Error(
          `Firecrawl rate limit: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        (err as RateLimitError).isRateLimit = true;
        throw err;
      }
      throw error;
    }
  },

  crawlBatch: async (
    urls: string[],
    options: CrawlOptions
  ): Promise<CrawlBatchResult> => {
    const client = createFirecrawlClient();
    if (!client) {
      throw new Error("Firecrawl not available: FIRECRAWL_API_KEY not set");
    }

    const results: CrawlResult[] = [];
    const statuses: CrawlBatchResult["statuses"] = [];

    for (const url of urls) {
      try {
        const result = await firecrawlAdapter.crawl(url, options);
        results.push(result);
        statuses?.push({ id: url, status: "success" });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        statuses?.push({
          id: url,
          status: "error",
          error: {
            tag: "CRAWL_ERROR",
            httpStatusCode: /404/.test(msg)
              ? 404
              : /403/.test(msg)
              ? 403
              : undefined,
          },
        });
      }
    }

    return { results, statuses };
  },
};

// ============================================================================
// Cheerio Adapter
// ============================================================================

const cheerioAdapter: CrawlerAdapter = {
  name: "cheerio",

  available: () => {
    return true;
  },

  crawl: async (url: string, options: CrawlOptions): Promise<CrawlResult> => {
    const visitedUrls = new Set<string>();
    const concurrency = options.concurrency || 5;
    const maxDepth = options.maxDepth ?? 1;
    const maxSubpages = options.maxSubpages || 0;
    const sameDomainOnly = options.sameDomainOnly !== false;

    const crawlRecursive = async (
      currentUrl: string,
      depth: number
    ): Promise<CrawlResult> => {
      if (visitedUrls.has(currentUrl) || depth > maxDepth) {
        throw new Error(
          `URL already visited or max depth reached: ${currentUrl}`
        );
      }

      visitedUrls.add(currentUrl);

      try {
        new URL(currentUrl);
      } catch {
        throw new Error(`Invalid URL: ${currentUrl}`);
      }

      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP error! status: ${response.status} for ${currentUrl}`
        );
      }

      const html = await response.text();
      const result = normalizeCheerioResultToCrawl(
        html,
        currentUrl,
        options,
        depth
      );

      // Discover and crawl subpages if requested
      if (depth < maxDepth && maxSubpages > 0) {
        const links = extractLinks(html, currentUrl, sameDomainOnly);
        const linksToCrawl = links
          .filter((link) => !visitedUrls.has(link))
          .slice(0, maxSubpages);

        if (linksToCrawl.length > 0) {
          const subpageResults = await pMap(
            linksToCrawl,
            async (link) => {
              try {
                return await crawlRecursive(link, depth + 1);
              } catch {
                return null;
              }
            },
            { concurrency }
          );

          result.subpages = subpageResults.filter(
            (r): r is CrawlResult => r !== null
          );
        }
      }

      return result;
    };

    return crawlRecursive(url, 0);
  },

  crawlBatch: async (
    urls: string[],
    options: CrawlOptions
  ): Promise<CrawlBatchResult> => {
    const concurrency = options.concurrency || 5;
    const results: CrawlResult[] = [];
    const statuses: CrawlBatchResult["statuses"] = [];

    const crawlResults = await pMap(
      urls,
      async (url) => {
        try {
          const result = await cheerioAdapter.crawl(url, options);
          return { result, status: "success" as const, url };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            result: null,
            status: "error" as const,
            url,
            error: {
              tag: "CRAWL_ERROR",
              httpStatusCode: /404/.test(msg)
                ? 404
                : /403/.test(msg)
                ? 403
                : undefined,
            },
          };
        }
      },
      { concurrency }
    );

    for (const item of crawlResults) {
      if (item.result) {
        results.push(item.result);
      }
      statuses.push({
        id: item.url,
        status: item.status,
        error: "error" in item ? item.error : undefined,
      });
    }

    return { results, statuses };
  },
};

// ============================================================================
// Main Crawler Logic
// ============================================================================

const DEFAULT_OPTIONS: Partial<CrawlOptions> = {
  fallback: true,
  markdown: true,
  html: false,
  maxSubpages: 0,
  maxDepth: 1,
  concurrency: 5,
  sameDomainOnly: true,
};

const adapters = {
  exa: exaAdapter,
  firecrawl: firecrawlAdapter,
  cheerio: cheerioAdapter,
};

const initProviders = () => {
  setAvailable("exa", exaAdapter.available());
  setAvailable("firecrawl", firecrawlAdapter.available());
  setAvailable("cheerio", cheerioAdapter.available());
};

initProviders();

const getAdapter = (provider: CrawlingProvider) => adapters[provider];

const tryWithFallback = async (
  url: string,
  options: CrawlOptions,
  provider: CrawlingProvider
): Promise<CrawlResult> => {
  const adapter = getAdapter(provider);

  try {
    const result = await adapter.crawl(url, options);
    recordSuccess(provider);
    return result;
  } catch (error) {
    const isRateLimit = (error as RateLimitError)?.isRateLimit || false;

    if (isRateLimit) {
      recordRateLimit(provider);

      if (options.fallback !== false) {
        const alternatives: CrawlingProvider[] =
          provider === "exa"
            ? ["firecrawl", "cheerio"]
            : provider === "firecrawl"
            ? ["exa", "cheerio"]
            : ["exa", "firecrawl"];

        for (const alt of alternatives) {
          const altAdapter = getAdapter(alt);
          if (altAdapter.available() && !isRateLimited(alt)) {
            try {
              const result = await altAdapter.crawl(url, options);
              recordSuccess(alt);
              return result;
            } catch (fallbackError) {
              const isFallbackRateLimit =
                (fallbackError as RateLimitError)?.isRateLimit || false;
              if (isFallbackRateLimit) {
                recordRateLimit(alt);
              } else {
                recordError(alt);
              }
            }
          }
        }
      }

      throw error;
    } else {
      recordError(provider);
      throw error;
    }
  }
};

/**
 * Crawl a URL with subpage discovery
 * Simple API: just pass a URL, everything else has great defaults
 *
 * @example
 * const result = await crawl("https://example.com", { maxSubpages: 5 });
 * console.log(result.subpages);
 */
export const crawl = async (
  url: string,
  options: CrawlOptions = {}
): Promise<CrawlResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const provider = selectProvider(opts.provider, opts.fallback !== false, opts);

  if (!provider) {
    const exaAvail = exaAdapter.available();
    const fcAvail = firecrawlAdapter.available();
    const cheerioAvail = cheerioAdapter.available();

    if (!exaAvail && !fcAvail && !cheerioAvail) {
      throw new Error(
        "No crawling providers available. Set EXA_API_KEY or FIRECRAWL_API_KEY, or use cheerio provider"
      );
    }

    if (opts.fallback !== false) {
      const tryProvider =
        opts.provider ||
        (cheerioAvail ? "cheerio" : exaAvail ? "exa" : "firecrawl");
      return tryWithFallback(url, opts, tryProvider);
    }

    throw new Error(
      `Provider "${opts.provider}" not available and fallback disabled`
    );
  }

  return tryWithFallback(url, opts, provider);
};

/**
 * Crawl multiple URLs with subpage discovery
 *
 * @example
 * const results = await crawlBatch(["https://example.com", "https://example.org"], { maxSubpages: 3 });
 */
export const crawlBatch = async (
  urls: string[],
  options: CrawlOptions = {}
): Promise<CrawlBatchResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const provider = selectProvider(opts.provider, opts.fallback !== false, opts);

  if (!provider) {
    const exaAvail = exaAdapter.available();
    const fcAvail = firecrawlAdapter.available();
    const cheerioAvail = cheerioAdapter.available();

    if (!exaAvail && !fcAvail && !cheerioAvail) {
      throw new Error(
        "No crawling providers available. Set EXA_API_KEY or FIRECRAWL_API_KEY, or use cheerio provider"
      );
    }

    if (opts.fallback !== false) {
      const tryProvider =
        opts.provider ||
        (cheerioAvail ? "cheerio" : exaAvail ? "exa" : "firecrawl");
      const adapter = getAdapter(tryProvider);
      return adapter.crawlBatch(urls, opts);
    }

    throw new Error(
      `Provider "${opts.provider}" not available and fallback disabled`
    );
  }

  const adapter = getAdapter(provider);

  try {
    const result = await adapter.crawlBatch(urls, opts);
    recordSuccess(provider);
    return result;
  } catch (error) {
    const isRateLimit = (error as RateLimitError)?.isRateLimit || false;

    if (isRateLimit && opts.fallback !== false) {
      recordRateLimit(provider);
      const alternatives: CrawlingProvider[] =
        provider === "exa"
          ? ["firecrawl", "cheerio"]
          : provider === "firecrawl"
          ? ["exa", "cheerio"]
          : ["exa", "firecrawl"];

      for (const alt of alternatives) {
        const altAdapter = getAdapter(alt);
        if (altAdapter.available() && !isRateLimited(alt)) {
          try {
            const result = await altAdapter.crawlBatch(urls, opts);
            recordSuccess(alt);
            return result;
          } catch (fallbackError) {
            const isFallbackRateLimit =
              (fallbackError as RateLimitError)?.isRateLimit || false;
            if (isFallbackRateLimit) {
              recordRateLimit(alt);
            } else {
              recordError(alt);
            }
          }
        }
      }
    } else if (isRateLimit) {
      recordRateLimit(provider);
    } else {
      recordError(provider);
    }

    throw error;
  }
};

/**
 * Get available crawling providers
 */
export const getAvailableCrawlingProviders = (): CrawlingProvider[] => {
  return getAvailableProvidersInternal();
};
