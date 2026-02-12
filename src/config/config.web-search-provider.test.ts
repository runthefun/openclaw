import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-key",
              baseUrl: "https://api.perplexity.ai",
              model: "perplexity/sonar-pro",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts exa provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "exa",
            exa: {
              apiKey: "test-key",
              numResults: 10,
              type: "neural",
              useAutoprompt: true,
              category: "news",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
