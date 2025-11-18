import { gateway, stepCountIs, ToolLoopAgent } from "ai";
import { createCrawlTool } from "./crawler-tool";

async function main() {
  // Option 1: Use default tool instance directly (backward compatible)
  // const tool = scrapeTool;

  // Option 2: Create tool with custom defaults
  const tool = createCrawlTool({
    // defaultProvider: "firecrawl",
    defaultMaxChars: 200,
  });

  const agent = new ToolLoopAgent({
    model: gateway("anthropic/claude-haiku-4.5"),
    instructions:
      "You have the following tools available: crawlTool. Use them to answer the user's question.",
    tools: {
      crawlTool: tool,
    },
    stopWhen: stepCountIs(2),
  });

  const { text, steps } = await agent.generate({
    messages: [
      {
        role: "user",
        content: "Learn about https://aisdkagents.com",
      },
    ],
  });

  console.log("Result:", text);
  console.log("\n--- Tool Steps ---");
  console.dir(steps, { depth: null });
  const allToolCalls = steps?.flatMap((step: any) => step.toolCalls) || [];
  console.log("\n--- All Tool Calls ---");
  console.dir(allToolCalls, { depth: null });
  const allToolResults = steps?.flatMap((step: any) => step.toolResults) || [];
  console.log("\n--- All Tool Results ---");
  console.dir(allToolResults, { depth: null });
}

main().catch(console.error);
