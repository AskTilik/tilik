import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { configStatus, secretValues } from "../src/config/env.js";
import { VeyraError } from "../src/core/errors.js";
import { createGroqProvider } from "../src/providers/llm/groq.js";
import { jsonResponse, mockFetch, testEnv } from "./helpers.js";

const MAIN = "gsk_mainkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BACKUP = "gsk_backupkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ok = (text = "hello") => jsonResponse({ model: "openai/gpt-oss-120b", choices: [{ message: { content: text }, finish_reason: "stop" }] });
const req = { model: "openai/gpt-oss-120b", messages: [{ role: "user" as const, content: "hi" }] };
const keyOf = (headers: Record<string, string>) => headers.authorization?.replace("Bearer ", "");

let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => net?.restore());

describe("Groq backup key (GROQ_API_KEY_BACKUP)", () => {
  it("uses the main key when it works; the backup is never touched", async () => {
    net = mockFetch(() => ok());
    const p = createGroqProvider(testEnv({ GROQ_API_KEY: MAIN, GROQ_API_KEY_BACKUP: BACKUP }));
    await p.generate(req);
    assert.deepEqual(net.calls.map((c) => keyOf(c.headers)), [MAIN]);
  });

  it("main key rejected (401) → one retry with the backup, then the backup is used directly for a while", async () => {
    net = mockFetch((_u, _b, init) => ((init.headers as Record<string, string>).Authorization === `Bearer ${MAIN}` ? jsonResponse({ error: { message: "Invalid API Key" } }, 401) : ok("from backup")));
    const p = createGroqProvider(testEnv({ GROQ_API_KEY: MAIN, GROQ_API_KEY_BACKUP: BACKUP }));
    assert.equal((await p.generate(req)).text, "from backup");
    assert.deepEqual(net.calls.map((c) => keyOf(c.headers)), [MAIN, BACKUP]);
    await p.generate(req);
    assert.deepEqual(net.calls.map((c) => keyOf(c.headers)), [MAIN, BACKUP, BACKUP], "rejected main key is skipped next time");
  });

  it("streaming switches keys the same way (before the first token)", async () => {
    net = mockFetch((_u, _b, init) =>
      (init.headers as Record<string, string>).Authorization === `Bearer ${MAIN}`
        ? jsonResponse({ error: { message: "revoked" } }, 401)
        : new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 }),
    );
    const p = createGroqProvider(testEnv({ GROQ_API_KEY: MAIN, GROQ_API_KEY_BACKUP: BACKUP }));
    const text: string[] = [];
    for await (const e of p.stream(req)) if (e.type === "delta") text.push(e.text);
    assert.deepEqual(text, ["hi"]);
    assert.deepEqual(net.calls.map((c) => keyOf(c.headers)), [MAIN, BACKUP]);
  });

  it("rate limits do NOT switch keys (other providers handle those), and nothing loops", async () => {
    net = mockFetch(() => jsonResponse({ error: { message: "Rate limit reached" } }, 429));
    const p = createGroqProvider(testEnv({ GROQ_API_KEY: MAIN, GROQ_API_KEY_BACKUP: BACKUP }));
    await assert.rejects(p.generate(req), (e: VeyraError) => e.kind === "rate_limit");
    assert.deepEqual(net.calls.map((c) => keyOf(c.headers)), [MAIN]);
  });

  it("both keys rejected → at most two calls, then a clean auth error (the router pauses Groq)", async () => {
    net = mockFetch(() => jsonResponse({ error: { message: "Invalid API Key" } }, 401));
    const p = createGroqProvider(testEnv({ GROQ_API_KEY: MAIN, GROQ_API_KEY_BACKUP: BACKUP }));
    await assert.rejects(p.generate(req), (e: VeyraError) => e.kind === "auth" && !e.message.includes("gsk_"));
    assert.equal(net.calls.length, 2);
  });

  it("works with only one key, as before", async () => {
    net = mockFetch(() => jsonResponse({ error: { message: "Invalid API Key" } }, 401));
    const p = createGroqProvider(testEnv({ GROQ_API_KEY: MAIN }));
    await assert.rejects(p.generate(req), (e: VeyraError) => e.kind === "auth");
    assert.equal(net.calls.length, 1);
    assert.equal(createGroqProvider(testEnv({})).isConfigured(), false);
  });

  it("the backup key is a secret: scrubbed from logs, reported only as configured/missing", () => {
    const env = testEnv({ GROQ_API_KEY: MAIN, GROQ_API_KEY_BACKUP: BACKUP });
    assert.ok(secretValues(env).includes(BACKUP));
    const report = JSON.stringify(configStatus(env));
    assert.ok(!report.includes(BACKUP));
    assert.equal(configStatus(env).find((s) => s.name === "Groq backup key")?.status, "configured");
  });
});
