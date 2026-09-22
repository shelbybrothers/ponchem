// GET /api/report          the cancer research report as Markdown (text/markdown), same data as js/chain.js report()
// GET /api/report?format=json   the compiled report object (bigints as decimal strings)
//
// SPEC.md 8.4 names the path /api/report.md: vercel.json rewrites it here and tools/dev.mjs strips the .md.
//
// Title, the compiled line, then per cancer group the top ten pairs by binding free energy with dG, pKd, ligand
// efficiency, runs, distinct wallets, a Reviews column (count and average stars), the target's pool and a Link
// column to the test page (https://ponchem.ai/run?id=N); then the most reviewed docking tests, and a closing
// method note from docs/copy.md. The JSON shape carries runId and url on every best pair and target best, plus
// mostReviewed and reviewCount. Not live or no runs: the body says "No runs recorded yet". No dashes anywhere.
// cache-control: public, s-maxage=10, stale-while-revalidate=60.
import { handle, reportData, reportMarkdown } from './_lab.mjs';

export default handle(async ({ query, signal }) => {
  if (String(query.format || '').toLowerCase() === 'json') return { status: 200, body: { ok: true, ...(await reportData({ signal })) } };
  return { status: 200, body: await reportMarkdown({ signal }), type: 'markdown' };
});
