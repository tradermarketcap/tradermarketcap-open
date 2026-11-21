import { getJSON } from '../../src/util.mjs';
import { erc20TotalSupply, erc20Balance, splBalance, trc20Balance, sol, substrateValue, EXPLORER } from '../chains.mjs';
import { resetSupply } from './trac.mjs';
import { extraSupply } from './extra.mjs';

const BURN = '0x000000000000000000000000000000000000dEaD';

const tokenLink = p => p.chain === 'sol' ? `https://solscan.io/token/${p.address}`
  : p.chain === 'tron' ? `https://tronscan.org/#/token20/${p.address}`
  : `${EXPLORER[p.chain]}/token/${p.address}`;
const holderLink = (p, h) => p.chain === 'sol' ? `https://solscan.io/account/${h}`
  : p.chain === 'tron' ? `https://tronscan.org/#/address/${h}`
  : `${EXPLORER[p.chain]}/token/${p.address}?a=${h}`;

async function tokenTotal(p) {
  if (p.chain === 'sol') return Number((await sol('getTokenSupply', [p.address])).value.uiAmountString);
  if (p.chain === 'tron') {
    const t = (await getJSON(`https://apilist.tronscanapi.com/api/token_trc20?contract=${p.address}&showAll=1`)).trc20_tokens[0];
    return Number(t.total_supply_with_decimals) / 10 ** Number(t.decimals);
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
    return { circulating: v.circulating / 1e9, total: v.total / 1e9, src: 'https://explorer.solana.com/supply', note: 'Solana RPC getSupply (non-circulating accounts excluded by the chain' };
  },
  // ... other existing methods ...
  async ton(r) {
    const url = 'https://tonapi.io/v2/blockchain/getSupply';
    const data = await getJSON(url);
    const decimals = r.decimals ?? 9;
    const circulating = Number(data.circulating) / 10 ** decimals;
    const total = Number(data.total) / 10 ** decimals;
    if (!(circulating > 0)) throw new Error('bad circulation');
    return { circulating, total, src: url };
  }
};

export async function getSupply(rule) {
  const method = METHODS[rule.supply.method];
  if (!method) throw new Error('unknown supply method ' + rule.supply.method);
  const result = await method(rule.supply);

  // Apply extraSupply for excluded wallets if the rule defines them.
  if (rule.supply.excluded) {
    const extra = await extraSupply(rule.supply, result.total);
    if (extra) {
      result.circulating -= extra.circulating;
      result.total -= extra.total;
      result.excluded = extra.excluded;
    }
  }
  return result;
}
