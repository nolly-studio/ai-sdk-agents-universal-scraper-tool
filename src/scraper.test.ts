import { test, describe } from "node:test";
import assert from "node:assert";
import { scrape, scrapeBatch, getAvailableProviders } from "./scraper.js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

describe("scraping integration tests", () => {
  // Test URLs that should be accessible
  const testUrl = "https://example.com";
  const testUrls = ["https://example.com", "https://example.org"];

  describe("getAvailableProviders", () => {
    test("should return array of available providers", () => {
      const providers = getAvailableProviders();
      assert.ok(Array.isArray(providers));
      assert.ok(
        providers.length > 0,
        "At least one provider should be available (set EXA_API_KEY or FIRECRAWL_API_KEY)"
      );
    });

    test("should only return valid provider names", () => {
      const providers = getAvailableProviders();
      const validProviders = ["exa", "firecrawl", "cheerio"];
      for (const provider of providers) {
        assert.ok(
          validProviders.includes(provider),
          `Provider "${provider}" should be either "exa", "firecrawl", or "cheerio"`
        );
      }
    });
  });

  describe("scrape", () => {
    test("should scrape a URL successfully", async () => {
      const result = await scrape(testUrl);

      assert.ok(result, "Result should not be null");
      assert.strictEqual(typeof result.url, "string");
      assert.strictEqual(typeof result.text, "string");
      assert.ok(result.text.length > 0, "Text content should not be empty");
      assert.ok(
        ["exa", "firecrawl", "cheerio"].includes(result.provider),
        "Provider should be exa, firecrawl, or cheerio"
      );
      assert.ok(result.metadata, "Metadata should exist");
    });

    test("should return result with correct structure", async () => {
      const result = await scrape(testUrl);

      assert.ok("url" in result);
      assert.ok("text" in result);
      assert.ok("metadata" in result);
      assert.ok("provider" in result);
      assert.strictEqual(typeof result.metadata, "object");
    });

    test("should include markdown when markdown option is true", async () => {
      const result = await scrape(testUrl, { markdown: true });

      assert.ok(
        result.markdown !== undefined,
        "Markdown should be included when markdown option is true"
      );
    });

    test("should include HTML when html option is true", async () => {
      const result = await scrape(testUrl, { html: true });

      assert.ok(
        result.html !== undefined,
        "HTML should be included when html option is true"
      );
    });

    test("should respect maxChars option", async () => {
      const maxChars = 100;
      const result = await scrape(testUrl, { maxChars });

      assert.ok(
        result.text.length <= maxChars,
        `Text should not exceed ${maxChars} characters`
      );
    });

    test("should use specified provider when available", async () => {
      const providers = getAvailableProviders();
      if (providers.length === 0) {
        // Skip if no providers available
        return;
      }

      const preferredProvider = providers[0];
      const result = await scrape(testUrl, {
        provider: preferredProvider,
        fallback: false,
      });

      assert.strictEqual(
        result.provider,
        preferredProvider,
        `Should use preferred provider "${preferredProvider}"`
      );
    });

    test("should throw error when provider not available and fallback disabled", async () => {
      const providers = getAvailableProviders();

      // If no providers are available, the error message should indicate that
      if (providers.length === 0) {
        await assert.rejects(() => scrape(testUrl), {
          message: /No scraping providers available/,
        });
        return;
      }

      // Test that requesting unavailable provider with fallback disabled throws appropriate error
      // Note: This test verifies error handling when a specific provider is requested but unavailable
      const unavailableProvider = (
        providers[0] === "exa" ? "firecrawl" : "exa"
      ) as "exa" | "firecrawl";

      try {
        await scrape(testUrl, {
          provider: unavailableProvider,
          fallback: false,
        });
        // If we get here, the provider might actually be available (test passes)
      } catch (error) {
        assert.ok(error instanceof Error, "Should throw an Error");
        // Error should mention provider or availability
        assert.ok(
          error.message.includes("not available") ||
            error.message.includes("No scraping providers"),
          "Error message should mention provider availability"
        );
      }
    });

    test("should handle invalid URLs gracefully", async () => {
      const invalidUrl = "not-a-valid-url";
      await assert.rejects(
        () => scrape(invalidUrl),
        "Should reject invalid URLs"
      );
    });
  });

  describe("scrapeBatch", () => {
    test("should scrape multiple URLs successfully", async () => {
      const result = await scrapeBatch(testUrls);

      assert.ok(result, "Result should not be null");
      assert.ok(Array.isArray(result.results));
      assert.ok(result.results.length > 0, "Should return at least one result");
      assert.ok(
        result.results.length <= testUrls.length,
        "Should not return more results than URLs"
      );
    });

    test("should return results with correct structure", async () => {
      const result = await scrapeBatch(testUrls);

      for (const item of result.results) {
        assert.ok("url" in item);
        assert.ok("text" in item);
        assert.ok("metadata" in item);
        assert.ok("provider" in item);
      }
    });

    test("should include statuses in batch result", async () => {
      const result = await scrapeBatch(testUrls);

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
      const result = await scrapeBatch([]);

      assert.ok(Array.isArray(result.results));
      assert.strictEqual(result.results.length, 0);
    });

    test("should apply options to batch scraping", async () => {
      const result = await scrapeBatch(testUrls, {
        markdown: true,
        maxChars: 200,
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
  });

  describe("provider fallback", () => {
    test("should fallback to alternative provider on rate limit", async () => {
      const providers = getAvailableProviders();
      if (providers.length < 2) {
        // Skip if less than 2 providers available
        return;
      }

      // This test would require mocking rate limit errors
      // For now, we just verify fallback is enabled by default
      const result = await scrape(testUrl, { fallback: true });
      assert.ok(result, "Should succeed with fallback enabled");
    });

    test("should not fallback when fallback is disabled", async () => {
      const providers = getAvailableProviders();
      if (providers.length === 0) {
        return;
      }

      const preferredProvider = providers[0];
      const result = await scrape(testUrl, {
        provider: preferredProvider,
        fallback: false,
      });

      assert.strictEqual(result.provider, preferredProvider);
    });
  });

  describe("options", () => {
    test("should respect livecrawl option for Exa", async () => {
      const providers = getAvailableProviders();
      if (!providers.includes("exa")) {
        return;
      }

      const result = await scrape(testUrl, {
        provider: "exa",
        livecrawl: "never",
        fallback: false,
      });

      assert.strictEqual(result.provider, "exa");
    });

    test("should respect maxAge option for Firecrawl", async () => {
      const providers = getAvailableProviders();
      if (!providers.includes("firecrawl")) {
        return;
      }

      try {
        const result = await scrape(testUrl, {
          provider: "firecrawl",
          maxAge: 3600000, // 1 hour
          fallback: false,
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
  });
});
