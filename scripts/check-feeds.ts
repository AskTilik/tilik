/**
 * Fetches every configured feed once and reports whether it parses.
 * Usage: npx tsx scripts/check-feeds.ts   (uses RSS_FEEDS_FILE / RSS_FEEDS / RSS_FEEDS_JSON like the server)
 */
import { existsSync } from "node:fs";
import { loadEnv } from "../src/config/env.js";
import { loadFeeds } from "../src/config/feeds.js";
import { NewsStore } from "../src/providers/news/store.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = loadEnv();
const { feeds, origin, errors } = loadFeeds(env);
console.log(`Feeds from ${origin}: ${feeds.length}${errors.length ? ` (${errors.length} config errors)` : ""}`);
for (const e of errors) console.log(`  config: ${e}`);

const store = new NewsStore(env);
const { articles, reports } = await store.collect(feeds, AbortSignal.timeout(60_000));
for (const r of reports) {
  const newest = articles
    .filter((a) => a.feed === r.feed && a.publishedAt)
    .map((a) => a.publishedAt!)
    .sort()
    .at(-1);
  console.log(`${r.status === "failed" ? "FAIL" : " ok "}  ${r.feed.padEnd(26)} ${String(r.articles).padStart(3)} articles  ${newest ? `newest ${newest}` : ""}${r.error ? `  ${r.error}` : ""}`);
}
const failed = reports.filter((r) => r.status === "failed").length;
console.log(`\n${reports.length - failed}/${reports.length} feeds OK, ${articles.length} articles.`);
