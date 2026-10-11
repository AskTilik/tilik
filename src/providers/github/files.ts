/**
 * Repository-structure helpers. Everything here works on the file *tree*
 * (paths and sizes) so VEYRA can decide which few files are worth reading
 * before downloading any content.
 */

export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

const IGNORED_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", "out", ".git", ".next", ".nuxt", "target", "__pycache__", "coverage",
  ".venv", "venv", "env", "third_party", "third-party", "deps", "bower_components", ".yarn", ".cache", "Pods", "bin", "obj",
]);
const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "cargo.lock", "poetry.lock", "pipfile.lock", "go.sum",
  "composer.lock", "gemfile.lock", "flake.lock", "uv.lock",
]);
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dll|dylib|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|psd|sketch|fig|db|sqlite|pyc|o|a|lib|min\.js|map)$/i;
const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|scala|rb|php|cs|fs|cpp|cc|c|h|hpp|m|mm|swift|sol|vy|move|cairo|zig|ex|exs|erl|hs|clj|lua|dart|vue|svelte|sh|bash|ps1|sql|graphql|proto)$/i;
const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;

/** Never fetched, even if asked for by name. */
const SENSITIVE =
  /(^|\/)(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env)|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;

export function isSensitivePath(path: string): boolean {
  return SENSITIVE.test(path);
}

/** Files worth skipping when looking for meaningful content. */
export function isNoise(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1)!.toLowerCase();
  return parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d)) || LOCKFILES.has(name) || BINARY_EXT.test(name) || isSensitivePath(path);
}

/** Manifests / build and deployment config, by priority. Root first, then one level down. */
const CONFIG_FILES = [
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "composer.json", "gemfile", "foundry.toml", "hardhat.config.ts", "hardhat.config.js", "deno.json", "tsconfig.json", "dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "makefile", "vite.config.ts", "next.config.js", "next.config.mjs", "angular.json",
];
const ENTRY_POINTS = /^(src\/|app\/|lib\/|cmd\/[^/]+\/|pkg\/)?(index|main|app|server|cli|mod|lib)\.[a-z]+$/i;

export function pickConfigFiles(entries: TreeEntry[], max: number, maxSize: number): TreeEntry[] {
  const blobs = entries.filter((e) => e.type === "blob" && (e.size ?? 0) <= maxSize && !isNoise(e.path));
  const byName = (depth: number) =>
    blobs
      .filter((e) => e.path.split("/").length === depth + 1)
      .map((e) => ({ e, rank: CONFIG_FILES.indexOf(e.path.split("/").at(-1)!.toLowerCase()) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.e);
  const ci = blobs.filter((e) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(e.path)).slice(0, 1);
  const entries_ = blobs.filter((e) => ENTRY_POINTS.test(e.path)).slice(0, 2);
  return dedupe([...byName(0), ...entries_, ...byName(1), ...ci]).slice(0, max);
}

const SYNONYMS: string[][] = [
  ["auth", "authentication", "authenticate", "authorization", "login", "logout", "signin", "signup", "session", "jwt", "oauth", "passport", "token", "credential", "password", "permission", "acl", "guard", "rbac"],
  ["db", "database", "model", "models", "schema", "migration", "migrations", "prisma", "orm", "entity", "sql", "query", "repository"],
  ["api", "route", "routes", "router", "routing", "controller", "handler", "handlers", "endpoint", "server", "http", "rest", "graphql"],
  ["config", "configuration", "settings", "env", "options"],
  ["test", "tests", "testing", "spec"],
  ["payment", "payments", "billing", "stripe", "checkout", "invoice", "subscription"],
  ["cache", "caching", "redis", "memo"],
  ["queue", "worker", "job", "jobs", "scheduler", "cron"],
  ["ui", "component", "components", "view", "views", "page", "pages", "frontend", "layout"],
  ["cli", "command", "commands", "cmd"],
  ["contract", "contracts", "solidity", "token", "erc20", "vault"],
  ["error", "errors", "exception", "exceptions"],
  ["log", "logger", "logging", "telemetry", "metrics"],
];

const STOPWORDS = new Set(
  "a an the this that these those is are was were be been how does do did what where which who why when explain show me tell about in of on for to and or with from it its into by repo repository project code codebase file files system work works working implemented implementation logic handle handles handling find look part parts module modules mechanism flow please can you could would".split(
    " ",
  ),
);

/** Content words from a question, expanded with synonyms ("authentication" → auth, login, jwt, …). */
export function topicTerms(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const terms = new Set(words);
  for (const w of words) {
    for (const group of SYNONYMS) {
      if (group.some((g) => g === w || (w.length >= 4 && (g.startsWith(w) || w.startsWith(g))))) group.forEach((g) => terms.add(g));
    }
  }
  return [...terms];
}

/** Scores files by how well their path matches the topic terms. Content is never read here. */
export function findRelevantFiles(entries: TreeEntry[], terms: string[], max: number, maxSize: number): { entry: TreeEntry; score: number }[] {
  if (!terms.length) return [];
  const wantsTests = terms.includes("test") && terms.includes("spec");
  const scored: { entry: TreeEntry; score: number }[] = [];
  for (const e of entries) {
    if (e.type !== "blob" || isNoise(e.path) || (e.size ?? 0) > maxSize) continue;
    if (!CODE_EXT.test(e.path) && !DOC_EXT.test(e.path)) continue;
    const original = e.path.split("/");
    const parts = e.path.toLowerCase().split("/");
    const file = parts.at(-1)!;
    // Tokenize the original case so camelCase names split ("authMiddleware" → auth, middleware).
    const fileTokens = tokens(original.at(-1)!.replace(/\.[^.]+$/, ""));
    const dirTokens = original.slice(0, -1).flatMap(tokens);
    let score = 0;
    for (const t of terms) {
      if (fileTokens.includes(t)) score += 4;
      else if (file.includes(t)) score += 2.5;
      if (dirTokens.includes(t)) score += 1.5;
    }
    if (score === 0) continue;
    if (CODE_EXT.test(file)) score += 1;
    if (/^(src|lib|app|pkg|internal|server|core)\//.test(e.path)) score += 0.5;
    if (!wantsTests && /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?)(\/|$)|\.(test|spec)\./i.test(e.path)) score -= 3;
    if (/(^|\/)(docs?|examples?|samples?|benchmarks?)\//i.test(e.path)) score -= 1;
    score -= parts.length * 0.1;
    if (score > 0) scored.push({ entry: e, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max);
}

/** Finds a file the user named loosely ("router.ts" → "src/router.ts"). */
export function resolvePath(entries: TreeEntry[], wanted: string): string | undefined {
  const w = wanted.replace(/^\.?\//, "").toLowerCase();
  const blobs = entries.filter((e) => e.type === "blob");
  return (
    blobs.find((e) => e.path.toLowerCase() === w)?.path ??
    blobs.filter((e) => e.path.toLowerCase().endsWith(`/${w}`)).sort((a, b) => a.path.length - b.path.length)[0]?.path
  );
}

/** Compact, size-capped description of the repository layout (never the full tree). */
export function summarizeTree(entries: TreeEntry[], opts: { truncated: boolean; maxChars?: number }): {
  text: string;
  totalFiles: number;
  topLevel: { name: string; type: "dir" | "file"; files?: number }[];
} {
  const blobs = entries.filter((e) => e.type === "blob");
  const meaningful = blobs.filter((e) => !isNoise(e.path));
  const dirCounts = new Map<string, number>();
  const subCounts = new Map<string, Map<string, number>>();
  const rootFiles: string[] = [];
  const ext = new Map<string, number>();

  for (const e of meaningful) {
    const parts = e.path.split("/");
    if (parts.length === 1) rootFiles.push(parts[0]!);
    else {
      dirCounts.set(parts[0]!, (dirCounts.get(parts[0]!) ?? 0) + 1);
      if (parts.length > 2) {
        const subs = subCounts.get(parts[0]!) ?? new Map<string, number>();
        subs.set(parts[1]!, (subs.get(parts[1]!) ?? 0) + 1);
        subCounts.set(parts[0]!, subs);
      }
    }
    const x = /\.([a-z0-9]+)$/i.exec(e.path)?.[1]?.toLowerCase();
    if (x) ext.set(x, (ext.get(x) ?? 0) + 1);
  }

  const dirs = [...dirCounts].sort((a, b) => b[1] - a[1]);
  const lines = [
    `${blobs.length.toLocaleString("en-US")} files${opts.truncated ? " (GitHub truncated the tree listing — very large repository; counts are partial)" : ""}; ${(blobs.length - meaningful.length).toLocaleString("en-US")} ignored (dependencies, build output, lockfiles, binaries).`,
    "Top-level directories:",
    ...dirs.slice(0, 25).map(([d, n]) => {
      const subs = [...(subCounts.get(d) ?? new Map())].sort((a, b) => b[1] - a[1]).slice(0, 8);
      return `- ${d}/ — ${n} files${subs.length ? ` (${subs.map(([s, c]) => `${s}/ ${c}`).join(", ")})` : ""}`;
    }),
    ...(dirs.length > 25 ? [`- … ${dirs.length - 25} more directories`] : []),
    `Top-level files: ${rootFiles.slice(0, 30).join(", ")}${rootFiles.length > 30 ? ", …" : ""}`,
    `Most common file types: ${[...ext].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([x, n]) => `.${x} (${n})`).join(", ")}`,
  ];
  const max = opts.maxChars ?? 4000;
  const text = lines.join("\n");
  return {
    text: text.length > max ? `${text.slice(0, max - 1)}…` : text,
    totalFiles: blobs.length,
    topLevel: [
      ...dirs.map(([name, files]) => ({ name, type: "dir" as const, files })),
      ...rootFiles.map((name) => ({ name, type: "file" as const })),
    ].slice(0, 100),
  };
}

function tokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function dedupe(entries: TreeEntry[]): TreeEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
}
