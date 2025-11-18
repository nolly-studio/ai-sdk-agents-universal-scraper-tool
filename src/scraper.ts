/**
 * Unified scraping library
 * Simple, declarative API with great defaults
 *
 * @example
 * import { scrape } from '@/lib/scraping';
 * const result = await scrape('https://example.com');
 */

import Exa from "exa-js";
import Firecrawl from "@mendable/firecrawl-js";
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import DOMPurify from "isomorphic-dompurify";

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

export interface ScrapeBatchResult {
  results: ScrapeResult[];
  statuses?: Array<{
    id: string;
    status: "success" | "error";
    error?: { tag: string; httpStatusCode?: number };
  }>;
}

// Internal types
interface ProviderAdapter {
  name: ScrapingProvider;
  available: () => boolean;
  scrape: (url: string, options: ScrapeOptions) => Promise<ScrapeResult>;
  scrapeBatch: (
    urls: string[],
    options: ScrapeOptions
  ) => Promise<ScrapeBatchResult>;
}

// Error type with rate limit flag
interface RateLimitError extends Error {
  isRateLimit: boolean;
}

// Exa API types
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

// ExaOptions matches the Exa SDK's ContentsOptions type
// Using Record<string, unknown> to be compatible with the SDK
type ExaOptions = Record<string, unknown>;

// Firecrawl API types
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
  [key: string]: unknown;
}

interface FirecrawlResponse {
  data?: FirecrawlResult;
  markdown?: string;
  html?: string;
  metadata?: FirecrawlMetadata;
  [key: string]: unknown;
}

// FirecrawlOptions matches the Firecrawl SDK's ScrapeOptions type
// Using Record<string, unknown> to be compatible with the SDK
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
// Rate Limit State Management
// ============================================================================

const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 1 minute

const createInitialState = (): ProviderState => ({
  available: false,
  rateLimit: {
    isLimited: false,
    errors: 0,
  },
});

const createRateLimitState = (): Record<ScrapingProvider, ProviderState> => ({
  exa: createInitialState(),
  firecrawl: createInitialState(),
  cheerio: createInitialState(),
});

const state = createRateLimitState();

const setAvailable = (provider: ScrapingProvider, available: boolean): void => {
  state[provider].available = available;
};

const recordSuccess = (provider: ScrapingProvider): void => {
  state[provider].lastSuccess = new Date();
  state[provider].rateLimit.isLimited = false;
  state[provider].rateLimit.errors = 0;
};

const recordRateLimit = (provider: ScrapingProvider): void => {
  state[provider].rateLimit.isLimited = true;
  state[provider].rateLimit.errors += 1;
  state[provider].rateLimit.resetAt = new Date(
    Date.now() + RATE_LIMIT_COOLDOWN_MS
  );
};

const recordError = (provider: ScrapingProvider): void => {
  state[provider].rateLimit.errors += 1;
};

const isRateLimited = (provider: ScrapingProvider): boolean => {
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

const getAvailableProvidersInternal = (): ScrapingProvider[] => {
  return (["exa", "firecrawl", "cheerio"] as ScrapingProvider[]).filter((p) => {
    // Check availability dynamically by calling the adapter's available() method
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
  prefer?: ScrapingProvider,
  fallback: boolean = true,
  options?: ScrapeOptions
): ScrapingProvider | null => {
  const available = getAvailableProvidersInternal();

  if (available.length === 0) return null;

  // If html is requested, prefer Firecrawl since it has better HTML support
  if (options?.html && !prefer) {
    if (available.includes("firecrawl")) return "firecrawl";
  }

  if (prefer && available.includes(prefer)) return prefer;

  if (prefer && !fallback) return null;

  // Default priority order: Cheerio > Exa > Firecrawl
  const priorityOrder: ScrapingProvider[] = ["cheerio", "exa", "firecrawl"];

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

const normalizeExaResult = (
  result: ExaResult,
  url: string,
  options?: ScrapeOptions
): ScrapeResult => ({
  url: result.url || url,
  text: result.text || "",
  markdown: result.text,
  html: result.html || (options?.html ? result.text : undefined),
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
          ].includes(key)
      )
    ) as Record<string, unknown>),
  },
  provider: "exa",
});

const normalizeExaStatuses = (
  statuses: ExaStatus[] | undefined
): ScrapeBatchResult["statuses"] => {
  if (!statuses) return undefined;
  return statuses.map((s) => ({
    id: s.id || "",
    status: s.status === "success" ? "success" : "error",
    error: s.error
      ? {
          tag: s.error.tag || "UNKNOWN_ERROR",
          httpStatusCode: s.error.httpStatusCode,
        }
      : undefined,
  }));
};

const buildExaOptions = (options: ScrapeOptions): ExaOptions => {
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

  return exaOptions;
};

const exaAdapter: ProviderAdapter = {
  name: "exa",

  available: () => {
    const apiKey = process.env.EXA_API_KEY;
    return !!apiKey;
  },

  scrape: async (
    url: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> => {
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

      return normalizeExaResult(response.results[0], url, options);
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

  scrapeBatch: async (
    urls: string[],
    options: ScrapeOptions
  ): Promise<ScrapeBatchResult> => {
    const client = createExaClient();
    if (!client) {
      throw new Error("Exa not available: EXA_API_KEY not set");
    }

    try {
      const exaOptions = buildExaOptions(options);
      const response = await client.getContents(urls, exaOptions);

      const results = (response.results || []).map((r: ExaResult) =>
        normalizeExaResult(r, (r.url || "") as string, options)
      );

      return {
        results,
        statuses: normalizeExaStatuses(response.statuses),
      };
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

const normalizeFirecrawlResult = (
  data: FirecrawlResult,
  url: string
): ScrapeResult => ({
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
});

const buildFirecrawlOptions = (options: ScrapeOptions): FirecrawlOptions => {
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

const firecrawlAdapter: ProviderAdapter = {
  name: "firecrawl",

  available: () => {
    const apiKey = process.env.FIRECRAWL_API_KEY || process.env.FC_API_KEY;
    return !!apiKey;
  },

  scrape: async (
    url: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> => {
    const client = createFirecrawlClient();
    if (!client) {
      throw new Error("Firecrawl not available: FIRECRAWL_API_KEY not set");
    }

    try {
      const firecrawlOptions = buildFirecrawlOptions(options);
      const response = await client.scrape(url, firecrawlOptions);

      // Firecrawl SDK returns response with data property, but types may not reflect this
      const firecrawlResponse = response as FirecrawlResponse;
      const data: FirecrawlResult =
        firecrawlResponse.data ||
        ({
          markdown: firecrawlResponse.markdown,
          html: firecrawlResponse.html,
          metadata: firecrawlResponse.metadata,
        } as FirecrawlResult);

      if (!data) {
        throw new Error(`No data from Firecrawl for: ${url}`);
      }

      return normalizeFirecrawlResult(data, url);
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

  scrapeBatch: async (
    urls: string[],
    options: ScrapeOptions
  ): Promise<ScrapeBatchResult> => {
    const client = createFirecrawlClient();
    if (!client) {
      throw new Error("Firecrawl not available: FIRECRAWL_API_KEY not set");
    }

    const results: ScrapeResult[] = [];
    const statuses: ScrapeBatchResult["statuses"] = [];

    for (const url of urls) {
      try {
        const result = await firecrawlAdapter.scrape(url, options);
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

// Initialize turndown service for HTML to markdown conversion
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

const normalizeCheerioResult = (
  html: string,
  url: string,
  options: ScrapeOptions
): ScrapeResult => {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Failed to parse readable content from: ${url}`);
  }

  // Extract metadata using cheerio
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

  // Get HTML content
  let htmlContent = article.content || html;

  // Sanitize HTML content to prevent XSS attacks
  htmlContent = DOMPurify.sanitize(htmlContent, {
    // Allow common HTML elements for readable content
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
    // Keep relative URLs safe
    ALLOW_DATA_ATTR: false,
  });

  // Convert HTML to markdown if markdown is requested
  let markdown: string | undefined;
  if (options.markdown !== false) {
    markdown = turndownService.turndown(htmlContent);
  }

  // Get text content (strip HTML tags)
  let text = article.textContent || "";
  if (options.maxChars && text.length > options.maxChars) {
    text = text.substring(0, options.maxChars);
  }

  // Truncate markdown if maxChars is set
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
  };
};

const cheerioAdapter: ProviderAdapter = {
  name: "cheerio",

  available: () => {
    // Cheerio is always available (no API key needed)
    return true;
  },

  scrape: async (
    url: string,
    options: ScrapeOptions
  ): Promise<ScrapeResult> => {
    try {
      // Validate URL
      new URL(url);

      // Fetch HTML content
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status} for ${url}`);
      }

      const html = await response.text();

      return normalizeCheerioResult(html, url, options);
    } catch (error) {
      if (error instanceof TypeError && error.message.includes("Invalid URL")) {
        throw new Error(`Invalid URL: ${url}`);
      }
      throw error;
    }
  },

  scrapeBatch: async (
    urls: string[],
    options: ScrapeOptions
  ): Promise<ScrapeBatchResult> => {
    const results: ScrapeResult[] = [];
    const statuses: ScrapeBatchResult["statuses"] = [];

    for (const url of urls) {
      try {
        const result = await cheerioAdapter.scrape(url, options);
        results.push(result);
        statuses?.push({ id: url, status: "success" });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const httpStatusCode = /404/.test(msg)
          ? 404
          : /403/.test(msg)
          ? 403
          : undefined;
        statuses?.push({
          id: url,
          status: "error",
          error: {
            tag: "CRAWL_ERROR",
            httpStatusCode,
          },
        });
      }
    }

    return { results, statuses };
  },
};

// ============================================================================
// Main Scraper Logic
// ============================================================================

// Default options - great defaults, no configuration needed
const DEFAULT_OPTIONS: Partial<ScrapeOptions> = {
  fallback: true,
  markdown: true,
  html: false,
};

const adapters = {
  exa: exaAdapter,
  firecrawl: firecrawlAdapter,
  cheerio: cheerioAdapter,
};

// Initialize provider availability
const initProviders = () => {
  setAvailable("exa", exaAdapter.available());
  setAvailable("firecrawl", firecrawlAdapter.available());
  setAvailable("cheerio", cheerioAdapter.available());
};

initProviders();

const getAdapter = (provider: ScrapingProvider) => adapters[provider];

const tryWithFallback = async (
  url: string,
  options: ScrapeOptions,
  provider: ScrapingProvider
): Promise<ScrapeResult> => {
  const adapter = getAdapter(provider);

  try {
    const result = await adapter.scrape(url, options);
    recordSuccess(provider);
    return result;
  } catch (error) {
    const isRateLimit = (error as RateLimitError)?.isRateLimit || false;

    if (isRateLimit) {
      recordRateLimit(provider);

      if (options.fallback !== false) {
        // Try alternative providers in order of preference
        const alternatives: ScrapingProvider[] =
          provider === "exa"
            ? ["firecrawl", "cheerio"]
            : provider === "firecrawl"
            ? ["exa", "cheerio"]
            : ["exa", "firecrawl"];

        for (const alt of alternatives) {
          const altAdapter = getAdapter(alt);
          if (altAdapter.available() && !isRateLimited(alt)) {
            try {
              const result = await altAdapter.scrape(url, options);
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
              // Continue to next alternative
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
 * Scrape a URL
 * Simple API: just pass a URL, everything else has great defaults
 *
 * @example
 * const result = await scrape("https://example.com");
 * console.log(result.text);
 */
export const scrape = async (
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapeResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const provider = selectProvider(opts.provider, opts.fallback !== false, opts);

  if (!provider) {
    const exaAvail = exaAdapter.available();
    const fcAvail = firecrawlAdapter.available();

    const cheerioAvail = cheerioAdapter.available();
    if (!exaAvail && !fcAvail && !cheerioAvail) {
      throw new Error(
        "No scraping providers available. Set EXA_API_KEY or FIRECRAWL_API_KEY, or use cheerio provider"
      );
    }

    // Try anyway if fallback enabled
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
 * Scrape multiple URLs
 *
 * @example
 * const results = await scrapeBatch(["https://example.com", "https://example.org"]);
 */
export const scrapeBatch = async (
  urls: string[],
  options: ScrapeOptions = {}
): Promise<ScrapeBatchResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const provider = selectProvider(opts.provider, opts.fallback !== false, opts);

  if (!provider) {
    const exaAvail = exaAdapter.available();
    const fcAvail = firecrawlAdapter.available();
    const cheerioAvail = cheerioAdapter.available();

    if (!exaAvail && !fcAvail && !cheerioAvail) {
      throw new Error(
        "No scraping providers available. Set EXA_API_KEY or FIRECRAWL_API_KEY, or use cheerio provider"
      );
    }

    if (opts.fallback !== false) {
      const tryProvider =
        opts.provider ||
        (cheerioAvail ? "cheerio" : exaAvail ? "exa" : "firecrawl");
      const adapter = getAdapter(tryProvider);
      return adapter.scrapeBatch(urls, opts);
    }

    throw new Error(
      `Provider "${opts.provider}" not available and fallback disabled`
    );
  }

  const adapter = getAdapter(provider);

  try {
    const result = await adapter.scrapeBatch(urls, opts);
    recordSuccess(provider);
    return result;
  } catch (error) {
    const isRateLimit = (error as RateLimitError)?.isRateLimit || false;

    if (isRateLimit && opts.fallback !== false) {
      recordRateLimit(provider);
      // Try alternative providers in order of preference
      const alternatives: ScrapingProvider[] =
        provider === "exa"
          ? ["firecrawl", "cheerio"]
          : provider === "firecrawl"
          ? ["exa", "cheerio"]
          : ["exa", "firecrawl"];

      for (const alt of alternatives) {
        const altAdapter = getAdapter(alt);
        if (altAdapter.available() && !isRateLimited(alt)) {
          try {
            const result = await altAdapter.scrapeBatch(urls, opts);
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
            // Continue to next alternative
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
 * Get available providers
 */
export const getAvailableProviders = (): ScrapingProvider[] => {
  return getAvailableProvidersInternal();
};
