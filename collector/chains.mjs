// Small chain readers used for supply and DEX pool prices. Public endpoints; override with env vars.
import { getJSON } from '../src/util.mjs';

export const EVM_RPC = {
  eth: process.env.TMC_RPC_ETH || 'https://eth.drpc.org',
  bsc: process.env.TMC_RPC_BSC || 'https://bsc-dataseed.bnbchain.org',
  base: process.env.TMC_RPC_BASE || 'https://mainnet.base.org',
  arbitrum: process.env.TMC_RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc',
  avax: process.env.TMC_RPC_AVAX || 'https://api.avax.network/ext/bc/C/rpc',
  optimism: process.env.TMC_RPC_OPTIMISM || 'https://mainnet.optimism.io',
  polygon: process.env.TMC_RPC_POLYGON || 'https://polygon.drpc.org',
  monad: process.env.TMC_RPC_MONAD || 'https://rpc.monad.xyz',
};
export const EXPLORER = {
  eth: 'https://etherscan.io', bsc: 'https://bscscan.com', base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io', avax: 'https://snowtrace.io',
  optimism: 'https://optimistic.etherscan.io', polygon: 'https://polygonscan.com',
  monad: 'https://monadscan.com',
};
export const SOL_RPC = process.env.TMC_RPC_SOL || 'https://api.mainnet-beta.solana.com';

export async function evm(chain, method, params) {
  const url = EVM_RPC[chain];
  if (!url) throw new Error('no RPC for chain ' + chain);
  const r = await getJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (r.error) throw new Error(`${chain} rpc: ${r.error.message || JSON.stringify(r.error)}`);
  return r.result;
}
const call = (chain, to, data) => evm(chain, 'eth_call', [{ to, data }, 'latest']);
const pad = addr => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const word = (hex, i) => BigInt('0x' + (hex.slice(2 + 64 * i, 2 + 64 * (i + 1)) || '0'));

const decCache = new Map();
export async function erc20Decimals(chain, token) {
  const k = chain + token.toLowerCase();
  if (!decCache.has(k)) decCache.set(k, Number(BigInt(await call(chain, token, '0x313ce567'))));
  return decCache.get(k);
}
export async function erc20TotalSupply(chain, token) {
  const [raw, d] = await Promise.all([call(chain, token, '0x18160ddd'), erc20Decimals(chain, token)]);
  return Number(BigInt(raw)) / 10 ** d;
}
export async function erc20Balance(chain, token, holder) {
  const [raw, d] = await Promise.all([call(chain, token, '0x70a08231' + pad(holder)), erc20Decimals(chain, token)]);
  return Number(BigInt(raw)) / 10 ** d;
}

// Public RPCs (Solana, TronGrid) rate-limit with 429: back off and retry a few times.
async function retry429(f) {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i >= 3 || !/^429 /.test(e.message)) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
}

export async function sol(method, params) {
  const r = await retry429(() => getJSON(SOL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  if (r.error) throw new Error('solana rpc: ' + r.error.message);
  return r.result;
}

// SPL token balance of a wallet (all its token accounts for that mint), or of one token account.
// Read errors throw (never count a failed read as 0, which would overstate circulating).
export async function splBalance(mint, holder) {
  const r = await sol('getTokenAccountsByOwner', [holder, { mint }, { encoding: 'jsonParsed' }]).catch(e => { if (/429|fetch|abort/i.test(e.message)) throw e; return null; });
  if (r?.value?.length) return r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString), 0);
  const t = await sol('getTokenAccountBalance', [holder]).catch(e => { if (/429|fetch|abort/i.test(e.message)) throw e; return null; });
  return t?.value ? Number(t.value.uiAmountString) : 0;
}

// TRC-20 balance via TronGrid (constant call, base58 addresses).
export const TRON_API = process.env.TMC_TRON_API || 'https://api.trongrid.io';
export async function trc20Balance(token, holder) {
  const call = sel => retry429(() => getJSON(TRON_API + '/wallet/triggerconstantcontract', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner_address: holder, contract_address: token, function_selector: sel.fn, parameter: sel.p || '', visible: true }) }));
  const p = tronToHex(holder).slice(2).padStart(64, '0');
  const [bal, dec] = await Promise.all([call({ fn: 'balanceOf(address)', p }), call({ fn: 'decimals()' })]);
  return Number(BigInt('0x' + (bal.constant_result?.[0] || '0'))) / 10 ** Number(BigInt('0x' + (dec.constant_result?.[0] || '0')));
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function tronToHex(addr) {
  let n = 0n;
  for (const c of addr) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(50, '0').slice(0, 42); // 21-byte address (41...), checksum dropped
}

// Uniswap v2-style pool (Uniswap v2, PancakeSwap v2, Sushi...): price of `token` in the other token.
export async function v2PoolPrice(chain, pair, token) {
  const [res, t0, t1] = await Promise.all([call(chain, pair, '0x0902f1ac'), call(chain, pair, '0x0dfe1681'), call(chain, pair, '0xd21220a7')]);
  const a0 = '0x' + t0.slice(-40), a1 = '0x' + t1.slice(-40);
  const [d0, d1] = await Promise.all([erc20Decimals(chain, a0), erc20Decimals(chain, a1)]);
  const r0 = Number(word(res, 0)) / 10 ** d0, r1 = Number(word(res, 1)) / 10 ** d1;
  const isT0 = a0 === token.toLowerCase();
  return { price: isT0 ? r1 / r0 : r0 / r1, quoteReserve: isT0 ? r1 : r0, quoteToken: isT0 ? a1 : a0 };
}

// Uniswap v3-style pool: price from slot0.sqrtPriceX96.
export async function v3PoolPrice(chain, pool, token) {
  const [s0, t0, t1] = await Promise.all([call(chain, pool, '0x3850c7bd'), call(chain, pool, '0x0dfe1681'), call(chain, pool, '0xd21220a7')]);
  const a0 = '0x' + t0.slice(-40), a1 = '0x' + t1.slice(-40);
  const [d0, d1] = await Promise.all([erc20Decimals(chain, a0), erc20Decimals(chain, a1)]);
  const sq = Number(word(s0, 0)) / 2 ** 96;
  const p1per0 = sq * sq * 10 ** (d0 - d1); // token1 per token0
  const isT0 = a0 === token.toLowerCase();
  const quoteReserve = await erc20Balance(chain, isT0 ? a1 : a0, pool).catch(() => null);
  return { price: isT0 ? p1per0 : 1 / p1per0, quoteReserve, quoteToken: isT0 ? a1 : a0 };
}

// Substrate chains (Bittensor...): read a plain storage value over JSON-RPC. Keys are twox128(pallet) + twox128(item).
const M64 = (1n << 64n) - 1n;
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n, P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M64;
const round = (acc, v) => (rotl((acc + v * P2) & M64, 31) * P1) & M64;
const merge = (acc, v) => (((acc ^ round(0n, v)) * P1 + P4) & M64);
function xxh64(buf, seed) {
  const u64 = i => buf.readBigUInt64LE(i), u32 = i => BigInt(buf.readUInt32LE(i));
  let i = 0, h;
  if (buf.length >= 32) {
    let v1 = (seed + P1 + P2) & M64, v2 = (seed + P2) & M64, v3 = seed, v4 = (seed - P1) & M64;
    for (; i + 32 <= buf.length; i += 32) { v1 = round(v1, u64(i)); v2 = round(v2, u64(i + 8)); v3 = round(v3, u64(i + 16)); v4 = round(v4, u64(i + 24)); }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M64;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else h = (seed + P5) & M64;
  h = (h + BigInt(buf.length)) & M64;
  for (; i + 8 <= buf.length; i += 8) h = ((rotl(h ^ round(0n, u64(i)), 27) * P1) + P4) & M64;
  if (i + 4 <= buf.length) { h = ((rotl(h ^ ((u32(i) * P1) & M64), 23) * P2) + P3) & M64; i += 4; }
  for (; i < buf.length; i++) h = (rotl(h ^ ((BigInt(buf[i]) * P5) & M64), 11) * P1) & M64;
  h ^= h >> 33n; h = (h * P2) & M64; h ^= h >> 29n; h = (h * P3) & M64; h ^= h >> 32n;
  return h;
}
const le64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b.toString('hex'); };
export const twox128 = s => { const b = Buffer.from(s); return le64(xxh64(b, 0n)) + le64(xxh64(b, 1n)); };
export async function substrateValue(url, pallet, item) {
  const r = await getJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_getStorage', params: ['0x' + twox128(pallet) + twox128(item)] }) });
  if (!r.result) throw new Error('empty storage ' + pallet + '.' + item);
  return BigInt('0x' + Buffer.from(r.result.slice(2), 'hex').reverse().toString('hex')); // SCALE little-endian uint
}
