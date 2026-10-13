import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { createContainer } from "../src/container.js";
import { silentLogger } from "../src/core/logger.js";
import { ProviderRegistry } from "../src/providers/llm/registry.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FakeProvider, testEnv } from "./helpers.js";

function app() {
  const providers = new ProviderRegistry().register(new FakeProvider("groq"));
  return createApp(createContainer(testEnv({ GROQ_API_KEY: "gsk_supersecret" }), { logger: silentLogger, providers, tools: new ToolRegistry() }));
}

describe("landing page (static web/)", () => {
  it("serves the landing page and its assets", async () => {
    const a = app();
    const home = await a.request("/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await home.text(), /<title>TILIK<\/title>/);
    assert.equal((await a.request("/app.js")).status, 200);
    assert.equal((await a.request("/styles.css")).status, 200);
  });

  it("never serves files outside web/ (.env, sources, package.json, traversal)", async () => {
    const a = app();
    for (const path of ["/.env", "/.env.example", "/../.env", "/%2e%2e/.env", "/..%2f.env", "/package.json", "/../package.json", "/src/config/env.ts", "/dist/index.js", "/.git/config"]) {
      assert.equal((await a.request(path)).status, 404, path);
    }
  });

  it("serves /chat/<conversationId> deep links as the app page, without touching the POST /chat API", async () => {
    const a = app();
    const deep = await a.request("/chat/3f2c9a1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f");
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /<title>TILIK<\/title>/);
    assert.equal((await a.request("/chat/../../.env")).status, 404);
    assert.equal((await a.request("/chat/has.dots")).status, 404);
    const api = await a.request("/chat", { method: "POST", body: JSON.stringify({ message: "hi" }), headers: { "content-type": "application/json" } });
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
  });

  it("deep links stay public even when VEYRA_API_KEY protects the /chat API", async () => {
    const providers = new ProviderRegistry().register(new FakeProvider("groq"));
    const a = createApp(createContainer(testEnv({ VEYRA_API_KEY: "secret" }), { logger: silentLogger, providers, tools: new ToolRegistry() }));
    assert.equal((await a.request("/chat/abc123")).status, 200);
    assert.equal((await a.request("/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) })).status, 401);
  });

  it("serves the docs page at /docs with its assets", async () => {
    const a = app();
    const docs = await a.request("/docs");
    assert.equal(docs.status, 200);
    assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await docs.text(), /<title>TILIK Docs<\/title>/);
    assert.equal((await a.request("/docs.js")).status, 200);
    assert.equal((await a.request("/docs.css")).status, 200);
    assert.equal((await a.request("/docs/../.env")).status, 404);
  });

  it("the frontend bundle contains no secrets or server configuration", async () => {
    const a = app();
    for (const path of ["/", "/app.js", "/styles.css", "/conversations.js", "/docs", "/docs.js", "/docs.css"]) {
      const text = await (await a.request(path)).text();
      assert.ok(!text.includes("gsk_supersecret"), path);
      assert.doesNotMatch(text, /process\.env|_API_KEY|GITHUB_TOKEN|You are TILIK/, path);
    }
  });
});
