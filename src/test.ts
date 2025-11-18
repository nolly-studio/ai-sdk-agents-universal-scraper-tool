import { gateway, generateText, stepCountIs } from "ai";
import { scrapeTool } from "./index";

async function main() {
  const result = await generateText({
    model: gateway("openai/gpt-4o-mini"),
    prompt:
      "Scrape https://aisdkagents.com and tell me what the page title is and summarize the main content.",
    tools: {
      scrapeTool,
    },
    stopWhen: stepCountIs(5),
  });

  console.log("Result:", result.text);
  console.log("\n--- Tool Steps ---");
  console.dir(result.steps, { depth: null });
}

main().catch(console.error);
