// Supply read by us, from the chains themselves (or chain explorers that just add up chain data).
// Each checked coin has a rule in coins.json: { supply: { method, ... } }. A rule may list wallets that are
// not circulating (team, treasury, locked, burn) with a reason; their balances are read from the chain and
// subtracted, and the coin page shows each one.
import { getJSON } from '../../src/util.mjs';
import { erc20TotalSupply, erc20Balance, splBalance, trc20Balance, sol, substrateValue, EXPLORER } from '../chains.mjs';
import { resetSupply } from './trac.mjs';
import { extraSupply } from './extra.mjs';

const BURN = '0x000000000000000000000000000000000000dEaD';

const tokenLink = p => p.chain === 'sol' ? `https://solscan.io/token/${p.address}`
  : p.chain === 'tron' ? `https://tronscan.org/#/token20/${p.address}`
  : p.chain === 'sui' ? `https://suiscan.xyz/mainnet/coin/${p.address}`
  : `${EXPLORER[p.chain]}/token/${p.address}`;
const holderLink = (p, h) => p.chain === 'sol' ? `https://solscan.io/account/${h}`
  : p.chain === 'tron' ? `https://tronscan.org/#/address/${h}`
  : p.chain === 'sui' ? `https://suiscan.xyz/mainnet/object/${h}`
  : `${EXPLORER[p.chain]}/token/${p.address}?a=${h}`;

async function tokenTotal(p) {
  if (p.chain === 'sol') return Number((await sol('getTokenSupply', [p.address])).value.uiAmountString);
  if (p.chain === 'tron') {
    const t = (await getJSON(`https://apilist.tronscanapi.com/api/token_trc20?contract=${p.address}&showAll=1`)).trc20_tokens[0];
    return Number(t.total_supply_with_decimals) / 10 ** Number(t.decimals);
  }
  if (p.chain === 'sui') {
    // SUI support is not yet implemented in this PR
    throw new Error('SUI supply not yet implemented');
  }
  return erc20TotalSupply(p.chain, p.address);
}

const METHODS = {
  async blockchair(r) {
    const url = `https://api.blockchair.com/${r.chain}/stats`;
    const c = (await getJSON(url)).data.circulation / 10 ** (r.decimals ?? 8);
    if (!(c > 0)) throw new Error('bad circulation');
    return { circulating: c, total: c, src: url };
  },
  async 'eth-ultrasound'() {
    const url = 'https://ultrasound.money/api/v2/fees/eth-supply-parts';
    const p = await getJSON(url);
    const s = Number(BigInt(p.executionBalancesSum) / 10n ** 12n) / 1e6 + (Number(p.beaconBalancesSum) - Number(p.beaconDepositsSum)) / 1e9;
    return { circulating: s, total: s, src: url, note: 'Execution-layer balances + beacon balances − beacon deposits' };
  },
  async solana() {
    const v = (await sol('getSupply', [{ excludeNonCirculatingAccountsList: true }])).value;
    return { circulating: v.circulating / 1e9, total: v.total / 1e9, src: 'https://explorer.solana.com/supply', note: 'Solana RPC getSupply (non-circulating accounts excluded by the chain)' };
  },
  async sui(r) {
    // SUI support is not yet implemented in this PR
    throw new Error('SUI supply not yet implemented');
  },
  async tokens(r) {
    const total = await tokenTotal(r);
    let circulating = total;
    const excluded = [];
    for (const w of r.wallets || []) {
      const bal = await erc20Balance(r.chain, r.address, w.address);
      circulating -= bal;
      excluded.push({ address: w.address, balance: bal, reason: w.reason, link: holderLink(r, w.address) });
    }
    if (circulating <= 0) throw new Error('bad circulating supply');
    return { circulating, total, src: tokenLink(r), note: 'Total supply minus excluded wallets', excluded };
  },
  async reset() {
    return resetSupply();
  },
  async extra(r) {
    return extraSupply(r);
  },
};

export async function readSupply(rule) {
  const m = METHODS[rule.method];
  if (!m) throw new Error('unknown supply method ' + rule.method);
  return m(rule);
}
