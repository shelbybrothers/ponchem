// GET /api/status: labStatus() as JSON (SPEC.md 8.4, payment fields from SPEC.md 9.1).
//
//   -> { ok, live, reason, chainId, chain, epoch, epochStart, epochEnd, epochLength, genesis,
//        runFee (wei string), runFeeEth, runPrice ($PONCHEM base units, string), runPriceTokens, feeBps,
//        token (null until the launch), ethAllowed, tokenAllowed, tokenOpen (token set and allowed),
//        runCount, targetCount, ligandCount, poolTotal, poolTotalEth, poolsOk, head, generatedAt }
//
// While the lab contract is not deployed it answers 200 with live: false and the reason. When the chain cannot be
// read it answers 502 { ok: false, error: 'chain-unavailable' } so nothing caches a bad answer. Never carries the
// contract address or the treasury. cache-control: public, s-maxage=10, stale-while-revalidate=60.
import { handle, status } from './_lab.mjs';

export default handle(({ signal }) => status({ signal }));
