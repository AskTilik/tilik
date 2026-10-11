import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { checkUrl } from "../security/url-guard.js";
import type { Env } from "./env.js";

/**
 * RSS/Atom feed configuration. The list lives in data (feeds.json or env),
 * never in business logic. Precedence:
 *   RSS_FEEDS_JSON (inline JSON) → RSS_FEEDS (quick list) → RSS_FEEDS_FILE (default ./feeds.json)
 */
export const FeedSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url(),
  /** ai | technology | crypto | finance | developer | general | any custom category */
  category: z.string().trim().toLowerCase().min(1).max(40).default("general"),
  /** Publisher shown in citations (defaults to the feed name). */
  source: z.string().trim().max(100).optional(),
  enabled: z.boolean().default(true),
});
export type Feed = z.infer<typeof FeedSchema>;

export interface FeedConfig {
  feeds: Feed[];
  origin: string;
  /** Entries that were skipped and why (logged at startup, never fatal). */
  errors: string[];
}

export function loadFeeds(env: Env): FeedConfig {
  const errors: string[] = [];
  let raw: unknown[] = [];
  let origin = "none";

  try {
    if (env.RSS_FEEDS_JSON) {
      raw = asList(JSON.parse(env.RSS_FEEDS_JSON));
      origin = "RSS_FEEDS_JSON";
    } else if (env.RSS_FEEDS) {
      raw = env.RSS_FEEDS.split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseQuickEntry);
      origin = "RSS_FEEDS";
    } else if (existsSync(env.RSS_FEEDS_FILE)) {
      raw = asList(JSON.parse(readFileSync(env.RSS_FEEDS_FILE, "utf8")));
      origin = env.RSS_FEEDS_FILE;
    }
  } catch (err) {
    errors.push(`Could not read feed configuration (${origin}): ${(err as Error).message}`);
  }

  const feeds: Feed[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const parsed = FeedSchema.safeParse(entry);
    if (!parsed.success) {
      errors.push(`Feed #${i + 1} ignored: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      continue;
    }
    const check = checkUrl(parsed.data.url);
    if (!check.ok) {
      errors.push(`Feed "${parsed.data.name}" ignored: ${check.reason}`);
      continue;
    }
    if (seen.has(parsed.data.url)) continue;
    seen.add(parsed.data.url);
    feeds.push(parsed.data);
  }
  return { feeds, origin, errors };
}

function asList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray((json as { feeds?: unknown }).feeds)) return (json as { feeds: unknown[] }).feeds;
  throw new Error('expected an array of feeds or {"feeds": [...]}');
}

/** "https://x/feed" or "category|name|https://x/feed" */
function parseQuickEntry(entry: string): unknown {
  const parts = entry.split("|").map((p) => p.trim());
  if (parts.length >= 3) return { category: parts[0], name: parts[1], url: parts.slice(2).join("|") };
  let name = entry;
  try {
    name = new URL(entry).hostname.replace(/^www\./, "");
  } catch {
    /* validated later */
  }
  return { name, url: entry, category: "general" };
}
