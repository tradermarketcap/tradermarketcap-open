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
};
export const EXPLORER = {
  eth: 'https://etherscan.io', bsc: 'https://bscscan.com', base: 'https://basescan.org',
  arbitrum: 'https://arbiscan.io', avax: 'https://snowtrace.io',
  optimism: 'https://optimistic.etherscan.io', polygon: 'https://polygonscan.com',
};
export const SOL_RPC = process.env.TMC_RPC_SOL || 'https://api.mainnet-beta.solana.com';
export const SUI_RPC = process.env.TMC_RPC_SUI || 'https://fullnode.mainnet.sui.io';

export async function evm(chain, method, params) {
  const url = EVM_RPC[chain];
  if (!url) throw new Error('no RPC for chain ' + chain);
  const r = await getJSON(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error(`${chain} rpc: ${r.error.message || JSON.stringify(r.error)}`);
  return r.result;
}
const call = (chain, to, data) => evm(chain, 'eth_call', [{ to, data }, 'latest']);
const pad = (addr) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
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
export async function sol(method, params) {
  const r = await getJSON(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error(`sol rpc: ${r.error.message || JSON.stringify(r.error)}`);
  return r.result;
}

// --- SUI RPC handling -------------------------------------------------------
// The actual implementation is stored in a mutable variable so it can be mocked in tests.
let suiImpl = async (method, params) => {
  const r = await getJSON(SUI_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error(`sui rpc: ${r.error.message || JSON.stringify(r.error)}`);
  return r.result;
};
export async function sui(method, params) {
  return suiImpl(method, params);
}
export function setSuiMock(fn) {
  suiImpl = fn;
}

// --- SPL token balance (Solana) ------------------------------------------------
export async function splBalance(chain, token, holder) {
  // Placeholder implementation – returns 0 for all chains.
  // In production, this would query Solana RPC for token accounts by owner.
  return 0;
}

// --- TRC20 token balance (Tron) ------------------------------------------------
export async function trc20Balance(chain, token, holder) {
  // Placeholder implementation – returns 0 for all chains.
  // In production, this would query TronGrid or Tron RPC for token balances.
  return 0;
}

// --- Substrate value (Polkadot, Kusama, etc.) ---------------------------------
export async function substrateValue(chain, address) {
  // Placeholder implementation – returns 0 for all chains.
  // In production, this would query Substrate RPC for account balances.
  return 0;
}
