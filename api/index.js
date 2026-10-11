// Vercel function: every path that isn't a static file is rewritten here (see vercel.json).
// The app is built from src/ into dist/ by `npm run build` before functions are bundled.
import { app } from "../dist/vercel.js";

const handle = (request) => app.fetch(request);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const OPTIONS = handle;
