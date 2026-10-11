import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyIntent, extractEntities } from "../src/router/intent.js";

describe("intent classifier", () => {
  const cases: [string, string, string[]][] = [
    ["What happened on Robinhood Chain today?", "onchain", ["onchain", "market", "news"]],
    ["Analyze this GitHub repo https://github.com/honojs/hono", "github", ["github"]],
    ["Deep research this company: Anthropic", "research", ["research"]],
    ["What is this website about? https://example.com/about", "web_extract", ["web_extract"]],
    ["What's the price and liquidity of $HOOD?", "market", ["market"]],
    ["Summarize the following paragraph: lorem ipsum", "summarize", ["summarize"]],
    ["Why does my TypeScript function throw an exception?", "coding", ["coding"]],
    ["Tell me a joke", "general", ["general"]],
  ];

  for (const [text, primary, mustInclude] of cases) {
    it(`"${text}" → ${primary}`, () => {
      const result = classifyIntent(text);
      assert.equal(result.primary, primary, `got ${result.intents.join(",")} (${result.signals.join("; ")})`);
      for (const i of mustInclude) assert.ok(result.intents.includes(i as never), `missing ${i}: ${result.intents}`);
    });
  }

  it("does not add coding for GitHub questions", () => {
    assert.ok(!classifyIntent("Explain the code in github.com/a/b").intents.includes("coding"));
  });

  it("research mode forces research", () => {
    assert.equal(classifyIntent("tokenized assets", { forceResearch: true }).primary, "research");
  });
});

describe("entity extraction", () => {
  it("distinguishes tx hashes from addresses", () => {
    const tx = `0x${"a".repeat(64)}`;
    const addr = `0x${"B".repeat(40)}`;
    const e = extractEntities(`look at ${tx} from ${addr}`);
    assert.deepEqual(e.txHashes, [tx]);
    assert.deepEqual(e.addresses, [addr.toLowerCase()]);
  });

  it("parses GitHub repos and strips trailing punctuation from URLs", () => {
    const e = extractEntities("see https://github.com/owner/repo.git, and https://x.com/page.");
    assert.deepEqual(e.githubRepos, [{ owner: "owner", repo: "repo" }]);
    assert.ok(e.urls.includes("https://x.com/page"));
  });
});
