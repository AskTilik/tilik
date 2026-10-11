import { z } from "zod";
import type { Env } from "../../config/env.js";
import { toVeyraError } from "../../core/errors.js";
import { checkUrl } from "../../security/url-guard.js";
import { allocate } from "../../sources/collector.js";
import type { SourceInput } from "../../sources/types.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import { GitHubClient, type GitHubSession } from "./client.js";
import { findRelevantFiles, isSensitivePath, pickConfigFiles, resolvePath, summarizeTree, type TreeEntry } from "./files.js";
import { ASPECTS, planGitHubQuery, type Aspect } from "./plan.js";

// ── Input / output contracts ─────────────────────────────────────────────────

export const GitHubInputSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  ref: z.string().max(250).optional(),
  aspects: z.array(z.enum(ASPECTS)).min(1),
  paths: z.array(z.string().max(500)).max(20),
  topic: z.array(z.string().max(60)).max(60),
  directory: z.string().max(500).optional(),
  commitPath: z.string().max(500).optional(),
  mode: z.enum(["analysis", "focused"]),
  issueState: z.enum(["open", "closed", "all"]),
});
export type GitHubInput = z.infer<typeof GitHubInputSchema>;

const Nullable = z.string().nullable();
export const GitHubDataSchema = z.object({
  repo: z.object({
    fullName: z.string(),
    url: z.string(),
    description: Nullable,
    homepage: Nullable,
    language: Nullable,
    topics: z.array(z.string()),
    stars: z.number(),
    forks: z.number(),
    watchers: z.number(),
    openIssuesAndPrs: z.number(),
    license: Nullable,
    defaultBranch: z.string(),
    private: z.boolean(),
    archived: z.boolean(),
    fork: z.boolean(),
    createdAt: Nullable,
    pushedAt: Nullable,
  }),
  ref: z.string(),
  languages: z.array(z.object({ name: z.string(), percent: z.number() })).optional(),
  readme: z.object({ path: z.string(), url: z.string(), chars: z.number(), truncated: z.boolean() }).optional(),
  structure: z.object({ totalFiles: z.number(), treeTruncated: z.boolean(), directory: z.string().optional(), topLevel: z.array(z.unknown()) }).optional(),
  files: z.array(z.object({ path: z.string(), url: z.string(), reason: z.string(), chars: z.number(), truncated: z.boolean() })),
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  commits: z.array(z.object({ sha: z.string(), url: z.string(), message: z.string(), author: Nullable, date: Nullable })).optional(),
  releases: z.array(z.object({ tag: z.string(), name: Nullable, url: z.string(), publishedAt: Nullable, prerelease: z.boolean() })).optional(),
  issues: z
    .array(z.object({ number: z.number(), title: z.string(), url: z.string(), state: z.string(), author: Nullable, createdAt: Nullable, updatedAt: Nullable, comments: z.number(), labels: z.array(z.string()) }))
    .optional(),
  pulls: z.array(z.object({ number: z.number(), title: z.string(), url: z.string(), state: z.string(), merged: z.boolean(), author: Nullable, updatedAt: Nullable })).optional(),
  contributors: z.array(z.object({ login: z.string(), url: z.string(), contributions: z.number() })).optional(),
  branches: z.array(z.object({ name: z.string(), protected: z.boolean() })).optional(),
  activity: z.record(z.string(), z.unknown()).optional(),
  errors: z.array(z.object({ aspect: z.string(), kind: z.string(), message: z.string() })),
  rateLimit: z.object({ authenticated: z.boolean(), remaining: z.number().optional(), limit: z.number().optional(), resetAt: z.string().optional() }),
  apiCalls: z.number(),
});
export type GitHubData = z.infer<typeof GitHubDataSchema>;

// ── Raw GitHub API shapes (only the fields we use) ────────────────────────────

interface RawRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  watchers_count: number;
  open_issues_count: number;
  license: { spdx_id?: string | null; name?: string } | null;
  default_branch: string;
  private: boolean;
  visibility?: string;
  archived: boolean;
  fork: boolean;
  created_at: string | null;
  pushed_at: string | null;
}
interface RawReadme {
  path: string;
  html_url: string;
  content?: string;
  encoding?: string;
}
interface RawTree {
  tree: { path: string; type: "blob" | "tree" | "commit"; size?: number }[];
  truncated: boolean;
}
interface RawCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
}
interface RawRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  body?: string | null;
}
interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  user?: { login?: string } | null;
  created_at: string | null;
  updated_at: string | null;
  comments: number;
  labels?: ({ name?: string } | string)[];
  body?: string | null;
  pull_request?: unknown;
}
interface RawPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  user?: { login?: string } | null;
  updated_at: string | null;
}
interface RawContributor {
  login?: string;
  html_url?: string;
  contributions: number;
  type?: string;
}
interface RawBranch {
  name: string;
  protected: boolean;
}

/** API-backed aspects in the order they are kept when quota is short. */
const API_PRIORITY: Aspect[] = ["readme", "structure", "languages", "commits", "releases", "issues", "pulls", "contributors", "branches"];

/**
 * GitHub repository intelligence. One tool, many endpoints: the question is
 * planned into the minimum set of GitHub calls (see plan.ts), executed with
 * per-question caps, and normalized into traceable sources.
 */
export function createGitHubTool(env: Env): Tool<GitHubInput, GitHubData> {
  const client = new GitHubClient(env);

  return {
    name: "github",
    description: "Reads GitHub repositories: metadata, README, structure, files, commits, releases, issues, PRs, contributors, branches.",
    capabilities: ["github.repo"],
    inputSchema: GitHubInputSchema,
    outputSchema: GitHubDataSchema,
    auth: { envKeys: ["GITHUB_TOKEN"] },
    rateLimit: { requestsPerMinute: 30 },
    dailyLimit: env.GITHUB_DAILY_REQUEST_LIMIT,
    costTier: "free",
    priority: 10,
    cacheTtlSeconds: env.GITHUB_CACHE_TTL_SECONDS,
    timeoutMs: env.GITHUB_TIMEOUT_MS,
    // No equivalent alternative tool for the GitHub API: retry once on transient failures.
    retries: 1,
    isConfigured: () => Boolean(env.GITHUB_TOKEN) || env.GITHUB_ALLOW_UNAUTHENTICATED,

    planInput(ctx) {
      if (!ctx.repo) return null;
      const plan = planGitHubQuery(ctx.query, {
        research: ctx.mode === "research",
        owner: ctx.repo.owner,
        repoName: ctx.repo.repo,
        ...(ctx.repo.path ? { urlPath: ctx.repo.path } : {}),
        ...(ctx.repo.kind ? { urlKind: ctx.repo.kind } : {}),
      });
      const commitPath = plan.aspects.includes("commits") && plan.paths.length === 1 ? plan.paths[0] : undefined;
      return {
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        ...(ctx.repo.ref ? { ref: ctx.repo.ref } : {}),
        ...plan,
        ...(commitPath ? { commitPath } : {}),
      };
    },

    async execute(input, { signal }): Promise<ToolResult<GitHubData>> {
      const session: GitHubSession = {
        signal,
        apiCalls: 0,
        maxApiCalls: Math.max(1, env.GITHUB_MAX_REQUESTS_PER_QUESTION),
        isPrivate: false,
        notices: new Set(),
      };
      if (env.GITHUB_TOKEN && !client.rate.authenticated) {
        session.notices.add("GITHUB_TOKEN was rejected earlier; using unauthenticated GitHub access (public repositories, 60 requests/hour).");
      }
      const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
      const errors: GitHubData["errors"] = [];
      const want = new Set(input.aspects);

      // 1. Metadata — required. 404/401/403/rate limit here fail the tool (and let the router fall back).
      const meta = await client.api<RawRepo>(base, session);
      session.isPrivate = meta.private === true;
      const ref = input.ref ?? meta.default_branch;
      const repoUrl = meta.html_url;

      const attempt = async <T>(aspect: string, fn: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await fn();
        } catch (err) {
          const e = toVeyraError(err, "tool:github");
          if (e.kind === "aborted") throw e;
          errors.push({ aspect, kind: e.kind, message: e.message });
          return undefined;
        }
      };

      // 2. Decide which API calls we can afford (per-question cap and live GitHub quota).
      const needsTree = want.has("structure") || want.has("config") || (want.has("files") && input.topic.length > 0) || Boolean(input.directory);
      const wanted = API_PRIORITY.filter((a) => (a === "structure" ? needsTree : want.has(a)));
      const quotaLeft = client.rate.remaining !== undefined ? Math.max(0, client.rate.remaining - 1) : Number.POSITIVE_INFINITY;
      const affordable = Math.max(0, Math.min(session.maxApiCalls - session.apiCalls, quotaLeft));
      const allowed = new Set(wanted.slice(0, affordable));
      const dropped = wanted.filter((a) => !allowed.has(a));
      if (dropped.length) {
        const why = quotaLeft < session.maxApiCalls ? `GitHub API quota is low (${client.rate.remaining} left)` : `per-question limit of ${session.maxApiCalls} GitHub API calls`;
        session.notices.add(`Skipped ${dropped.join(", ")} (${why}).`);
      }
      const run = <T>(aspect: Aspect, fn: () => Promise<T>) => (allowed.has(aspect) ? attempt(aspect, fn) : Promise.resolve(undefined));

      const [languagesRaw, readmeRaw, treeRaw, commitsRaw, releasesRaw, issuesRaw, pullsRaw, contributorsRaw, branchesRaw] = await Promise.all([
        run("languages", () => client.api<Record<string, number>>(`${base}/languages`, session)),
        run("readme", () => client.api<RawReadme>(`${base}/readme${input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""}`, session)),
        run("structure", () => client.api<RawTree>(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, session)),
        run("commits", () =>
          client.api<RawCommit[]>(
            `${base}/commits?per_page=${env.GITHUB_MAX_COMMITS}&sha=${encodeURIComponent(ref)}${input.commitPath ? `&path=${encodeURIComponent(input.commitPath)}` : ""}`,
            session,
          ),
        ),
        run("releases", () => client.api<RawRelease[]>(`${base}/releases?per_page=${env.GITHUB_MAX_RELEASES}`, session)),
        run("issues", () =>
          client.api<RawIssue[]>(`${base}/issues?state=${input.issueState}&sort=updated&direction=desc&per_page=${Math.min(100, env.GITHUB_MAX_ISSUES * 2)}`, session),
        ),
        run("pulls", () => client.api<RawPull[]>(`${base}/pulls?state=all&sort=updated&direction=desc&per_page=${env.GITHUB_MAX_PR_RESULTS}`, session)),
        run("contributors", () => client.api<RawContributor[]>(`${base}/contributors?per_page=${env.GITHUB_MAX_CONTRIBUTORS}`, session)),
        run("branches", () => client.api<RawBranch[]>(`${base}/branches?per_page=${Math.min(30, env.GITHUB_MAX_PR_RESULTS)}`, session)),
      ]);

      let tree: TreeEntry[] | undefined = treeRaw?.tree;
      if (tree && tree.length > env.GITHUB_MAX_TREE_ENTRIES) {
        session.notices.add(`Large repository: only the first ${env.GITHUB_MAX_TREE_ENTRIES.toLocaleString("en-US")} of ${tree.length.toLocaleString("en-US")} tree entries were considered.`);
        tree = tree.slice(0, env.GITHUB_MAX_TREE_ENTRIES);
      }
      if (treeRaw?.truncated) session.notices.add("Very large repository: GitHub truncated the file listing, so the structure summary is partial.");

      // 3. Content budget: README first (≤ 40% when files are also wanted), files share the rest.
      const totalBudget = env.GITHUB_MAX_TOTAL_CONTENT;
      let readme: { text: string; truncated: boolean; path: string; url: string } | undefined;
      if (readmeRaw?.content) {
        const full = Buffer.from(readmeRaw.content, (readmeRaw.encoding as BufferEncoding) ?? "base64").toString("utf8");
        const cap = Math.min(env.GITHUB_MAX_FILE_SIZE, want.has("files") || want.has("config") ? Math.floor(totalBudget * 0.4) : totalBudget);
        readme = { text: full.slice(0, cap), truncated: full.length > cap, path: readmeRaw.path, url: readmeRaw.html_url };
        if (readme.truncated) session.notices.add(`README truncated to ${cap.toLocaleString("en-US")} characters.`);
      }

      // 4. Choose files: explicitly requested → topic-relevant → config/manifests. Never the whole repo.
      const skippedFiles: GitHubData["skippedFiles"] = [];
      const chosen: { path: string; reason: string; size?: number }[] = [];
      const add = (path: string, reason: string, size?: number) => {
        if (chosen.some((c) => c.path === path)) return;
        if (isSensitivePath(path)) {
          skippedFiles.push({ path, reason: "potentially sensitive file (never fetched)" });
          return;
        }
        if (chosen.length >= env.GITHUB_MAX_FILES) {
          skippedFiles.push({ path, reason: `file limit (${env.GITHUB_MAX_FILES}) reached` });
          return;
        }
        chosen.push({ path, reason, ...(size !== undefined ? { size } : {}) });
      };
      for (const p of input.paths) add(p, "requested", tree?.find((e) => e.path === p)?.size);
      if (tree && input.topic.length) {
        const scope = input.directory ? tree.filter((e) => e.path.startsWith(`${input.directory}/`)) : tree;
        for (const { entry } of findRelevantFiles(scope, input.topic, env.GITHUB_MAX_FILES, env.GITHUB_MAX_FILE_SIZE)) add(entry.path, "matches the question", entry.size);
      }
      if (tree && want.has("config")) {
        for (const e of pickConfigFiles(tree, Math.min(4, env.GITHUB_MAX_FILES), env.GITHUB_MAX_FILE_SIZE)) add(e.path, "manifest/config/entry point", e.size);
      }

      const contentBudget = Math.max(0, totalBudget - (readme?.text.length ?? 0));
      const allowance = allocate(chosen.map((c) => Math.min(c.size ?? env.GITHUB_MAX_FILE_SIZE, env.GITHUB_MAX_FILE_SIZE)), contentBudget);
      // The tree is fetched at most once, and only if a requested path needs resolving.
      let treeLookup: Promise<TreeEntry[] | undefined> | undefined;
      const getTree = () =>
        (treeLookup ??= tree
          ? Promise.resolve(tree)
          : client.api<RawTree>(`${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`, session).then((t) => t.tree, () => undefined));
      const readFile = async (path: string, maxBytes: number) => {
        try {
          return { ok: true as const, value: await client.raw(input, ref, path, maxBytes, session) };
        } catch (err) {
          const e = toVeyraError(err, "tool:github");
          if (e.kind === "aborted") throw e;
          return { ok: false as const, kind: e.kind, message: e.message };
        }
      };
      const fetched = await Promise.all(
        chosen.map(async (c, i) => {
          const maxBytes = Math.min(env.GITHUB_MAX_FILE_SIZE, Math.max(0, allowance[i] ?? 0));
          // Skip only if the budget can't fit a meaningful slice (a 150-byte file allotted 150 bytes is fine).
          if (maxBytes < Math.min(200, c.size ?? 200) || maxBytes === 0) {
            skippedFiles.push({ path: c.path, reason: `total content limit (${totalBudget.toLocaleString("en-US")} chars) reached` });
            return undefined;
          }
          let path = c.path;
          let res = await readFile(path, maxBytes);
          // "router.ts" → "src/router.ts": resolve loosely-named requested files against the tree.
          if (!res.ok && res.kind === "not_found" && c.reason === "requested") {
            const t = await getTree();
            const resolved = t ? resolvePath(t, path) : undefined;
            if (resolved && resolved !== path && !isSensitivePath(resolved)) {
              path = resolved;
              res = await readFile(path, maxBytes);
            }
          }
          if (!res.ok) {
            skippedFiles.push({ path: c.path, reason: res.kind === "not_found" ? "not found in the repository" : `could not be fetched (${res.kind})` });
            if (res.kind !== "not_found") errors.push({ aspect: `file:${c.path}`, kind: res.kind, message: res.message });
            return undefined;
          }
          return { ...c, path, ...res.value };
        }),
      );
      const files = fetched.filter((f): f is NonNullable<typeof f> => Boolean(f));
      for (const f of files) if (f.truncated) session.notices.add(`${f.path} was truncated to fit the file/content limits.`);

      // 5. Normalize everything into data (for the UI) and sources (for the model + citations).
      const languages = languagesRaw ? toPercentages(languagesRaw) : undefined;
      const commits = commitsRaw?.slice(0, env.GITHUB_MAX_COMMITS).map((c) => ({
        sha: c.sha,
        url: c.html_url,
        message: c.commit.message,
        author: c.author?.login ?? c.commit.author?.name ?? null,
        date: c.commit.author?.date ?? null,
      }));
      const releases = releasesRaw
        ?.filter((r) => !r.draft)
        .slice(0, env.GITHUB_MAX_RELEASES)
        .map((r) => ({ tag: r.tag_name, name: r.name, url: r.html_url, publishedAt: r.published_at, prerelease: r.prerelease, body: r.body ?? "" }));
      const issues = issuesRaw
        ?.filter((i) => !i.pull_request)
        .slice(0, env.GITHUB_MAX_ISSUES)
        .map((i) => ({
          number: i.number,
          title: i.title,
          url: i.html_url,
          state: i.state,
          author: i.user?.login ?? null,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          comments: i.comments,
          labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
          body: i.body ?? "",
        }));
      const pulls = pullsRaw?.slice(0, env.GITHUB_MAX_PR_RESULTS).map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        state: p.state,
        merged: Boolean(p.merged_at),
        author: p.user?.login ?? null,
        updatedAt: p.updated_at,
      }));
      const contributors = contributorsRaw
        ?.filter((c) => c.login && c.html_url)
        .slice(0, env.GITHUB_MAX_CONTRIBUTORS)
        .map((c) => ({ login: c.login!, url: c.html_url!, contributions: c.contributions }));
      const branches = branchesRaw?.map((b) => ({ name: b.name, protected: b.protected }));
      const activity = commits || releases || pulls ? activitySummary(meta, commits, releases, pulls) : undefined;
      const structure = tree && (want.has("structure") || input.directory)
        ? summarizeTree(input.directory ? tree.filter((e) => e.path.startsWith(`${input.directory}/`)) : tree, { truncated: Boolean(treeRaw?.truncated) })
        : undefined;

      const full = meta.full_name;
      const blobUrl = (p: string) => `${repoUrl}/blob/${encodeURIComponent(ref)}/${p.split("/").map(encodeURIComponent).join("/")}`;
      const homepage = meta.homepage && checkUrl(meta.homepage).ok ? meta.homepage : null;
      const sources: SourceInput[] = [];
      const citableUrls = new Set<string>([repoUrl]);

      sources.push({
        title: `${full} — repository overview`,
        url: repoUrl,
        type: "github",
        evidence: "live_data",
        relevance: 1,
        content: metadataText(meta, ref, languages, homepage),
      });
      if (readme) {
        citableUrls.add(readme.url);
        sources.push({
          title: `${full} — ${readme.path}`,
          url: readme.url,
          type: "github",
          evidence: "retrieved_content",
          relevance: 0.96,
          content: readme.truncated ? `${readme.text}\n\n[… README truncated]` : readme.text,
        });
      }
      if (structure) {
        sources.push({
          title: `${full} — repository structure (${ref}${input.directory ? `, ${input.directory}/` : ""})`,
          url: `${repoUrl}/tree/${encodeURIComponent(ref)}${input.directory ? `/${input.directory.split("/").map(encodeURIComponent).join("/")}` : ""}`,
          type: "github",
          evidence: "live_data",
          relevance: 0.9,
          content: structure.text + (files.length ? `\nFiles read for this answer: ${files.map((f) => `${f.path} (${f.reason})`).join(", ")}` : ""),
        });
      }
      for (const f of files) {
        const url = blobUrl(f.path);
        citableUrls.add(url);
        sources.push({
          title: `${full}: ${f.path}`,
          url,
          type: "github",
          evidence: "retrieved_content",
          format: "code",
          relevance: f.reason === "requested" ? 0.97 : f.reason === "matches the question" ? 0.93 : 0.85,
          content: `File: ${f.path} (${f.reason}${f.truncated ? ", truncated" : ""})\n\n${f.text}`,
        });
      }
      if (activity) {
        sources.push({
          title: `${full} — activity summary (derived from the data fetched)`,
          url: `${repoUrl}/pulse`,
          type: "github",
          evidence: "live_data",
          relevance: 0.89,
          content: Object.entries(activity).map(([k, v]) => `${k}: ${v}`).join("\n"),
        });
      }
      if (commits?.length) {
        commits.forEach((c) => citableUrls.add(c.url));
        sources.push({
          title: `${full} — ${commits.length} most recent commits on ${ref}${input.commitPath ? ` touching ${input.commitPath}` : ""}`,
          url: `${repoUrl}/commits/${encodeURIComponent(ref)}`,
          type: "github",
          evidence: "live_data",
          relevance: 0.88,
          content: commits.map((c) => `- ${c.date ?? "?"} ${c.sha.slice(0, 7)} by ${c.author ?? "unknown"}: ${firstLine(c.message)} (${c.url})`).join("\n"),
        });
      }
      if (releases?.length) {
        releases.forEach((r) => citableUrls.add(r.url));
        sources.push({
          title: `${full} — latest releases`,
          url: `${repoUrl}/releases`,
          type: "github",
          evidence: "live_data",
          relevance: 0.87,
          content: releases
            .map((r) => `- ${r.tag}${r.name && r.name !== r.tag ? ` "${r.name}"` : ""} — ${r.publishedAt ?? "unpublished"}${r.prerelease ? " (pre-release)" : ""} (${r.url})${r.body ? `\n  Notes: ${clip(r.body, 400)}` : ""}`)
            .join("\n"),
        });
      } else if (releasesRaw && allowed.has("releases")) {
        sources.push({ title: `${full} — releases`, url: `${repoUrl}/releases`, type: "github", evidence: "live_data", relevance: 0.6, content: "This repository has no published releases." });
      }
      if (issues) {
        issues.forEach((i) => citableUrls.add(i.url));
        sources.push({
          title: `${full} — ${input.issueState} issues (most recently updated)`,
          url: `${repoUrl}/issues`,
          type: "github",
          evidence: "live_data",
          relevance: 0.86,
          content: issues.length
            ? issues
                .map((i) => `- #${i.number} ${i.title}${i.labels.length ? ` [${i.labels.join(", ")}]` : ""} — by ${i.author ?? "unknown"}, opened ${i.createdAt ?? "?"}, updated ${i.updatedAt ?? "?"}, ${i.comments} comments (${i.url})${i.body ? `\n  ${clip(i.body, 300)}` : ""}`)
                .join("\n")
            : `No ${input.issueState} issues.`,
        });
      }
      if (pulls) {
        pulls.forEach((p) => citableUrls.add(p.url));
        sources.push({
          title: `${full} — pull requests (most recently updated)`,
          url: `${repoUrl}/pulls`,
          type: "github",
          evidence: "live_data",
          relevance: 0.85,
          content: pulls.length
            ? pulls.map((p) => `- #${p.number} ${p.title} — ${p.merged ? "merged" : p.state} by ${p.author ?? "unknown"}, updated ${p.updatedAt ?? "?"} (${p.url})`).join("\n")
            : "No pull requests.",
        });
      }
      if (contributors?.length) {
        contributors.forEach((c) => citableUrls.add(c.url));
        sources.push({
          title: `${full} — top contributors`,
          url: `${repoUrl}/graphs/contributors`,
          type: "github",
          evidence: "live_data",
          relevance: 0.84,
          content: contributors.map((c) => `- ${c.login}: ${c.contributions} commits (${c.url})`).join("\n"),
        });
      }
      if (branches?.length) {
        sources.push({
          title: `${full} — branches`,
          url: `${repoUrl}/branches`,
          type: "github",
          evidence: "live_data",
          relevance: 0.8,
          content: branches.map((b) => `- ${b.name}${b.protected ? " (protected)" : ""}${b.name === meta.default_branch ? " (default)" : ""}`).join("\n"),
        });
      }
      if (homepage) citableUrls.add(homepage);

      for (const e of errors) {
        if (e.aspect === "readme" && e.kind === "not_found") session.notices.add("This repository has no README.");
        else session.notices.add(`Could not fetch ${e.aspect.replace(/^file:/, "file ")} from GitHub (${e.kind}).`);
      }
      if (session.isPrivate) session.notices.add("Private repository: its content is cached only briefly and is not shared outside this request.");

      const data: GitHubData = {
        repo: {
          fullName: full,
          url: repoUrl,
          description: meta.description,
          homepage,
          language: meta.language,
          topics: meta.topics ?? [],
          stars: meta.stargazers_count,
          forks: meta.forks_count,
          watchers: meta.subscribers_count ?? meta.watchers_count,
          openIssuesAndPrs: meta.open_issues_count,
          license: meta.license?.spdx_id ?? meta.license?.name ?? null,
          defaultBranch: meta.default_branch,
          private: meta.private,
          archived: meta.archived,
          fork: meta.fork,
          createdAt: meta.created_at,
          pushedAt: meta.pushed_at,
        },
        ref,
        ...(languages ? { languages } : {}),
        ...(readme ? { readme: { path: readme.path, url: readme.url, chars: readme.text.length, truncated: readme.truncated } } : {}),
        ...(structure ? { structure: { totalFiles: structure.totalFiles, treeTruncated: Boolean(treeRaw?.truncated), topLevel: structure.topLevel, ...(input.directory ? { directory: input.directory } : {}) } } : {}),
        files: files.map((f) => ({ path: f.path, url: blobUrl(f.path), reason: f.reason, chars: f.text.length, truncated: f.truncated })),
        skippedFiles,
        ...(commits ? { commits: commits.map((c) => ({ ...c, message: firstLine(c.message) })) } : {}),
        ...(releases ? { releases: releases.map(({ body: _b, ...r }) => r) } : {}),
        ...(issues ? { issues: issues.map(({ body: _b, ...i }) => i) } : {}),
        ...(pulls ? { pulls } : {}),
        ...(contributors ? { contributors } : {}),
        ...(branches ? { branches } : {}),
        ...(activity ? { activity } : {}),
        errors,
        rateLimit: {
          authenticated: client.rate.authenticated,
          ...(client.rate.remaining !== undefined ? { remaining: client.rate.remaining } : {}),
          ...(client.rate.limit !== undefined ? { limit: client.rate.limit } : {}),
          ...(client.rate.resetAt ? { resetAt: new Date(client.rate.resetAt).toISOString() } : {}),
        },
        apiCalls: session.apiCalls,
      };
      if (skippedFiles.length) session.notices.add(`Skipped files: ${skippedFiles.map((s) => `${s.path} (${s.reason})`).join("; ")}.`);

      return {
        data,
        sources,
        notices: [...session.notices],
        citableUrls: [...citableUrls],
        ...(homepage && !/^https?:\/\/(www\.)?github\.com\//i.test(homepage) ? { related: [homepage] } : {}),
        ...(session.isPrivate ? { cacheTtlSeconds: env.GITHUB_PRIVATE_CACHE_TTL_SECONDS } : {}),
      };
    },
  };
}

function metadataText(meta: RawRepo, ref: string, languages: { name: string; percent: number }[] | undefined, homepage: string | null): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    `Repository: ${meta.full_name}`,
    `Description: ${meta.description ?? "(none)"}`,
    homepage ? `Homepage: ${homepage}` : undefined,
    `Primary language: ${meta.language ?? "unknown"}${languages?.length ? ` · Languages: ${languages.slice(0, 8).map((l) => `${l.name} ${l.percent}%`).join(", ")}` : ""}`,
    `Stars: ${n(meta.stargazers_count)} · Forks: ${n(meta.forks_count)} · Watchers: ${n(meta.subscribers_count ?? meta.watchers_count)} · Open issues + PRs: ${n(meta.open_issues_count)}`,
    `License: ${meta.license?.spdx_id ?? meta.license?.name ?? "none"} · Default branch: ${meta.default_branch} · Analyzed ref: ${ref} · Visibility: ${meta.visibility ?? (meta.private ? "private" : "public")}`,
    `Created: ${meta.created_at ?? "?"} · Last push: ${meta.pushed_at ?? "?"} · Archived: ${meta.archived ? "yes" : "no"} · Fork: ${meta.fork ? "yes" : "no"}`,
    meta.topics?.length ? `Topics: ${meta.topics.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function activitySummary(
  meta: RawRepo,
  commits: { date: string | null }[] | undefined,
  releases: { tag: string; publishedAt: string | null }[] | undefined,
  pulls: { merged: boolean; state: string; updatedAt: string | null }[] | undefined,
): Record<string, string> {
  const now = Date.now();
  const days = (iso: string | null | undefined) => (iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : undefined);
  const out: Record<string, string> = {};
  out["Last push"] = `${meta.pushed_at ?? "unknown"}${days(meta.pushed_at) !== undefined ? ` (${days(meta.pushed_at)} days ago)` : ""}`;
  if (meta.archived) out.Status = "archived (read-only)";
  if (commits?.length) {
    const dates = commits.map((c) => c.date).filter((d): d is string => Boolean(d)).sort();
    const recent = dates.filter((d) => (days(d) ?? 9e9) <= 30).length;
    out["Latest commit"] = `${dates.at(-1) ?? "?"} (${days(dates.at(-1)) ?? "?"} days ago)`;
    out["Commits in the last 30 days"] = `${recent}${recent === commits.length ? `+ (all ${commits.length} commits sampled are from this period)` : ` (of the ${commits.length} most recent)`}`;
    const latest = days(dates.at(-1)) ?? 9e9;
    if (!meta.archived) out["Activity level (by latest commit)"] = latest <= 30 ? "active" : latest <= 180 ? "slowing" : "inactive";
  }
  if (releases?.length) out["Latest release"] = `${releases[0]!.tag} on ${releases[0]!.publishedAt ?? "?"}`;
  else if (releases) out["Latest release"] = "none published";
  if (pulls?.length) {
    out["Pull requests sampled"] = `${pulls.length} (${pulls.filter((p) => p.merged).length} merged, ${pulls.filter((p) => p.state === "open").length} open)`;
  }
  return out;
}

function toPercentages(bytes: Record<string, number>): { name: string; percent: number }[] {
  const total = Object.values(bytes).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(bytes)
    .sort((a, b) => b[1] - a[1])
    .map(([name, b]) => ({ name, percent: Math.round((b / total) * 1000) / 10 }));
}

function firstLine(s: string): string {
  return clip(s.split("\n")[0] ?? "", 200);
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
