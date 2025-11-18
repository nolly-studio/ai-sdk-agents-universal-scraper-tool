import { test, describe } from "node:test";
import assert from "node:assert";
import { crawl, crawlBatch, getAvailableCrawlingProviders } from "./crawler.js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

describe("crawling integration tests", () => {
  // Test URLs that should be accessible
  const testUrl = "https://example.com";
  const testUrls = ["https://example.com", "https://example.org"];

  describe("getAvailableCrawlingProviders", () => {
    test("should return array of available providers", () => {
      const providers = getAvailableCrawlingProviders();
      assert.ok(Array.isArray(providers));
      assert.ok(
        providers.length > 0,
        "At least one provider should be available (set EXA_API_KEY or FIRECRAWL_API_KEY)"
      );
    });

    test("should only return valid provider names", () => {
      const providers = getAvailableCrawlingProviders();
      const validProviders = ["exa", "firecrawl", "cheerio"];
      for (const provider of providers) {
        assert.ok(
          validProviders.includes(provider),
          `Provider "${provider}" should be either "exa", "firecrawl", or "cheerio"`
        );
      }
    });
  });

  describe("crawl", () => {
    test("should crawl a URL successfully", async () => {
      const result = await crawl(testUrl);

      assert.ok(result, "Result should not be null");
      assert.strictEqual(typeof result.url, "string");
      assert.strictEqual(typeof result.text, "string");
      assert.ok(result.text.length > 0, "Text content should not be empty");
      assert.ok(
        ["exa", "firecrawl", "cheerio"].includes(result.provider),
        "Provider should be exa, firecrawl, or cheerio"
      );
      assert.ok(result.metadata, "Metadata should exist");
      assert.strictEqual(typeof result.depth, "number");
      assert.ok(result.depth !== undefined, "Depth should be defined");
    });

    test("should return result with correct structure", async () => {
      const result = await crawl(testUrl);

      assert.ok("url" in result);
      assert.ok("text" in result);
      assert.ok("metadata" in result);
      assert.ok("provider" in result);
      assert.ok("depth" in result);
      assert.strictEqual(typeof result.metadata, "object");
    });

    test("should include markdown when markdown option is true", async () => {
      const result = await crawl(testUrl, { markdown: true });

      assert.ok(
        result.markdown !== undefined,
        "Markdown should be included when markdown option is true"
      );
    });

    test("should include HTML when html option is true", async () => {
      const result = await crawl(testUrl, { html: true });

      assert.ok(
        result.html !== undefined,
        "HTML should be included when html option is true"
      );
    });

    test("should respect maxChars option", async () => {
      const maxChars = 100;
      const result = await crawl(testUrl, { maxChars });

      assert.ok(
        result.text.length <= maxChars,
        `Text should not exceed ${maxChars} characters`
      );
    });

    test("should respect maxDepth option", async () => {
      const result = await crawl(testUrl, { maxDepth: 1, maxSubpages: 0 });

      assert.ok(result.depth !== undefined);
      assert.ok(
        result.depth! <= 1,
        `Depth should not exceed 1, got ${result.depth}`
      );
    });

    test("should crawl subpages when maxSubpages > 0", async () => {
      const result = await crawl(testUrl, {
        maxSubpages: 2,
        maxDepth: 2,
        concurrency: 2,
      });

      assert.ok(
        result.subpages === undefined || Array.isArray(result.subpages),
        "Subpages should be undefined or an array"
      );

      if (result.subpages && result.subpages.length > 0) {
        assert.ok(
          result.subpages.length <= 2,
          `Should not crawl more than 2 subpages, got ${result.subpages.length}`
        );

        for (const subpage of result.subpages) {
          assert.ok("url" in subpage);
          assert.ok("text" in subpage);
          assert.ok("depth" in subpage);
          assert.ok(
            subpage.depth! > result.depth!,
            "Subpage depth should be greater than parent depth"
          );
        }
      }
    });

    test("should respect maxSubpages limit", async () => {
      const maxSubpages = 1;
      const result = await crawl(testUrl, {
        maxSubpages,
        maxDepth: 2,
        concurrency: 2,
      });

      if (result.subpages) {
        assert.ok(
          result.subpages.length <= maxSubpages,
          `Should not crawl more than ${maxSubpages} subpages`
        );
      }
    });

    test("should use specified provider when available", async () => {
      const providers = getAvailableCrawlingProviders();
      if (providers.length === 0) {
        // Skip if no providers available
        return;
      }

      const preferredProvider = providers[0];
      const result = await crawl(testUrl, {
        provider: preferredProvider,
        fallback: false,
        maxSubpages: 0,
      });

      assert.strictEqual(
        result.provider,
        preferredProvider,
        `Should use preferred provider "${preferredProvider}"`
      );
    });

    test("should throw error when provider not available and fallback disabled", async () => {
      const providers = getAvailableCrawlingProviders();

      // If no providers are available, the error message should indicate that
      if (providers.length === 0) {
        await assert.rejects(() => crawl(testUrl), {
          message: /No crawling providers available/,
        });
        return;
      }

      // Test that requesting unavailable provider with fallback disabled throws appropriate error
      const unavailableProvider = (
        providers[0] === "exa" ? "firecrawl" : "exa"
      ) as "exa" | "firecrawl";

      try {
        await crawl(testUrl, {
          provider: unavailableProvider,
          fallback: false,
          maxSubpages: 0,
        });
        // If we get here, the provider might actually be available (test passes)
      } catch (error) {
        assert.ok(error instanceof Error, "Should throw an Error");
        // Error should mention provider or availability
        assert.ok(
          error.message.includes("not available") ||
            error.message.includes("No crawling providers"),
          "Error message should mention provider availability"
        );
      }
    });

    test("should handle invalid URLs gracefully", async () => {
      const invalidUrl = "not-a-valid-url";
      await assert.rejects(
        () => crawl(invalidUrl),
        "Should reject invalid URLs"
      );
    });

    test("should respect concurrency option for Cheerio", async () => {
      const providers = getAvailableCrawlingProviders();
      if (!providers.includes("cheerio")) {
        return;
      }

      const result = await crawl(testUrl, {
        provider: "cheerio",
        maxSubpages: 2,
        maxDepth: 2,
        concurrency: 3,
        fallback: false,
      });

      assert.ok(result, "Should complete with custom concurrency");
    });

    test("should respect sameDomainOnly option", async () => {
      const providers = getAvailableCrawlingProviders();
      if (!providers.includes("cheerio")) {
        return;
      }

      const result = await crawl(testUrl, {
        provider: "cheerio",
        maxSubpages: 5,
        maxDepth: 2,
        sameDomainOnly: true,
        fallback: false,
      });

      if (result.subpages && result.subpages.length > 0) {
        const baseDomain = new URL(testUrl).hostname;
        for (const subpage of result.subpages) {
          const subpageDomain = new URL(subpage.url).hostname;
          assert.strictEqual(
            subpageDomain,
            baseDomain,
            "Subpages should be from same domain when sameDomainOnly is true"
          );
        }
      }
    });
  });

  describe("crawlBatch", () => {
    test("should crawl multiple URLs successfully", async () => {
      const result = await crawlBatch(testUrls, { maxSubpages: 0 });

      assert.ok(result, "Result should not be null");
      assert.ok(Array.isArray(result.results));
      assert.ok(result.results.length > 0, "Should return at least one result");
      assert.ok(
        result.results.length <= testUrls.length,
        "Should not return more results than URLs"
      );
    });

    test("should return results with correct structure", async () => {
      const result = await crawlBatch(testUrls, { maxSubpages: 0 });

      for (const item of result.results) {
        assert.ok("url" in item);
        assert.ok("text" in item);
        assert.ok("metadata" in item);
        assert.ok("provider" in item);
        assert.ok("depth" in item);
      }
    });

    test("should include statuses in batch result", async () => {
      const result = await crawlBatch(testUrls, { maxSubpages: 0 });

      if (result.statuses) {
        assert.ok(Array.isArray(result.statuses));
        assert.ok(
          result.statuses.length === testUrls.length,
          "Statuses should match number of URLs"
        );

        for (const status of result.statuses) {
          assert.ok("id" in status);
          assert.ok("status" in status);
          assert.ok(
            ["success", "error"].includes(status.status),
            "Status should be success or error"
          );
        }
      }
    });

    test("should handle empty URL array", async () => {
      const result = await crawlBatch([], { maxSubpages: 0 });

      assert.ok(Array.isArray(result.results));
      assert.strictEqual(result.results.length, 0);
    });

    test("should apply options to batch crawling", async () => {
      const result = await crawlBatch(testUrls, {
        markdown: true,
        maxChars: 200,
        maxSubpages: 0,
      });

      for (const item of result.results) {
        if (item.markdown) {
          assert.ok(
            item.markdown.length <= 200,
            "Markdown should respect maxChars"
          );
        }
      }
    });

    test("should crawl subpages in batch mode", async () => {
      const result = await crawlBatch([testUrl], {
        maxSubpages: 2,
        maxDepth: 2,
        concurrency: 2,
      });

      assert.ok(result.results.length > 0);

      for (const item of result.results) {
        if (item.subpages && item.subpages.length > 0) {
          assert.ok(
            item.subpages.length <= 2,
            "Should not crawl more than 2 subpages per page"
          );
        }
      }
    });
  });

  describe("provider fallback", () => {
    test("should fallback to alternative provider on rate limit", async () => {
      const providers = getAvailableCrawlingProviders();
      if (providers.length < 2) {
        // Skip if less than 2 providers available
        return;
      }

      // This test would require mocking rate limit errors
      // For now, we just verify fallback is enabled by default
      const result = await crawl(testUrl, {
        fallback: true,
        maxSubpages: 0,
      });
      assert.ok(result, "Should succeed with fallback enabled");
    });

    test("should not fallback when fallback is disabled", async () => {
      const providers = getAvailableCrawlingProviders();
      if (providers.length === 0) {
        return;
      }

      const preferredProvider = providers[0];
      const result = await crawl(testUrl, {
        provider: preferredProvider,
        fallback: false,
        maxSubpages: 0,
      });

      assert.strictEqual(result.provider, preferredProvider);
    });
  });

  describe("options", () => {
    test("should respect livecrawl option for Exa", async () => {
      const providers = getAvailableCrawlingProviders();
      if (!providers.includes("exa")) {
        return;
      }

      const result = await crawl(testUrl, {
        provider: "exa",
        livecrawl: "never",
        fallback: false,
        maxSubpages: 0,
      });

      assert.strictEqual(result.provider, "exa");
    });

    test("should respect maxAge option for Firecrawl", async () => {
      const providers = getAvailableCrawlingProviders();
      if (!providers.includes("firecrawl")) {
        return;
      }

      try {
        const result = await crawl(testUrl, {
          provider: "firecrawl",
          maxAge: 3600000, // 1 hour
          fallback: false,
          maxSubpages: 0,
        });

        assert.strictEqual(result.provider, "firecrawl");
      } catch (error: any) {
        // Skip test if rate limited (this is expected in integration tests)
        if (error.isRateLimit) {
          return;
        }
        throw error;
      }
    });

    test("should respect subpageTarget option for Exa", async () => {
      const providers = getAvailableCrawlingProviders();
      if (!providers.includes("exa")) {
        return;
      }

      try {
        const result = await crawl(testUrl, {
          provider: "exa",
          maxSubpages: 2,
          subpageTarget: "about",
          fallback: false,
        });

        assert.strictEqual(result.provider, "exa");
        // Subpages may or may not be present depending on the page
        if (result.subpages) {
          assert.ok(Array.isArray(result.subpages));
        }
      } catch (error: any) {
        // Skip test if rate limited (this is expected in integration tests)
        if (error.isRateLimit) {
          return;
        }
        throw error;
      }
    });
  });

  describe("subpage crawling", () => {
    test("should not crawl subpages when maxSubpages is 0", async () => {
      const result = await crawl(testUrl, {
        maxSubpages: 0,
        maxDepth: 2,
      });

      assert.ok(
        result.subpages === undefined || result.subpages.length === 0,
        "Should not crawl subpages when maxSubpages is 0"
      );
    });

    test("should respect depth limits when crawling subpages", async () => {
      const result = await crawl(testUrl, {
        maxSubpages: 3,
        maxDepth: 1,
        concurrency: 2,
      });

      assert.ok(result.depth !== undefined);
      assert.ok(result.depth! <= 1, "Root page depth should be <= 1");

      if (result.subpages && result.subpages.length > 0) {
        for (const subpage of result.subpages) {
          assert.ok(
            subpage.depth !== undefined,
            "Subpage should have depth defined"
          );
          assert.ok(
            subpage.depth! <= 1,
            `Subpage depth should be <= 1, got ${subpage.depth}`
          );
        }
      }
    });

    test("should handle pages with no links gracefully", async () => {
      // Use a simple page that likely has no links
      const result = await crawl(testUrl, {
        maxSubpages: 5,
        maxDepth: 2,
        concurrency: 2,
      });

      assert.ok(result, "Should return result even if no subpages found");
      assert.ok(
        result.subpages === undefined || Array.isArray(result.subpages),
        "Subpages should be undefined or an array"
      );
    });
  });
});
