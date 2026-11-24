// Supply read by us, from the chains themselves (or chain explorers that just add up chain data).
// Each checked coin has a rule in coins.json: { supply: { method, ... } }. A rule may list wallets that are
// not circulating (team, treasury, locked, burn) with a reason; their balances are read from the chain and
// subtracted, and the coin page shows each one.
import { getJSON } from '../../src/util.mjs';
import { erc20TotalSupply, erc20Balance, splBalance, trc20Balance, sol, substrateValue, evm, EXPLORER } from '../chains.mjs';
import { resetSupply } from './trac.mjs';
import { extraSupply } from './extra.mjs';

const BURN = '0x000000000000000000000000000000000000dEaD';
// Avalanche's C-chain burn address: base fees are sent here and can never move.
const AVAX_BURN = '0x0100000000000000000000000000000000000000';
const LINK_TOKEN = '0x514910771AF9Ca656af840dff83E8264EcF986CA'; // Chainlink ERC-20 on Ethereum

// BNB on BNB Smart Chain (BSC). BSC mints no new BNB: validators earn fees only. Every BNB that existed when BSC
// launched was put in the TokenHub system contract at genesis (176,405,560.9 BNB, plus 1,000 BNB for two bootstrap
// accounts). That is in the bscMainnetAllocData of the official client (github.com/bnb-chain/bsc, core/genesis_alloc.go)
// and anyone can check it on an archive node: eth_getBalance(TokenHub, block 0).
// BNB still inside TokenHub is not spendable on BSC: it is BNB burned on the old Beacon Chain, or Beacon Chain balances
// nobody has claimed since the BC Fusion shut the Beacon Chain down. BNB at 0x...dEaD (quarterly auto-burns and the
// BEP-95 per-block fee burn) and at the zero address can never move. So the chain itself gives a ceiling:
//   genesis − TokenHub − dead address − zero address.
// BNB Chain's own burn tracker (bnbburn.info, linked from BEP-95 and run by NodeReal for BNB Chain) also publishes
// circulating supply. We use the lower of the two, so circulating is never overstated; if the tracker can't be read or
// looks broken, the whole read fails and the site keeps the last good number.
const BSC_GENESIS_BNB = 176406560.9;
const BSC_TOKENHUB = '0x0000000000000000000000000000000000001004';
const BSC_ZERO = '0x0000000000000000000000000000000000000000';
const BNB_TRACKER = 'https://www.bnbburn.info/api/getBnbSupply';

// Native BNB balance of one BSC address, read from BNB Chain's public RPC.
async function bscBalance(addr) {
  const hex = await evm('bsc', 'eth_getBalance', [addr, 'latest']);
  if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex)) throw new Error('bad BSC balance for ' + addr);
  return Number(BigInt(hex) / 10n ** 12n) / 1e6;
}

// Circulating supply from BNB Chain's burn tracker (BSC plus any left on the Beacon Chain).
async function bnbTracker() {
  const d = await getJSON(BNB_TRACKER);
  const s = Number(d.bscSupply) + Number(d.bcSupply || 0);
  if (!(s > 0)) throw new Error('bad BNB tracker supply');
  return s;
}

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
  // Read /thorchain/supply from THORNode through Liquify's public gateway. THORChain excludes
  // only the protocol reserve from circulation, so bonded RUNE and RUNE in liquidity pools count.
  async thorchain() {
    const src = 'https://gateway.liquify.com/chain/thorchain_api/thorchain/supply';
    const { total, circulating, locked } = await getJSON(src);
    const reserve = locked?.reserve;
    if (![total, circulating, reserve].every(value => Number.isSafeInteger(value) && value >= 0) || total === 0) {
      throw new Error('invalid THORNode RUNE supply');
    }
    // THORNode subtracts the reserve in base units, then truncates each field to whole RUNE.
    const remainder = total - circulating - reserve;
    if (remainder !== 0 && remainder !== 1) throw new Error('inconsistent THORNode RUNE supply');
    return {
      total, circulating, src,
      excluded: [{ reason: 'THORChain reserve module', amount: reserve, src }],
      note: 'THORNode bank supply less the reserve. Bonded and pooled RUNE count as circulating.',
    };
  },
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
  async 'cardano-koios'() {
    const url = 'https://api.koios.rest/api/v1/totals';
    const t = (await getJSON(url))[0];
    return { circulating: Number(t.circulation) / 1e6, total: Number(t.supply) / 1e6, src: url + '?_epoch_no=' + t.epoch_no, note: 'Treasury and reserves not counted' };
  },
  async tron() {
    const url = 'https://apilist.tronscanapi.com/api/funds';
    const f = await getJSON(url);
    return { circulating: Number(f.circulationSupply), total: Number(f.totalTurnOver), src: 'https://tronscan.org/#/data/stats2/supply' };
  },
  // XRP: total on the ledger minus XRP held by Ripple (escrow + its own wallets). Ripple's accounts are found by their
  // public XRPSCAN name tag; each one's balance and escrow objects are then read from the XRP Ledger itself.
  async xrpl() {
    const rpc = 'https://s1.ripple.com:51234';
    const q = (method, params) => getJSON(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [{ ledger_index: 'validated', ...params }] }) }).then(r => r.result);
    const total = Number((await q('ledger', {})).ledger.total_coins) / 1e6;
    const rich = await getJSON('https://api.xrpscan.com/api/v1/balances', { timeout: 30000 });
    const ripple = rich.filter(a => a.name?.name === 'Ripple' && (a.balance + (a.escrow || 0)) / 1e6 >= 1e6).map(a => a.account);
    if (ripple.length < 5) throw new Error('Ripple accounts not found');
    let esc = 0, bal = 0;
    for (const acct of ripple) {
      bal += Number((await q('account_info', { account: acct })).account_data.Balance) / 1e6;
      let marker;
      do {
        const r = await q('account_objects', { account: acct, type: 'escrow', limit: 400, marker });
        for (const o of r.account_objects) if (o.Account === acct && typeof o.Amount === 'string') esc += Number(o.Amount) / 1e6;
        marker = r.marker;
      } while (marker);
    }
    return { circulating: total - esc - bal, total, src: 'https://livenet.xrpl.org',
      excluded: [{ reason: `Ripple escrow (${ripple.length} Ripple accounts)`, amount: esc, src: 'https://xrpscan.com/balances' },
        { reason: 'Ripple-held wallets (not escrowed)', amount: bal, src: 'https://xrpscan.com/balances' }],
      note: 'XRP Ledger total minus escrow and wallets of accounts XRPSCAN tags as Ripple' };
  },
  // Zcash: issuance follows a fixed schedule by block height (slow start, Blossom, halvings).
  async 'zcash-schedule'() {
    const url = 'https://api.blockchair.com/zcash/stats';
    const h = (await getJSON(url)).data.best_block_height;
    if (!(h > 3e6)) throw new Error('bad zcash height');
    let s = 125000 + (653600 - 20000) * 12.5 + (1046400 - 653600) * 6.25; // through the first halving: 10.5M
    let start = 1046400, sub = 3.125;
    while (h > start) { const end = start + 1680000; s += (Math.min(h, end) - start) * sub; start = end; sub /= 2; }
    return { circulating: s, total: s, src: 'https://blockchair.com/zcash', note: `Issued by block ${h} under the Zcash issuance schedule (includes the in-protocol dev fund lockbox)` };
  },
  // Bitcoin-schedule coins without a supply endpoint (BSV: 50 per block halving every 210,000 blocks; Ravencoin: 5,000 / 2.1M).
  async 'btc-schedule'(r) {
    const j = await getJSON(r.heightUrl);
    const h = (r.heightField || 'blocks').split('.').reduce((o, k) => o?.[k], j);
    if (!(h > 1e5)) throw new Error('bad height');
    const step = r.halving || 210000;
    let s = 0, sub = r.reward || 50;
    for (let start = 0; start <= h; start += step, sub /= 2) s += (Math.min(h + 1, start + step) - start) * sub;
    return { circulating: s, total: s, src: r.src || r.heightUrl, note: `Issued by block ${h} under the ${r.schedule || 'Bitcoin'} issuance schedule` };
  },
  // Hyperliquid L1 reports circulating supply itself (team, foundation and future-emission balances not counted).
  async hyperliquid(r) {
    const d = await getJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'tokenDetails', tokenId: r.tokenId }) });
    return { circulating: Number(d.circulatingSupply), total: Number(d.totalSupply), src: 'https://app.hyperliquid.xyz/explorer', note: 'Hyperliquid L1 tokenDetails (non-circulating balances excluded by the chain)' };
  },
  async nearblocks() {
    const t = (await getJSON('https://api.nearblocks.io/v1/stats')).stats[0];
    return { circulating: Number(BigInt(t.circulating_supply) / 10n ** 18n) / 1e6, total: Number(BigInt(t.total_supply) / 10n ** 18n) / 1e6, src: 'https://nearblocks.io/charts/near-supply', note: 'NearBlocks explorer: total minus lockup contracts not yet vested' };
  },
  // Stellar: SDF's supply endpoint (computed from the ledger); burned lumens and SDF's mandate wallets not counted.
  async 'stellar-sdf'() {
    const d = await getJSON('https://dashboard.stellar.org/api/v3/lumens');
    return { circulating: Number(d.circulatingSupply), total: Number(d.totalSupply), src: 'https://dashboard.stellar.org',
      excluded: [{ reason: 'SDF mandate wallets', amount: Number(d.sdfMandate), src: 'https://dashboard.stellar.org' }, { reason: 'Upgrade reserve and fee pool', amount: Number(d.upgradeReserve) + Number(d.feePool), src: 'https://dashboard.stellar.org' }],
      note: 'Stellar Development Foundation supply metrics, read from the ledger' };
  },
  async icp() {
    const [c, t] = await Promise.all(['circulating', 'total'].map(k => getJSON(`https://ledger-api.internetcomputer.org/supply/${k}/latest`)));
    return { circulating: Number(c[1]) / 1e8, total: Number(t[1]) / 1e8, src: 'https://dashboard.internetcomputer.org' };
  },
  async hedera() {
    const d = await getJSON('https://mainnet-public.mirrornode.hedera.com/api/v1/network/supply');
    return { circulating: Number(BigInt(d.released_supply) / 10n ** 6n) / 100, total: Number(BigInt(d.total_supply) / 10n ** 6n) / 100, src: 'https://mainnet-public.mirrornode.hedera.com/api/v1/network/supply', note: 'Hedera mirror node released supply (treasury accounts not counted)' };
  },
  async kaspa() {
    const d = await getJSON('https://api.kaspa.org/info/coinsupply');
    const c = Number(BigInt(d.circulatingSupply) / 10n ** 4n) / 1e4;
    return { circulating: c, total: c, src: 'https://api.kaspa.org/info/coinsupply' };
  },
  async stacks() {
    const d = await getJSON('https://api.hiro.so/extended/v1/stx_supply');
    return { circulating: Number(d.unlocked_stx), total: Number(d.total_stx), src: 'https://explorer.hiro.so', note: 'Hiro Stacks API: unlocked STX' };
  },
  async tezos() {
    const d = await getJSON('https://api.tzkt.io/v1/statistics/current');
    return { circulating: d.circulatingSupply / 1e6, total: d.totalSupply / 1e6, src: 'https://tzkt.io/stats', note: 'TzKT explorer: total minus unclaimed fundraiser and locked commitments' };
  },
  async casper() {
    const d = (await getJSON('https://api.cspr.live/supply')).data;
    return { circulating: d.circulating, total: d.total, src: 'https://cspr.live', note: 'CSPR.live explorer: total minus locked genesis stakes' };
  },
  async filecoin() {
    const d = await getJSON('https://filfox.info/api/v1/overview');
    const f = x => Number(BigInt(x) / 10n ** 12n) / 1e6;
    return { circulating: f(d.circulatingSupply), total: f(d.totalSupply), src: 'https://filfox.info/en/stats/supply', note: 'Filecoin protocol circulating supply (locked pledges, vesting and burns not counted)' };
  },
  // Blockscout "coinsupply" for EVM chains whose whole supply circulates (e.g. Ethereum Classic).
  async 'blockscout-coinsupply'(r) {
    const c = Number((await getJSON(r.url)).result);
    if (!(c > 0)) throw new Error('bad coinsupply');
    return { circulating: c, total: c, src: r.url.replace(/\/api\?.*$/, '') };
  },
  // Polkadot (balances live on Asset Hub since the 2025 migration) via Parity's public sidecar.
  async polkadot(r) {
    const base = r.sidecar || 'https://polkadot-asset-hub-public-sidecar.parity-chains.parity.io';
    const d = 10n ** BigInt((r.decimals ?? 10) - 4), sub = r.subscan || 'https://assethub-polkadot.subscan.io';
    const total = Number(BigInt((await getJSON(base + '/pallets/balances/storage/TotalIssuance')).value) / d) / 1e4;
    const excluded = [];
    for (const e of r.exclude || []) {
      const b = await getJSON(`${base}/accounts/${e.holder}/balance-info`);
      excluded.push({ reason: e.reason, holder: e.holder, amount: Number((BigInt(b.free) + BigInt(b.reserved)) / d) / 1e4, src: `${sub}/account/${e.holder}` });
    }
    return { circulating: total - excluded.reduce((s, e) => s + e.amount, 0), total, src: sub, excluded };
  },
  // Cosmos SDK chains: bank supply of one denom, minus the community pool (and any listed treasury accounts).
  async cosmos(r) {
    const dec = 10 ** (r.decimals ?? 6);
    const total = Number((await getJSON(`${r.lcd}/cosmos/bank/v1beta1/supply/by_denom?denom=${r.denom}`)).amount.amount) / dec;
    const excluded = [];
    if (r.communityPool !== false) {
      const p = (await getJSON(`${r.lcd}/cosmos/distribution/v1beta1/community_pool`)).pool.find(x => x.denom === r.denom);
      if (p) excluded.push({ reason: 'Community pool (on-chain treasury)', amount: Number(p.amount) / dec, src: `${r.lcd}/cosmos/distribution/v1beta1/community_pool` });
    }
    for (const e of r.exclude || []) {
      const b = (await getJSON(`${r.lcd}/cosmos/bank/v1beta1/balances/${e.holder}/by_denom?denom=${r.denom}`)).balance;
      excluded.push({ reason: e.reason, holder: e.holder, amount: Number(b.amount) / dec, src: r.explorer ? r.explorer + e.holder : undefined });
    }
    return { circulating: total - excluded.reduce((s, e) => s + e.amount, 0), total, src: r.explorer || r.lcd, excluded, note: r.note };
  },
  // Algorand: total ALGO from a public algod node, minus the Algorand Foundation wallets the Foundation
  // publishes at algorand.co/algorand-foundation/transparency (archived copy cited in coins.json; the
  // list is embedded there; each balance is read live. algod answers 200 with amount 0 for closed
  // accounts, so any request error fails the read rather than counting 0).
  async algorand(r) {
    const api = r.api;
    const total = Number((await getJSON(`${api}/v2/ledger/supply`))['total-money']) / 1e6;
    if (!(total > 8e9)) throw new Error('bad Algorand total supply ' + total);
    const excluded = [];
    for (const e of r.exclude || []) {
      const amount = Number((await getJSON(`${api}/v2/accounts/${e.holder}`)).amount) / 1e6;
      if (!Number.isFinite(amount) || amount < 0) throw new Error('bad Algorand balance for ' + e.holder); // a malformed answer must fail, never publish NaN
      excluded.push({ reason: e.reason, holder: e.holder, amount, src: `https://allo.info/account/${e.holder}` });
    }
    // The Foundation's published wallet list can drift from its reported balance; when a
    // reportedFloor is configured, subtract the larger of the live wallet sum and the floor
    // (same pattern as bnb's burn-tracker cap).
    let subtract = excluded.reduce((s, e) => s + e.amount, 0);
    if (r.reportedFloor) {
      const floor = Number(r.reportedFloor);
      if (floor > subtract) {
        excluded.push({ reason: 'Algorand Foundation reported balance (Q2 2026 transparency report)', amount: floor - subtract, src: r.reportedFloorSrc });
        subtract = floor;
      }
    }
    return { circulating: total - subtract, total, src: api, excluded, note: r.note };
  },
  // BNB: chain-read ceiling checked against BNB Chain's burn tracker; the lower one is circulating (see top of file).
  async bnb() {
    const [hub, dead, zero, tracker] = await Promise.all([bscBalance(BSC_TOKENHUB), bscBalance(BURN), bscBalance(BSC_ZERO), bnbTracker()]);
    const ceiling = BSC_GENESIS_BNB - hub - dead - zero;
    // more than 5% apart means one of the two reads is broken: fail rather than guess
    if (Math.abs(tracker / ceiling - 1) > 0.05) throw new Error(`BNB tracker ${tracker} vs chain ${ceiling}`);
    const bsc = EXPLORER.bsc + '/address/';
    const excluded = [
      { reason: 'TokenHub: burned on Beacon Chain or not yet claimed after BC Fusion', holder: BSC_TOKENHUB, amount: hub, src: bsc + BSC_TOKENHUB },
      { reason: 'Burn address (auto-burns and BEP-95 fee burn)', holder: BURN, amount: dead, src: bsc + BURN },
      { reason: 'Zero address (unspendable)', holder: BSC_ZERO, amount: zero, src: bsc + BSC_ZERO },
    ];
    if (tracker < ceiling) excluded.push({ reason: 'Not counted to match BNB Chain burn tracker (lower number wins)', amount: ceiling - tracker, src: 'https://www.bnbburn.info' });
    return { circulating: Math.min(tracker, ceiling), total: ceiling, src: 'https://www.bnbburn.info', excluded,
      note: `BSC genesis ${BSC_GENESIS_BNB.toLocaleString('en-US')} BNB minus TokenHub, burn and zero address (read from BSC), capped by BNB Chain's burn tracker` };
  },
  async multiversx() {
    const d = await getJSON('https://api.multiversx.com/economics');
    return { circulating: d.circulatingSupply, total: d.totalSupply, src: 'https://explorer.multiversx.com', note: 'MultiversX API (staked EGLD counts as circulating)' };
  },
  async decred() {
    const d = await getJSON('https://dcrdata.decred.org/api/supply');
    return { circulating: d.supply_mined / 1e8, total: d.supply_mined / 1e8, src: 'https://dcrdata.decred.org', note: 'dcrdata explorer: coins mined so far' };
  },
  // chainz.cryptoid.info explorer: total coins on the chain (UTXO coins without another supply source).
  async cryptoid(r) {
    const url = `https://chainz.cryptoid.info/${r.coin}/api.dws?q=totalcoins`;
    const c = Number(await getJSON(url));
    if (!(c > 0)) throw new Error('bad totalcoins');
    return { circulating: c, total: c, src: `https://chainz.cryptoid.info/${r.coin}/` };
  },
  // AVAX: P-chain supply minus stake and burned AVAX.
  async avax() {
    const pchain = 'https://api.avax.network/ext/bc/P';
    const call = async method => {
      const r = await getJSON(pchain, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
      });
      if (r.error) throw new Error(`avax ${method}: ${r.error.message || 'rpc error'}`);
      if (!r.result) throw new Error(`avax ${method}: empty result`);
      return r.result;
    };
    const [sup, stk] = await Promise.all([call('platform.getCurrentSupply'), call('platform.getTotalStake')]);
    // Both are nAVAX (1e9 per AVAX).
    const supply = Number(sup.supply) / 1e9;
    const staked = Number(stk.stake) / 1e9;
    if (!(supply > 1e8)) throw new Error('bad AVAX total supply ' + sup.supply);
    if (!(staked >= 0)) throw new Error('bad AVAX P-Chain stake ' + stk.stake);
    if (staked > supply) throw new Error(`avax: stake ${staked} exceeds supply ${supply}`);
    // getCurrentSupply is an upper bound: it does not account for burnt tokens. C-chain base fees are burnt to this
    // address, so its balance is read (wei, 1e18 per AVAX) and subtracted from both total and circulating.
    const burnHex = await evm('avax', 'eth_getBalance', [AVAX_BURN, 'latest']);
    if (typeof burnHex !== 'string' || !/^0x[0-9a-f]+$/i.test(burnHex)) throw new Error('avax: bad burn balance');
    const burned = Number(BigInt(burnHex) / 10n ** 12n) / 1e6;
    const excluded = [
      { reason: 'Burned (C-chain base fees sent to the burn address)', holder: AVAX_BURN, amount: burned, src: `${EXPLORER.avax}/address/${AVAX_BURN}` },
      { reason: 'P-chain validator and delegator stake (locked)', amount: staked, src: pchain },
    ];
    return {
      circulating: supply - burned - staked,
      total: supply - burned,
      src: pchain,
      excluded,
      note: 'P-chain supply minus stake and burned AVAX',
    };
  },
  async nervos() {
    const url = 'https://mainnet-api.explorer.nervos.org/api/v1/market_data/';
    const [c, t] = await Promise.all(['circulating_supply', 'total_supply'].map(k => getJSON(url + k, { headers: { accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' } })));
    return { circulating: Number(c), total: Number(t), src: 'https://explorer.nervos.org', note: 'Nervos explorer: burned, Nervos DAO-locked and unvested genesis CKB not counted' };
  },
  // Bittensor: SubtensorModule.TotalIssuance read from a public Subtensor node (fair launch, no premine).
  async bittensor() {
    const t = Number(await substrateValue('https://entrypoint-finney.opentensor.ai', 'SubtensorModule', 'TotalIssuance')) / 1e9;
    return { circulating: t, total: t, src: 'https://entrypoint-finney.opentensor.ai', note: 'Subtensor TotalIssuance (no premine or team allocation)' };
  },
  async tokens(r) {
    let total = 0;
    const parts = [];
    for (const p of r.parts) {
      const t = await tokenTotal(p);
      total += t;
      parts.push({ chain: p.chain, amount: t, src: tokenLink(p) });
    }
    const excluded = [];
    const ex = [...(r.exclude || []), ...r.parts.filter(p => EXPLORER[p.chain] && !r.noBurn).map(p => ({ chain: p.chain, token: p.address, holder: BURN, reason: 'Burn address' }))];
    for (const e of ex) {
      const p = { chain: e.chain, address: e.token || r.parts.find(x => x.chain === e.chain)?.address };
      const bal = await (e.chain === 'sol' ? splBalance(p.address, e.holder) : e.chain === 'tron' ? trc20Balance(p.address, e.holder) : erc20Balance(e.chain, p.address, e.holder));
      // a failed read throws: better keep the last good supply than overstate circulating
      if (bal) excluded.push({ reason: e.reason, holder: e.holder, amount: bal, src: holderLink(p, e.holder) });
    }
    const out = excluded.reduce((s, e) => s + e.amount, 0);
    return { circulating: r.circulating === false ? null : total - out, total, src: parts[0]?.src, parts, excluded, note: r.note };
  },
  async reset() {
    return resetSupply();
  },
  // Chainlink (LINK): the full 1B supply has existed since 2017. Chainlink publishes the
  // official non-circulating wallet list and each wallet's balance at supply.chain.link
  // (linked from https://chain.link/circulating-supply). We subtract exactly those
  // wallets; a failed read fails the whole supply read, so the site keeps the last good number.
  async chainlink() {
    const url = 'https://supply.chain.link/supply';
    const d = await getJSON(url);
    const total = Number(BigInt(d.totalSupply)) / 1e18;
    const circ = Number(BigInt(d.circulatingSupply)) / 1e18;
    if (!(total > 0) || !(circ > 0) || circ > total) throw new Error('bad chainlink supply');
    const p = { chain: 'eth', address: LINK_TOKEN };
    const excluded = (d.balances || [])
      .map(b => ({ reason: 'Chainlink non-circulating wallet', holder: b.address, amount: Number(BigInt(b.balance)) / 1e18, src: holderLink(p, b.address) }))
      .filter(e => e.amount > 0);
    const out = excluded.reduce((s, e) => s + e.amount, 0);
    if (Math.abs(total - out - circ) > 1) throw new Error('chainlink supply does not reconcile');
    return { circulating: circ, total, src: url, parts: [{ chain: 'eth', amount: total, src: tokenLink(p) }], excluded,
      note: 'Chainlink official non-circulating wallet list (chain.link/circulating-supply); balances read from that list' };
  },
  // Sui: the Sui Foundation publishes circulating supply through the Sui Explorer
  // API (sui-circulation.suiexplorer.com, linked from blog.sui.io/token-release-schedule).
  // It already nets out the locked foundation/community/early-supporter allocations
  // that unlock on the published release schedule; stake rewards count as circulating
  // the moment they are paid (docs.sui.io tokenomics). Cap is 10B SUI.
  async sui() {
    // Sui's public JSON-RPC is deprecated network-wide, so total supply is read from the official
    // GraphQL endpoint; the circulating figure comes from the Sui Explorer circulation API, the
    // only public source for the locked-allocation remainder.
    const gql = await getJSON('https://graphql.mainnet.sui.io/graphql', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ coinMetadata(coinType: "0x2::sui::SUI") { decimals supply } }' }),
    });
    const meta = gql?.data?.coinMetadata;
    if (!meta?.supply) throw new Error('bad sui supply metadata');
    const total = Number(BigInt(meta.supply)) / 10 ** meta.decimals;
    if (!(total > 0)) throw new Error('bad sui total supply ' + total);
    const url = 'https://sui-circulation.suiexplorer.com/api/current_sui_circulation_number';
    const circ = Number(await getJSON(url));
    if (!(circ > 0) || circ > total) throw new Error('bad sui circulation');
    return { circulating: circ, total, src: url,
      excluded: [{ reason: 'Locked allocations (foundation, community reserve, early supporters)', amount: total - circ, src: 'https://blog.sui.io/token-release-schedule/' }],
      note: 'Total from Sui GraphQL; circulating from the official Sui Explorer circulation API (Sui JSON-RPC is deprecated). Stake rewards are circulating when paid' };
  },
  // Aptos (APT): the Aptos Foundation publishes its own live supply API, linked as "Current
  // Token Supply API" on the Mainnet row of aptos.dev/network/nodes/networks. That is a
  // first-party source and it already nets out the locked community/foundation vesting tranches
  // and the 210M APT permanent stake commitment from AIP-140, which is exactly what issue #5
  // asks for. Its current_total_supply is cross-checked against a chain read of 0x1::coin::supply
  // every pass, so a diverging, stale or wrong-network endpoint fails the read instead of
  // publishing a number we cannot corroborate. Gas fees are burned on Aptos, so they are
  // already out of both figures.
  async aptos() {
    const SUPPLY_API = 'https://aptos-supply.dev.gcp.aptosdev.com/supply';
    const url = 'https://api.mainnet.aptoslabs.com/v1/view';
    const [pub, res] = await Promise.all([
      getJSON(SUPPLY_API),
      getJSON(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          function: '0x1::coin::supply',
          type_arguments: ['0x1::aptos_coin::AptosCoin'],
          arguments: [],
        }),
      }),
    ]);
    // Shape is [{ vec: ["<amount>"] }]; older nodes answered [["<amount>"]]. Octas, 8 decimals.
    const first = Array.isArray(res) ? res[0] : null;
    const raw = Array.isArray(first) ? first[0] : Array.isArray(first?.vec) ? first.vec[0] : null;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error('aptos: no integer supply in view response');
    const total = Number(raw) / 1e8;
    if (!(total > 0)) throw new Error(`aptos: bad total supply ${total}`);
    const circ = Number(pub?.current_circulating_supply);
    const pubTotal = Number(pub?.current_total_supply);
    if (!(circ > 0) || !(pubTotal > 0)) throw new Error('aptos: foundation supply API returned no supply');
    if (!(circ <= pubTotal)) throw new Error(`aptos: circulating ${circ} exceeds total ${pubTotal}`);
    // The Foundation's total and the chain must agree within 0.01% (the two are read moments apart, a few thousand APT);
    // a stale or wrong-network API is off by millions. If the API goes stale
    // or switches networks, fail rather than publish a figure we cannot corroborate.
    if (Math.abs(pubTotal - total) > total * 1e-4) throw new Error(`aptos: foundation total ${pubTotal} != chain total ${total}`);
    return {
      circulating: circ,
      total,
      src: SUPPLY_API,
      parts: [{ chain: 'aptos', amount: total, src: url }],
      excluded: [],
      note: `Circulating is the Aptos Foundation's own published figure from its Current Token Supply API (${SUPPLY_API}, linked from aptos.dev), which already nets out locked community/foundation vesting and the 210M APT AIP-140 permanent stake. Total is the live chain read of 0x1::coin::supply and agrees with the Foundation's reported total to within 1 APT. Gas fees are burned, so they are already excluded from both.`,
    };
  },
  // Jupiter's own Token API publishes circulating supply for its tokens, already net of
  // locked team/community allocations and Jupiter Lock vesting escrows (see the JUP
  // community audits on discuss.jup.ag for the wallet breakdown).
  async jupiter(r) {
    const url = `https://api.jup.ag/tokens/v2/search?query=${r.mint}`;
    const d = (await getJSON(url))[0];
    if (d?.id !== r.mint) throw new Error('jupiter: mint mismatch');
    const circ = Number(d?.circSupply), total = Number(d?.totalSupply);
    if (!(circ > 0) || !(total >= circ)) throw new Error('bad jupiter supply');
    return { circulating: circ, total, src: url,
      excluded: [{ reason: 'Locked team/community allocations and Jupiter Lock vesting escrows', amount: total - circ, src: 'https://discuss.jup.ag/t/jup-community-audit-feb-2025/34764' }],
      note: 'Jupiter Token API circSupply: locked team/community wallets and unvested Jupiter Lock escrows excluded by Jupiter' };
  },
  // Quant (QNT): the contract's totalSupply() is NOT the live supply and must not be published as one.
  // The counter was seeded with the 45,467,000 planned cap in 2018 and never decremented: the September 2018
  // burn moved 9,545,765.95 unsold QNT to the contract's own address instead of reducing the count, so the
  // counter still reads 45,467,000 while only about 24.16M was ever minted. Quant's own burn announcement
  // publishes the post-burn total: 14,612,493.080826178 QNT (9,964,259.03181537 public + 4,648,234.049010808
  // company). We publish that disclosed total and subtract only balances that can provably never move again:
  // the remainder parked at the contract address (its balance minus the disclosed burn) and the burn address.
  // QNT has no contractual company, team or foundation lock, so company holdings count as circulating.
  async quant(r) {
    const token = r.address;
    const disclosedTotal = Number(r.disclosedTotal);
    const burned = Number(r.burnedAt2018);
    if (!(disclosedTotal > 0) || !(burned > 0)) throw new Error('quant: rule needs disclosedTotal and burnedAt2018');
    const [rawCounter, atContract, atBurn] = await Promise.all([
      erc20TotalSupply('eth', token),
      erc20Balance('eth', token, token),
      erc20Balance('eth', token, BURN),
    ]);
    // If the counter ever stops being the pre-burn artefact, this rule's reasoning is stale: fail rather than guess.
    if (!(rawCounter > disclosedTotal * 1.1)) throw new Error(`quant: totalSupply() ${rawCounter} is not the pre-burn counter`);
    // The burned tokens have to still be sitting at the contract address, or the burn was moved and our arithmetic is wrong.
    if (!(atContract >= burned)) throw new Error(`quant: burn not at contract address (${atContract} < ${burned})`);
    const stray = atContract - burned;
    const excluded = [
      { reason: 'Burned 2018 remainder parked at the token contract (no contract function can move it)', holder: token, amount: stray, src: holderLink({ chain: 'eth', address: token }, token) },
      { reason: 'Burn address', holder: BURN, amount: atBurn, src: holderLink({ chain: 'eth', address: token }, BURN) },
    ].filter(e => e.amount > 0);
    const circulating = disclosedTotal - excluded.reduce((s, e) => s + e.amount, 0);
    if (!(circulating > 0)) throw new Error('quant: bad circulating supply');
    // The company held 4,648,234.05 QNT at the burn and has never disclosed what it holds
    // since, so a circulating figure built from the 2018 split would overstate it. Publishing
    // total only is the honest answer (same shape as ENA/PYTH).
    const publish = r.circulating !== false;
    return { circulating: publish ? circulating : null, total: disclosedTotal, src: 'https://x.com/quantnetwork/status/1043093247839678464', excluded,
      note: publish
        ? `Total is Quant's own post-burn disclosure (14 Sep 2018), not totalSupply(): the contract counter still reads ${rawCounter.toLocaleString('en-US')} because the burn moved tokens to the contract address instead of decrementing it.`
        : `Total is Quant's own post-burn disclosure (14 Sep 2018), not totalSupply(): the contract counter still reads ${rawCounter.toLocaleString('en-US')} because the burn moved tokens to the contract address instead of decrementing it. ${r.note || 'Circulating supply is not published.'}` };
  },
  async extra() {
    return extraSupply();
  },
  // TON: total supply is the sum of nanoTON (grams) carried in the masterchain head block and all
  // active workchain shard blocks via TonAPI (tonapi.io/v2/blockchain/masterchain-head and /shards).
  // Non-circulating exclusions:
  // 1) TON Believers Fund ("The Locker") contract (EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2),
  //    read live from toncenter.com/api/v2/getAddressBalance.
  // 2) Frozen early-miner wallets from on-chain config param 44 (suspended_address_list) read live
  //    from tonapi.io/v2/blockchain/config and summed via tonapi.io/v2/accounts/_bulk while
  //    now < suspended_until (ton.vote/EQCb8dxevgHhBnsTodJKXaCrafplHzEf1V2Adj0GVlhA5xI4).
  async ton(r = {}) {
    const mc = await getJSON('https://tonapi.io/v2/blockchain/masterchain-head');
    const mcGrams = mc?.value_flow?.to_next_blk?.grams;
    if (!mc?.seqno || mcGrams == null) throw new Error('bad TON masterchain head');
    const sh = await getJSON(`https://tonapi.io/v2/blockchain/masterchain/${mc.seqno}/shards`);
    if (!Array.isArray(sh?.shards) || sh.shards.length === 0) throw new Error('bad TON masterchain shards');
    let totalNano = BigInt(mcGrams);
    for (const s of sh.shards) {
      const g = s?.last_known_block?.value_flow?.to_next_blk?.grams;
      if (g == null) throw new Error('bad TON shard value_flow');
      totalNano += BigInt(g);
    }
    const total = Number(totalNano) / 1e9;
    if (!(total > 5e9)) throw new Error('bad TON total supply ' + total);
    const lockerAddr = 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2';
    const lockerRes = await getJSON(`https://toncenter.com/api/v2/getAddressBalance?address=${lockerAddr}`);
    if (!lockerRes?.ok || !lockerRes?.result) throw new Error('bad TON locker balance');
    const lockerTon = Number(BigInt(lockerRes.result)) / 1e9;
    if (!(lockerTon > 0)) throw new Error('zero TON locker balance');
    const excluded = [
      {
        reason: 'TON Believers Fund (The Locker smart contract)',
        holder: lockerAddr,
        amount: lockerTon,
        src: `https://tonviewer.com/${lockerAddr}`,
      },
    ];
    const cfg = await getJSON('https://tonapi.io/v2/blockchain/config');
    const p44 = cfg?.['44'];
    const suspendedUntil = Number(p44?.suspended_until);
    if (!p44 || !Array.isArray(p44.accounts) || !(suspendedUntil > 0)) {
      throw new Error('bad TON config param 44');
    }
    if (Math.floor(Date.now() / 1000) < suspendedUntil && p44.accounts.length > 0) {
      let frozenNano = 0n;
      for (let i = 0; i < p44.accounts.length; i += 100) {
        const chunk = p44.accounts.slice(i, i + 100);
        const bulk = await getJSON('https://tonapi.io/v2/accounts/_bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account_ids: chunk }),
        });
        if (!Array.isArray(bulk?.accounts) || bulk.accounts.length !== chunk.length) {
          throw new Error('bad TON suspended accounts bulk response');
        }
        for (const acc of bulk.accounts) {
          if (acc?.balance == null) throw new Error('bad TON suspended account balance');
          frozenNano += BigInt(acc.balance);
        }
      }
      const unlockDate = new Date(suspendedUntil * 1000).toISOString().slice(0, 10);
      excluded.push({
        reason: `${p44.accounts.length} frozen early-miner wallets suspended until ${unlockDate} (config param 44)`,
        holder: `${p44.accounts.length} on-chain suspended accounts`,
        amount: Number(frozenNano) / 1e9,
        src: 'https://ton.vote/EQCb8dxevgHhBnsTodJKXaCrafplHzEf1V2Adj0GVlhA5xI4',
      });
    }
    for (const e of r.exclude || []) {
      const res = await getJSON(`https://toncenter.com/api/v2/getAddressBalance?address=${e.holder}`);
      if (!res?.ok || res?.result == null) throw new Error('bad TON balance for ' + e.holder);
      excluded.push({
        reason: e.reason,
        holder: e.holder,
        amount: Number(BigInt(res.result)) / 1e9,
        src: `https://tonviewer.com/${e.holder}`,
      });
    }
    return {
      circulating: total - excluded.reduce((s, e) => s + e.amount, 0),
      total,
      src: 'https://tonapi.io',
      excluded,
      note: 'Total TON summed from masterchain + workchain shard block value_flow (tonapi.io); excludes TON Believers Fund locker contract (toncenter.com) and active config param 44 suspended early-miner accounts read live via tonapi.io/v2/accounts/_bulk.',
    };
  },
};

export async function readSupply(rule) {
  const f = METHODS[rule?.method];
  if (!f) throw new Error('unknown supply method ' + rule?.method);
  const s = await f(rule);
  if (!s) return null;
  return { max: rule.max ?? null, ...s, checked: true, method: rule.method, at: Date.now() };
}
