/*
 * PONCHEM shared configuration (js/config.js).
 *
 * A plain ES module with no DOM access at import time, so browser pages, the Node API routes (api/*.js) and the
 * tools import the same file. Addresses are EIP-55 checksummed. This is the ONLY file that may carry an app
 * contract address: pages never print one (SPEC.md, 2.3).
 *
 * One region is generated and never edited by hand:
 *   GENERATED:DEPLOY   by contracts/deploy.sh: the PonchemLab address, its deploy block and the epoch genesis
 */

export const CHAIN = Object.freeze({
  id: 4663,
  hex: '0x1237',
  name: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com', // public node, no CORS: browsers use rpcProxy
  rpcProxy: '/api/rpc',
  // What a wallet is given when it adds the network: the official node first, then a public node that was checked
  // to answer chain id 0x1237 and keep up with the head (both send CORS headers). Same list as chainid.network.
  walletRpcUrls: Object.freeze(['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com']),
  explorer: 'https://robinhoodchain.blockscout.com',
  nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
  maxBatch: 5, // the node refuses bigger JSON-RPC batches
  logsChunk: 10_000_000, // eth_getLogs block span per request
});

/* Explorer links for things a page MAY show: transaction hashes and the visitor's own wallet. Never the lab. */
export const EXPLORER = Object.freeze({
  tx: (hash) => `${CHAIN.explorer}/tx/${hash}`,
  address: (address) => `${CHAIN.explorer}/address/${address}`,
  block: (number) => `${CHAIN.explorer}/block/${number}`,
});

export const BRAND = Object.freeze({
  name: 'Ponchem',
  domain: 'ponchem.ai',
  url: 'https://ponchem.ai',
  x: 'https://x.com/PonchemAI',
  xHandle: 'PonchemAI',
  tagline: 'Computer-aided drug design, scored on chain.',
  footer: '2026 Pons Lab CADD (Computer-aided Drug Design)',
});

// $PONCHEM launches later on ponsfamily.com. Until then ca and buyUrl are null: the Buy link is inert and reads
// TOKEN_BUY_BLANK, Copy CA is disabled and its title reads TOKEN_CA_BLANK, and no page carries a 0x string.
// When the coin is live, set BOTH (buyUrl is the launchpad page of that CA) and run node tools/shell.mjs, which
// stamps the live footer and nav into every page; js/shell.js does the same at run time from the same TOKEN.
export const TOKEN = Object.freeze({
  symbol: 'PONCHEM',
  // live on ponsfamily.com since 2026-09-22; checked on chain: name "ponchem.ai", symbol PONCHEM, 18 decimals
  ca: '0x8e997cCF391De70033aD416f9f0048996417484D',
  buyUrl: 'https://www.ponsfamily.com/launchpad/0x8e997cCF391De70033aD416f9f0048996417484D',
  launchpad: 'https://ponsfamily.com',
});
export const TOKEN_CA_BLANK = 'CA posts here at launch';
export const TOKEN_BUY_BLANK = 'Buy $PONCHEM · soon';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/*
 * The lab contract (contracts/src/PonchemLab.sol). `address` stays null until contracts/deploy.sh has put it on
 * Robinhood Chain and rewritten the block below. While it is null the pages say the lab opens when the contract is
 * live and send nothing. `genesis` is the epoch-zero timestamp (unix seconds) the contract was deployed with.
 * On localhost only, ?contract=0x.. (with ?rpc=http://127.0.0.1:PORT) points the pages at a local node instead.
 */
// GENERATED:DEPLOY:BEGIN (contracts/deploy.sh rewrites this block)
export const LAB = Object.freeze({
  address: '0xc80919259F290448377489c9dc152b341F288251',
  deployBlock: 69391464,
  genesis: 1790053441,
});
// GENERATED:DEPLOY:END

/** True once the lab contract is deployed (the GENERATED:DEPLOY block carries its address). */
export function labLive() {
  return !!LAB.address;
}

/* Protocol constants from SPEC.md, mirrored from contracts/src/PonchemLab.sol. The deployed contract is the authority. */
export const PROTOCOL = Object.freeze({
  feeBps: 500, // 5% of a settled prize pool goes to the treasury; the best binder receives the rest
  epochSeconds: 7 * 24 * 3600, // one prize epoch per target
});
