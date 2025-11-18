# AI SDK Robust Scraping + Crawling Tool

A TypeScript package providing robust web scraping and crawling tools for AI SDK agents. Supports multiple providers (Exa, Firecrawl, Cheerio) with automatic fallback on rate limits.

## Installation

```bash
npm install ai-sdk-agents-universal-scraper-tool
```

## Usage

### Basic Scraping

```typescript
import { scrapeTool } from "ai-sdk-agents-universal-scraper-tool";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Scrape and summarize the content from https://example.com",
  tools: {
    scrapeTool,
  },
});
```

### Custom Scraping Tool

```typescript
import { createScrapeTool } from "ai-sdk-agents-universal-scraper-tool";

// Create a tool with default provider and settings
const customScrapeTool = createScrapeTool({
  defaultProvider: "exa",
  defaultMaxChars: 5000,
  defaultMarkdown: true,
});
```

### Crawling with Subpage Discovery

```typescript
import {
  crawlTool,
  crawlBatchTool,
} from "ai-sdk-agents-universal-scraper-tool";

// Crawl a single page with subpage discovery
const crawlResult = await crawlTool.execute({
  url: "https://example.com",
  maxSubpages: 5,
  maxDepth: 2,
});

// Crawl multiple URLs in batch
const batchResult = await crawlBatchTool.execute({
  urls: ["https://example.com", "https://another.com"],
  maxSubpages: 3,
});
```

### Features

- **Multiple Providers**: Supports Exa, Firecrawl, and Cheerio
- **Automatic Fallback**: Automatically falls back to alternative providers on rate limits
- **Flexible Output**: Returns markdown, HTML, or plain text
- **Subpage Discovery**: Crawl tools can discover and crawl linked subpages
- **Configurable**: Customize defaults for provider, max characters, format, and more

## Development

### Setup

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Create a `.env.local` file with your API keys:

```bash
# Exa API key (optional)
EXA_API_KEY=your_exa_api_key

# Firecrawl API key (optional)
FIRECRAWL_API_KEY=your_firecrawl_api_key
```

Note: The tools will automatically fall back to Cheerio (no API key required) if other providers are unavailable.

### Testing

Test your tool locally:

```bash
pnpm test
```

### Building

Build the package:

```bash
pnpm build
```

### Publishing

Before publishing, update the package name in `package.json` to your desired package name.

The package automatically builds before publishing:

```bash
pnpm publish
```

## Project structure

```
.
├── src/
│   ├── index.ts           # Tool exports
│   ├── scraper-tool.ts    # Scraping tool implementation
│   ├── crawler-tool.ts    # Crawling tool implementation
│   ├── scraper.ts         # Scraping logic
│   ├── crawler.ts         # Crawling logic
│   └── *.test.ts          # Test files
├── dist/                  # Build output (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Exported Tools

- `scrapeTool` - Default scraping tool instance
- `createScrapeTool()` - Create a custom scraping tool with defaults
- `crawlTool` - Default crawling tool instance (single URL)
- `createCrawlTool()` - Create a custom crawling tool with defaults
- `crawlBatchTool` - Default batch crawling tool instance (multiple URLs)
- `createCrawlBatchTool()` - Create a custom batch crawling tool with defaults

## Providers

### Exa

- Requires `EXA_API_KEY` environment variable
- Supports live crawling with configurable preferences
- High-quality content extraction

### Firecrawl

- Requires `FIRECRAWL_API_KEY` environment variable
- Supports caching with configurable max age
- Good for structured content extraction

### Cheerio

- No API key required (local processing)
- Fast and reliable fallback option
- Supports subpage crawling with configurable concurrency

## License

ISC
