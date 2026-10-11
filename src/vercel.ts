import { createApp } from "./app.js";
import { loadEnv, productionProblems } from "./config/env.js";
import { createContainer } from "./container.js";

/**
 * Vercel entry: the same app as src/index.ts, as a fetch handler (no Node server, no .env file — settings
 * come from the project's environment variables). Static files are served by Vercel itself (vercel.json).
 */
const env = loadEnv();
const problems = productionProblems(env);
if (problems.length) throw new Error(`Refusing to start in production: ${problems.join("; ")}`);

export const app = createApp(createContainer(env));
