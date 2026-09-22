// GET /api/runs?target=&ligand=&wallet=&limit=&offset=&order=   the run index (SPEC.md 8.4, extended to SPEC.md 9).
//
//   -> { ok, live, runs: [Run], total, head, limit, offset, order }
//      Run { id, wallet, targetId, ligandId, scoreMilli, epoch, time, block, tx, pose,
//            methodHash, payment: { method: 'eth' | 'token', code, amount (wei or token base units, string) } | null,
//            reviews: { count, starSum, average }, analysisAttached }
//      pose is the canonical pose bytes as 0x hex (int16 big-endian x 3 per atom, topology order); js/chain.js
//      turns it back into an Int16Array. limit 1..1000 (default 100), offset >= 0, order desc (newest first) or asc.
//
// GET /api/runs?id=N            one docking test with everything: the Run above plus method (the JSON text or null),
//                               reviewList [{ reviewer, stars, note, block, tx }] newest first (latest per reviewer),
//                               analysis { provider, text, block, tx } | null   -> { ok, live, head, run }; 404 { error: 'no-run' }
// GET /api/runs?view=ledger     the whole record without poses: { ok, live, head, runs, settled, funded, reviews, analyses }
//                               (what js/gamify.js computes XP, levels and badges from; wei as strings)
//
// Built from RunScored, Paid, Method, Reviewed, Analysis, Funded, Settled and Rolled logs (with run(id).time and
// methodHash from the views), fetched incrementally from the last seen block and kept in memory per instance for
// 10 s. Review notes, method JSON and analysis text are other people's text: the pages render them with el().
// Not live: 200 with live: false and an empty list. Bad query: 400 with the field named. Chain unreachable: 502.
// cache-control: public, s-maxage=10, stale-while-revalidate=60.
import { handle, runsQuery } from './_lab.mjs';

export default handle(({ query, signal }) => runsQuery(query, { signal }));
