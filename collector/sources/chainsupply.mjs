// Supply read by us, from the chains themselves (or chain explorers that just add up chain data).
// Each checked coin has a rule in coins.json: { supply: { method, ... } }. A rule may list wallets that are
// not circulating (team, treasury, locked, burn) with a reason; their balances are read from the chain and
// subtracted, and the coin page shows each one.
import { getJSON } from '../../src/util.mjs';
import { erc20TotalSupply, erc20Balance, splBalance, trc20Balance, sol, substrateValue, evm, EXPLORER } from '../chains.mjs';
import { resetSupply, tnkSupply } from './trac.mjs';
import { extraSupply } from './extra.mjs';

const BURN = '0x000000000000000000000000000000000000dEaD';
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

// VVV (Venice): token contract on Base (Venice's help center "What is the Contract Address for the Venice token" and
// its VVV fact sheet), Venice's own stats API (the feed behind its VVV dashboard at venice.ai/token), and the burn
// addresses. VVV's ERC-20 lets tokens be sent to the zero address without lowering totalSupply, and Venice burns there:
// the genesis airdrop burn (tx 0xf5a19b79...37af, listed in the fact sheet) sent 32,509,739 VVV to 0x0.
const VVV = '0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf';
const VVV_STATS = 'https://api.venice.ai/api/app/vvv/vvv_stats';
const VVV_BURN_STATS = 'https://api.venice.ai/api/app/vvv/vvv_burn_stats';
const ZERO = '0x0000000000000000000000000000000000000000';
// ASTER (Aster): BEP-20 on BNB Chain, named in Aster's own token overview
// (docs.asterdex.com/usdaster-token/overview.md). Burns go to 0x…dEaD and do not lower totalSupply();
// tokenomics (docs.asterdex.com/usdaster-token/tokenomics.md) keep burning until 3B.
const ASTER = '0x000Ae314E2A2172a039B26378814C252734f556A';
const ASTER_DOCS = 'https://docs.asterdex.com/usdaster-token/tokenomics.md';
const ASTER_OVERVIEW = 'https://docs.asterdex.com/usdaster-token/overview.md';
// WLD (Worldcoin): the ERC-20 on Ethereum holds the whole 10B supply. WLD on Optimism is an OptimismMintableERC20 whose
// remoteToken() is the Ethereum WLD and whose bridge is OP's L2StandardBridge (0x4200...0010): every WLD there is
// backed by WLD locked in OP Mainnet's L1StandardBridge on Ethereum, so it is checked, not added. World Chain's WLD is
// bridged the same way (World Chain L1StandardBridge, Etherscan label "World Chain: L1 Standard Bridge Proxy").
const WLD_ETH = '0x163f8C2467924be0ae7B5347228CABF260318753';
const WLD_OP = '0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1';
const OP_L1_BRIDGE = '0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1';
const OP_L2_BRIDGE = '0x4200000000000000000000000000000000000010';
const WORLDCHAIN_L1_BRIDGE = '0x470458C91978D2d929704489Ad730DC3E3001113';
// World's own list of WLD contracts and wallets (World whitepaper, Tokenomics, 2025-08-04 edition), Ethereum side.
const WLD_WHITEPAPER = 'https://whitepaper.world.org/designing-for-scale/2025-08-04';
const WLD_WORLD_WALLETS = [
  ['0x1770bd8186AAd27Df9B050D65f86CF2cdC92C296', 'World Community unlock contract 1 (locked, unlocks on schedule)'],
  ['0xaEE0360b73B5D01dad134f234d3a93adc1680e57', 'World Community unlock contract 2 (locked, unlocks on schedule)'],
  ['0x938ceD2D1eE4AFB220929F96c2eB754C053C77F7', 'World Community unlock contract 3 (locked, unlocks on schedule)'],
  ['0x5B5442C5fcEaE3b40C230C32a3Ffe924BcBe7D93', 'World Community unlock contract 4 (locked, unlocks on schedule)'],
  ['0xc534a745bFfaF9466Ed7B47fA23B0177b99A3e77', 'World Foundation cold wallet'],
  ['0x59a0f98345f54bAB245A043488ECE7FCecD7B596', 'World Assets, Ltd. cold wallet'],
  ['0xc4151Dd19A38E7224793F5aD8fBDD912750e3565', 'World Assets, Ltd. hot wallet'],
];

// Plasma (XPL, chainId 9745). Mainnet genesis.json in PlasmaLaboratories/non-validator-templates mints exactly
// 10,000,000,000 XPL across four genesis Safe multisigs (0x0000...0a11b001..0a11b004: 2.5B Team, 2.5B Investors,
// 1.0B Public Sale, 3,999,999,400 Ecosystem & Growth) plus 600 XPL across six 100-XPL bootstrap accounts.
// Plasma runs unmodified Reth on the execution layer with a static validator committee (Aquila validator-set
// contract 0x6c50...2F48); per Plasma's tokenomics docs and MiCA whitepaper (G.12), inflation only activates once
// external validators and stake delegation go live. Bridged XPL on BNB Smart Chain (LayerZero OFT 0x405F...26b0)
// is backed 1:1 by native XPL locked at the same OFT adapter address on Plasma mainnet, so it is checked, not added.
const PLASMA_GENESIS_XPL = 10_000_000_000;
const PLASMA_GENESIS_HASH = '0x0d0ccca452bdb244100115e37de64ca640a255585d5a94df5610052a6dada558';
const PLASMA_GENESIS_STATE = '0x51a81695b0907da0433793778e86d0cb7429fe171e09e0ff2ee21743eb298355';
const PLASMA_GENESIS_SRC = 'https://github.com/PlasmaLaboratories/non-validator-templates/blob/main/config/mainnet/genesis.json';
const PLASMA_DOCS_SRC = 'https://www.plasma.org/docs/get-started/xpl/tokenomics';
const PLASMA_VALIDATOR_SET = '0x6c50b8ca8EeAa1c75dEe5b5EA79772AcAbc92F48';
const PLASMA_OFT = '0x405FBc9004D857903bFD6b3357792D71a50726b0';
const PLASMA_PROTOCOL_SAFES = [
  ['0x000000000000000000000000000000000a11b001', 'Team genesis Safe (2.5B XPL genesis allocation)'],
  ['0x000000000000000000000000000000000a11b002', 'Investors genesis Safe (2.5B XPL genesis allocation)'],
  ['0x000000000000000000000000000000000a11b003', 'Public Sale genesis Safe (1.0B XPL genesis allocation)'],
  ['0x000000000000000000000000000000000a11b004', 'Ecosystem & Growth genesis Safe (4.0B XPL genesis allocation)'],
  ['0x000000000000000000000000000000000a11b005', 'Protocol validator fee-recipient Safe'],
];

// LayerZero (ZRO). LayerZeroToken (0x6985...71cd) is a 13-line LayerZero v2 OFT that minted the fixed
// 1,000,000,000 ZRO cap once in its Ethereum constructor, with no mint() or burn() function; protocol
// fee-switch referendums #1-#4 all voted Off (layerzero.foundation/fee-switch). Each EVM OFT's totalSupply()
// decreases only on OFT._debit (bridging out) and increases on OFT._credit (bridging in). Scanning peers(eid)
// across EIDs 1..40499 (matching metadata.layerzero-api.com) finds 8 active chains: the 7 public EVM OFT
// deployments below plus EID 33002 (zerointerop, LayerZero's native-ZRO Zero L1 bound on 2026-11-21 to peer
// 0x1ced...55b31, which has no public RPC yet).
const ZRO = '0x6985884C4392D348587B19cb9eAAf157F13271cd';
const ZRO_CAP = 1_000_000_000;
const ZRO_CHAINS = ['eth', 'arbitrum', 'bsc', 'base', 'optimism', 'polygon', 'avax'];
const ZRO_ZERO_EID_CALL = '0xbb0b6a5300000000000000000000000000000000000000000000000000000000000080ea'; // peers(33002)
const ZRO_ZERO_PEER = '0x0000000000000000000000001ced7d571059a30db0fc9adc40346d2a1ce55b31';
const ZRO_TOKENOMICS_SRC = 'https://info.layerzero.foundation/introducing-zro-d39df554a9b7';
const ZRO_BUYBACKS_SRC = 'https://layerzero.foundation/zro-buybacks';
const ZRO_FEE_SWITCH_SRC = 'https://layerzero.foundation/fee-switch';
const ZRO_WALLETS = [
  ['0x1f903473376fBe98cc763F1Bc459C8fdB6AC3909', 'LayerZero 1 (labeled project wallet on Ethereum)', null],
  ['0x6ac55e733dff03a54251670df0667774e8f7d28f', 'LayerZero Foundation Stargate-revenue ZRO buyback multisig', ZRO_BUYBACKS_SRC],
];

// TAP (TAP Protocol on Bitcoin, by Trac). Trac's public TAP Protocol reader: the REST reader Trac's own Digital Matter
// World kit reads on mainnet. Trac's older socket endpoint, tap.trac.network, now answers 502. A second reader (any
// Trac tap-reader REST endpoint) can be added with TMC_TAP_READER2, and then has to agree. See the tap method below.
const TAP_READER = 'https://reader.tapscope.io';
// The canonical TAP burn address (TAP Protocol specs, target type "b": "burns to the canonical burn address").
const TAP_BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE';
const TAP_MAX = 21000000n * 10n ** 18n; // fixed at deploy: 21,000,000 TAP, 18 decimals
const TAP_PAGE = 500;

const tapAtomic = (v, what) => {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`tap: ${what} is not an amount (${JSON.stringify(v)})`);
};
const tapNum = a => Number(a / 10n ** 12n) / 1e6; // 18 decimals -> TAP, exact to 1e-6

// One reader's view of TAP: minted, burned, and the TAP in protocol locks by kind.
async function tapRead(base) {
  const get = p => getJSON(`${base}/${p}`);
  const [dep, left, burnBal, burnList, lockLen] = await Promise.all([
    get('getDeployment/tap'),
    get('getMintTokensLeft/tap'),
    get(`getBalance/${TAP_BURN_ADDRESS}/tap`),
    get(`getAccountTokensBalance/${TAP_BURN_ADDRESS}?offset=0&max=100`),
    get('getTickerLocksLength/tap'),
  ]);
  const d = dep?.result;
  if (d?.tick !== 'tap' || d.dec !== 18) throw new Error(`tap: ${base} returned an unexpected deployment`);
  const max = tapAtomic(d.max, 'deployment max');
  if (max !== TAP_MAX) throw new Error(`tap: deployment max ${d.max} is not 21,000,000 TAP`);
  const minted = max - tapAtomic(left?.result, 'mint tokens left');
  if (!(minted > 0n && minted <= max)) throw new Error(`tap: minted ${minted} outside 0..max`);

  // Burned, read two ways from the reader: the address balance and the address's token list. They must agree.
  const burned = burnBal?.result === null ? 0n : tapAtomic(burnBal?.result, 'burned balance');
  const list = burnList?.data;
  if (!Array.isArray(list?.list) || !Number.isSafeInteger(list.total)) throw new Error('tap: bad burn address token list');
  const row = list.list.find(r => String(r?.ticker).toLowerCase() === 'tap');
  if (!row && list.list.length < list.total) throw new Error('tap: burn address token list incomplete');
  const listed = row ? tapAtomic(row.overallBalance, 'burn address token balance') : 0n;
  if (listed !== burned) throw new Error(`tap: burn address balance ${burned} != its token list ${listed}`);
  if (!(burned < minted)) throw new Error('tap: burned not below minted');

  // Protocol locks on TAP, all pages.
  const count = Number(tapAtomic(lockLen?.result, 'lock count'));
  const locks = [];
  for (let offset = 0; offset < count; offset += TAP_PAGE) {
    const page = (await get(`getTickerLocks/tap?offset=${offset}&max=${TAP_PAGE}`))?.result;
    if (!Array.isArray(page) || page.length === 0) throw new Error('tap: bad lock list');
    locks.push(...page);
  }
  if (locks.length !== count) throw new Error(`tap: lock list has ${locks.length} of ${count}`);
  const byKind = new Map();
  for (const l of locks) {
    if (String(l?.tick).toLowerCase() !== 'tap' || typeof l.kind !== 'string' || !l.kind) throw new Error('tap: bad lock entry');
    const k = byKind.get(l.kind) || { n: 0, amount: 0n };
    k.n++;
    k.amount += tapAtomic(l.remaining, 'lock remaining');
    byKind.set(l.kind, k);
  }
  return { base, minted, burned, byKind };
}

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
    // Never publish a number derived from a failed or malformed chain read.
    if (!Number.isFinite(total) || !(total > 0)) throw new Error('tokens: bad total supply');
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
  // TNK (Trac Network): sum of every Main Settlement Bus account, see tnkSupply in trac.mjs.
  async tnk(r = {}) {
    return tnkSupply(r);
  },
  // Venice (VVV, Base). Total is a chain read: totalSupply minus the VVV held by the zero address and 0x...dEaD
  // (burned; VVV's ERC-20 does not lower totalSupply on a transfer to 0x0, and Venice's airdrop and buy-and-burn
  // burns sit there). Circulating is Venice's own published figure from its stats API, the feed behind the VVV
  // dashboard on venice.ai/token, as with Celestia: Venice publishes no list of the wallets it leaves out (treasury,
  // Community Incentive Fund, team vesting streaming over 24 months from January 2025 per its fact sheet), so the
  // gap is published as one line, sourced to Venice, instead of a sum of wallets we could not attribute.
  // Venice does not subtract staked VVV as a whole (its circulating figure is above total minus staked). Checks: Venice's total and burned
  // figures must match the chain within 0.5%, circulating must be below total, and staked below total; any error or
  // NaN fails the read.
  async venice() {
    const [supply, zero, dead, stats, burn] = await Promise.all([
      erc20TotalSupply('base', VVV),
      erc20Balance('base', VVV, ZERO),
      erc20Balance('base', VVV, BURN),
      getJSON(VVV_STATS),
      getJSON(VVV_BURN_STATS),
    ]);
    const unit = (v, what) => {
      if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`venice: ${what} is not an amount (${JSON.stringify(v)})`);
      return Number(BigInt(v) / 10n ** 12n) / 1e6; // 18 decimals
    };
    const burned = zero + dead;
    const total = supply - burned;
    const vTotal = unit(stats?.totalSupplyCryptoBaseUnit, 'totalSupply');
    const circulating = unit(stats?.circulatingSupplyCryptoBaseUnit, 'circulatingSupply');
    const staked = unit(stats?.totalStakedCryptoBaseUnit, 'totalStaked');
    const locked = unit(stats?.totalLockedCryptoBaseUnit, 'totalLocked');
    const vBurned = unit(burn?.totalBurnedCryptoBaseUnit, 'totalBurned');
    if (![supply, zero, dead, total].every(Number.isFinite) || !(total > 0)) throw new Error(`venice: bad chain read (${supply}, ${zero}, ${dead})`);
    if (Math.abs(vTotal / total - 1) > 0.005) throw new Error(`venice: Venice total ${vTotal} disagrees with chain total ${total}`);
    if (Math.abs(vBurned / burned - 1) > 0.005) throw new Error(`venice: Venice burned ${vBurned} disagrees with the chain (${burned})`);
    if (!(circulating > 0 && circulating < total)) throw new Error(`venice: circulating ${circulating} not inside 0..${total}`);
    if (!(staked < total)) throw new Error(`venice: staked ${staked} not below total ${total}`);
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const holder = h => `${EXPLORER.base}/token/${VVV}?a=${h}`;
    return {
      circulating,
      total,
      src: `${EXPLORER.base}/token/${VVV}`,
      excluded: [
        { reason: 'Burned (sent to the zero address: genesis airdrop burn and Venice buy-and-burn)', holder: ZERO, amount: zero, src: holder(ZERO) },
        ...(dead > 0 ? [{ reason: 'Burn address', holder: BURN, amount: dead, src: holder(BURN) }] : []),
        { reason: 'Not circulating per Venice\'s published circulating supply. Venice does not list the wallets behind it; its fact sheet gives 35M of the 100M genesis supply to Venice.ai (team 10M streaming over 24 months, Community Incentive Fund 10M, Liquidity Fund 5M)', amount: total - circulating, src: VVV_STATS },
      ],
      note: `Total read from Base: totalSupply ${fmt(supply)} VVV minus ${fmt(burned)} VVV burned at the zero and dead addresses (Venice's burn stats agree: ${fmt(vBurned)}). Circulating is Venice's own figure from its stats API (${VVV_STATS}, the feed behind venice.ai/token); it does not subtract the ${fmt(staked)} VVV staked as a whole (it is above total minus staked). Venice also reports ${fmt(locked)} VVV locked to mint DIEM and does not say whether its figure counts them.`,
    };
  },
  // Worldcoin (WLD). Total is read from Ethereum: totalSupply of the WLD ERC-20 minus the dead-address balance.
  // Optimism is read too, as a check: its WLD must name the Ethereum WLD as remoteToken, use OP's standard bridge,
  // and not exceed the WLD locked in OP Mainnet's L1StandardBridge, so nothing is counted twice.
  // The wallets World publishes (whitepaper, Tokenomics) are read and listed. Circulating is still withheld: World's
  // team and investor tokens unlock linearly and have no published addresses, so total minus the listed wallets
  // would overstate circulating. The rule can set circulating once those locks are sourced.
  async worldcoin(r = {}) {
    const addr = h => '0x' + String(h).slice(-40).toLowerCase();
    const [total, dead, opTotal, opRemote, opBridge, lockedOp, lockedWorld, ...held] = await Promise.all([
      erc20TotalSupply('eth', WLD_ETH),
      erc20Balance('eth', WLD_ETH, BURN),
      erc20TotalSupply('optimism', WLD_OP),
      evm('optimism', 'eth_call', [{ to: WLD_OP, data: '0xd6c0b2c4' }, 'latest']), // remoteToken()
      evm('optimism', 'eth_call', [{ to: WLD_OP, data: '0xe78cea92' }, 'latest']), // bridge()
      erc20Balance('eth', WLD_ETH, OP_L1_BRIDGE),
      erc20Balance('eth', WLD_ETH, WORLDCHAIN_L1_BRIDGE),
      ...WLD_WORLD_WALLETS.map(([h]) => erc20Balance('eth', WLD_ETH, h)),
    ]);
    if (![total, dead, opTotal, lockedOp, lockedWorld, ...held].every(Number.isFinite) || !(total > 0)) throw new Error('worldcoin: bad chain read');
    if (addr(opRemote) !== WLD_ETH.toLowerCase() || addr(opBridge) !== OP_L2_BRIDGE.toLowerCase()) throw new Error(`worldcoin: Optimism WLD is not the standard-bridged Ethereum WLD (${opRemote}, ${opBridge})`);
    if (opTotal > lockedOp * 1.0001) throw new Error(`worldcoin: Optimism WLD ${opTotal} above the ${lockedOp} locked in the OP bridge`);
    const net = total - dead;
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const eth = h => `${EXPLORER.eth}/token/${WLD_ETH}?a=${h}`;
    return {
      circulating: r.circulating === true ? net : null,
      total: net,
      src: `${EXPLORER.eth}/token/${WLD_ETH}`,
      excluded: [
        ...(dead > 0 ? [{ reason: 'Burn address', holder: BURN, amount: dead, src: eth(BURN) }] : []),
        ...WLD_WORLD_WALLETS.map(([h, reason], i) => ({ reason: `${reason}, per World's whitepaper`, holder: h, amount: held[i], src: WLD_WHITEPAPER })).filter(e => e.amount > 0),
      ],
      note: `Total read from Ethereum, where the whole supply is minted: ${fmt(total)} WLD, less ${dead.toFixed(2)} at the burn address. The ${fmt(opTotal)} WLD on Optimism (${EXPLORER.optimism}/token/${WLD_OP}) are bridged copies (remoteToken = Ethereum WLD, OP standard bridge) backed by ${fmt(lockedOp)} WLD locked in OP Mainnet's L1StandardBridge on Ethereum, so they are inside the Ethereum figure; World Chain's ${fmt(lockedWorld)} bridged WLD are locked the same way. The listed World wallets hold ${fmt(held.reduce((a, b) => a + b, 0))} WLD on Ethereum (World also lists wallets on Optimism and World Chain). Circulating is withheld: World defines circulating as tokens without transfer restrictions and its unlocked supply only as an upper bound (${WLD_WHITEPAPER}), and the team and investor tokens still unlocking have no published addresses, so total minus the listed wallets would overstate it.`,
    };
  },
  // Aster (ASTER, BNB Chain). Total is a chain read: BEP-20 totalSupply minus the ASTER at 0x…dEaD, the same
  // way Venice nets burns — the contract does not lower totalSupply on a burn transfer. Aster's own tokenomics
  // (docs.asterdex.com/usdaster-token/tokenomics.md) burn from reserve until total supply reaches 3B.
  // Circulating is withheld: that page says Treasury (560M) is fully locked and Team (400M) stays locked until
  // 17 Sep 2027, and it does not publish those wallet addresses, so subtracting them would guess. Ecosystem
  // vesting was replaced by staking emissions after January 2026; those are not treated as locked.
  async aster(r = {}) {
    const [supply, dead, zero] = await Promise.all([
      erc20TotalSupply('bsc', ASTER),
      erc20Balance('bsc', ASTER, BURN),
      erc20Balance('bsc', ASTER, ZERO),
    ]);
    if (![supply, dead, zero].every(Number.isFinite) || !(supply > 0)) throw new Error(`aster: bad chain read (${supply}, ${dead}, ${zero})`);
    if (!(dead > 0)) throw new Error('aster: no dead-address burn');
    const burned = dead + zero;
    const total = supply - burned;
    if (!(total > 0) || burned >= supply) throw new Error(`aster: burned ${burned} is not below totalSupply ${supply}`);
    const max = Number(r.max);
    if (max > 0 && supply > max * 1.0001) throw new Error(`aster: totalSupply ${supply} above max ${max}`);
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const holder = h => `${EXPLORER.bsc}/token/${ASTER}?a=${h}`;
    return {
      circulating: r.circulating === true ? total : null,
      total,
      src: `${EXPLORER.bsc}/token/${ASTER}`,
      excluded: [
        { reason: 'Burned (sent to the dead address; Aster burns toward 3B and does not lower totalSupply())', holder: BURN, amount: dead, src: holder(BURN) },
        ...(zero > 0 ? [{ reason: 'Zero address (unspendable)', holder: ZERO, amount: zero, src: holder(ZERO) }] : []),
      ],
      note: `Total read from BNB Chain: totalSupply ${fmt(supply)} ASTER of the BEP-20 named in Aster's token overview (${ASTER_OVERVIEW}) minus ${fmt(burned)} ASTER at the burn address. Aster's tokenomics (${ASTER_DOCS}) burn from reserve until supply reaches 3B and do not decrement totalSupply() on those transfers. Circulating is withheld: that page says Treasury (560M, 7%) is fully locked and Team (400M, 5%) stays locked until 17 Sep 2027, without publishing those addresses, so subtracting them would guess. Ecosystem vesting was replaced by staking emissions after January 2026; those emissions are not treated as locked.`,
    };
  },
  // Celestia (TIA): total is a chain read (bank supply of utia). Circulating is NOT read from the chain:
  // the genesis lockups (ecosystem 267,944,711 / investors 355,689,414 / core contributors 176,365,875 TIA,
  // github.com/celestiaorg/supply internal/consts.go) are not exposed as vesting accounts by the LCD. A full
  // scan of every auth account on celestia-api.polkachu.com (1,709,108 accounts, 171 pages, 2026-11-23) found
  // 850 vesting accounts holding 1,264,109.39 TIA still unvested — 0.107% of total, two orders of magnitude
  // below the published non-circulating gap — so the lockup allocations live outside /cosmos/auth/v1beta1/accounts.
  // Celestia's own lockup queries (/celestia/lockup/v1/accounts, /locked_amount) return 501 Not Implemented on
  // every public LCD reachable from here, so circulating cannot be assembled from chain state. Instead we use the
  // project's own published figure (supply.celestia.org, run by Celestia from celestiaorg/supply), a first-party
  // source, and we publish the excluded gap so the coin page shows what was removed.
  //
  // Its README warns the figure does not adjust for tokens retroactively locked after TGE under CIP-31, "likely
  // no more than around 1%". We do not apply a guessed haircut, and that margin is not measured here: it may sit
  // outside the 850 on-chain vesting accounts above. If the two totals drift apart the whole read fails rather
  // than publishing a number built on a stale schedule.
  async celestia(r) {
    const lcd = r.lcd;
    const api = r.api;
    const [supply, c, t] = await Promise.all([
      getJSON(`${lcd}/cosmos/bank/v1beta1/supply/by_denom?denom=${r.denom || 'utia'}`),
      getJSON(`${api}/v0/circulating-supply`),
      getJSON(`${api}/v0/total-supply`),
    ]);
    const total = Number(supply?.amount?.amount) / 1e6;
    const circulating = Number(c);
    const apiTotal = Number(t);
    if (!(total > 0) || !Number.isFinite(total)) throw new Error(`bad Celestia chain total supply: ${JSON.stringify(supply)?.slice(0, 120)}`);
    if (!(circulating > 0) || !(apiTotal > 0)) throw new Error(`Invalid Celestia supply: circ=${c}, total=${t}`);
    if (circulating > apiTotal) throw new Error(`Invalid Celestia supply: circulating ${circulating} above total ${apiTotal}`);
    // the chain total and the project's schedule total must agree; a drift means one of them is stale
    if (Math.abs(apiTotal / total - 1) > 0.01) throw new Error(`Celestia schedule total ${apiTotal} disagrees with chain total ${total}`);
    const unvested = total - circulating;
    if (!(unvested > 0)) throw new Error(`Invalid Celestia supply: circulating ${circulating} not below chain total ${total}`);
    return {
      circulating,
      total,
      src: api,
      excluded: [{
        reason: 'Unvested allocations on Celestia\'s published unlock schedule (ecosystem, investor and core-contributor allocations; CIP-31 also folds staking rewards earned by a lockup account back into that account\'s schedule). The genesis lockups are not exposed by the chain\'s auth or lockup queries, so this is the project\'s published figure rather than a sum of wallet balances.',
        amount: unvested,
        src: 'https://github.com/celestiaorg/supply/blob/main/internal/consts.go',
      }],
      note: `Total read from the chain (bank supply of utia on ${lcd}), circulating from Celestia's own supply API (${api}, run from celestiaorg/supply). The API does not adjust for tokens retroactively locked after TGE under CIP-31 (README: "likely no more than around 1%"); a full scan of the chain's 1,709,108 auth accounts found 850 vesting accounts holding 1,264,109.39 TIA unvested (0.107% of total), so the measurable part of that margin is published here rather than estimated.`,
    };
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
  // TAP: total = minted minus burned, read from Trac's TAP Protocol reader (see tapRead above). TAP was deployed with a
  // fixed 21,000,000 max and is fully minted. Burned = the TAP held by the canonical burn address. Circulating = total
  // minus TAP in protocol locks that hold it back from its owner. HTLC locks are the TAP marketplace's trade escrow:
  // a listing that goes to the buyer or back to the seller (refund height), so that TAP stays circulating, like
  // tokens on an exchange order book. Any other lock kind is subtracted and listed.
  // (TAP Protocol also treats outputs that cannot be credited to a valid address as burned; the reader keeps no
  // balance for those, so they are not in the burned figure and total can only be overstated by them, never under.)
  // HTTP errors, a wrong deployment, NaN, a malformed or incomplete lock list, readers that disagree, or circulating
  // above total fail the read.
  async tap() {
    const bases = [TAP_READER, ...(process.env.TMC_TAP_READER2 ? [process.env.TMC_TAP_READER2.replace(/\/+$/, '')] : [])];
    const reads = await Promise.all(bases.map(tapRead));
    const [a, ...more] = reads;
    for (const b of more) {
      if (b.minted !== a.minted) throw new Error(`tap: ${b.base} minted ${b.minted} != ${a.base} ${a.minted}`);
      const gap = a.burned > b.burned ? a.burned - b.burned : b.burned - a.burned;
      if (gap * 100n > a.burned && gap > 100n * 10n ** 18n) throw new Error(`tap: ${b.base} burned ${b.burned} != ${a.base} ${a.burned}`);
    }
    const escrow = a.byKind.get('htlc') || { n: 0, amount: 0n };
    const lockedKinds = [...a.byKind].filter(([kind]) => kind !== 'htlc');
    const locked = lockedKinds.reduce((t, [, k]) => t + k.amount, 0n);
    const totalA = a.minted - a.burned;
    const circA = totalA - locked;
    if (circA > totalA || circA < 0n) throw new Error(`tap: circulating ${circA} outside 0..total ${totalA}`);
    const total = tapNum(totalA), circulating = tapNum(circA);
    if (!Number.isFinite(total) || !Number.isFinite(circulating) || !(total > 0)) throw new Error('tap: bad numbers');
    const fmt = v => Math.round(tapNum(v)).toLocaleString('en-US');
    return {
      circulating,
      total,
      max: tapNum(TAP_MAX),
      src: `${TAP_READER}/getDeployment/tap`,
      excluded: [
        { reason: 'Burned (sent to the TAP burn address)', holder: TAP_BURN_ADDRESS, amount: tapNum(a.burned), src: `${TAP_READER}/getBalance/${TAP_BURN_ADDRESS}/tap` },
        ...lockedKinds.map(([kind, k]) => ({ reason: `Locked in ${k.n} TAP Protocol "${kind}" lock${k.n === 1 ? '' : 's'}`, amount: tapNum(k.amount), src: `${TAP_READER}/getTickerLocksByKind/tap/${kind}` })),
      ],
      note: `Read from Trac's TAP Protocol reader (${TAP_READER}): ${fmt(a.minted)} TAP minted (fixed 21,000,000 max, fully minted) minus ${fmt(a.burned)} TAP held by the TAP burn address ${TAP_BURN_ADDRESS}.`
        + (lockedKinds.length ? ' TAP held in protocol locks is subtracted from circulating (listed above).' : ' No TAP is held in a protocol lock that keeps it from its owner.')
        + (escrow.n ? ` ${escrow.n} TAP marketplace HTLC escrows (${fmt(escrow.amount)} TAP) are trade listings that go to the buyer or back to the seller, so they stay circulating.` : '')
        + (more.length ? ` Cross-checked against ${more.map(b => b.base).join(', ')}.` : ''),
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
  // Sei (pacific-1): total usei from x/bank (/supply/usei; /supply/by_denom panics on pacific-1 v6.7),
  // with verified non-circulating balances read live into excluded: the community pool, Sei's active
  // CosmWasm code_id 5530 Gringotts vesting contracts (github.com/sei-protocol/gringotts, summing liquid +
  // staked + unbonding and checking each contract still holds at least its unvested future tranches),
  // their unlock_distribution_address staging wallet, the pacific-1 genesis distributor, and the three
  // legacy DelayedVestingAccounts from github.com/sei-protocol/sei-chain/pull/4864. When circulating is
  // set to false (because the 1.7B Ecosystem Reserve and 700M Foundation Gringotts contracts finished their
  // CosmWasm schedules in Aug 2025 and dispersed to unlabelled wallets), circulating is null (same shape
  // as ENA, PYTH and QNT) rather than publishing an overstated ceiling.
  async sei(r = {}) {
    const lcd = r.lcd || 'https://sei-rest.publicnode.com';
    const explorer = r.explorer || 'https://seistream.app/address/';
    const [sup, cp] = await Promise.all([
      getJSON(`${lcd}/cosmos/bank/v1beta1/supply/usei`),
      getJSON(`${lcd}/cosmos/distribution/v1beta1/community_pool`),
    ]);
    const rawTotal = sup?.amount?.amount;
    if (typeof rawTotal !== 'string' || !/^\d+$/.test(rawTotal)) throw new Error('sei: bad bank supply');
    const total = seiFromUsei(BigInt(rawTotal));
    if (!(total > 8e9)) throw new Error('sei: bad total supply ' + total);

    if (!Array.isArray(cp?.pool)) throw new Error('sei: bad community pool');
    const cpUsei = cp.pool.find(x => x?.denom === 'usei');
    if (!cpUsei || typeof cpUsei.amount !== 'string') throw new Error('sei: missing usei community pool');
    const cpAmount = Number(cpUsei.amount) / 1e6;
    if (!Number.isFinite(cpAmount) || cpAmount < 0) throw new Error('sei: invalid community pool amount');

    const excluded = [];
    if (cpAmount > 0) {
      excluded.push({
        reason: 'Community pool (on-chain treasury)',
        amount: cpAmount,
        src: `${lcd}/cosmos/distribution/v1beta1/community_pool`,
      });
    }

    const nowMs = Date.now();
    for (const v of r.vestingContracts || []) {
      const [heldUsei, smart] = await Promise.all([
        seiAccountUsei(lcd, v.holder),
        getJSON(`${lcd}/cosmwasm/wasm/v1/contract/${v.holder}/smart/${SEI_GRINGOTTS_INFO}`),
      ]);
      const ts = smart?.data?.vesting_timestamps;
      const am = smart?.data?.vesting_amounts;
      if (!Array.isArray(ts) || !Array.isArray(am) || ts.length !== am.length) {
        throw new Error('sei: bad gringotts vesting schedule for ' + v.holder);
      }
      let futureUsei = 0n;
      for (let i = 0; i < am.length; i++) {
        if (typeof am[i] !== 'string' || !/^\d+$/.test(am[i])) {
          throw new Error('sei: bad gringotts tranche amount for ' + v.holder);
        }
        if (seiTimestampMs(ts[i]) > nowMs) futureUsei += BigInt(am[i]);
      }
      // Sei's gringotts repo includes CosmWasm -> EVM migration scripts; if locked tokens ever move out
      // before their unlock timestamp, fail closed rather than publish an overstated circulating supply.
      if (heldUsei + 1_000_000n < futureUsei) {
        throw new Error(`sei: gringotts contract ${v.holder} balance below unvested schedule`);
      }
      if (heldUsei > 0n) {
        excluded.push({
          reason: v.reason,
          holder: v.holder,
          amount: seiFromUsei(heldUsei),
          src: explorer + v.holder,
        });
      }
    }

    const items = r.exclude || [];
    for (let i = 0; i < items.length; i += 3) {
      const chunk = items.slice(i, i + 3);
      const balances = await Promise.all(chunk.map(e => seiAccountUsei(lcd, e.holder)));
      for (let j = 0; j < chunk.length; j++) {
        if (balances[j] > 0n) {
          excluded.push({
            reason: chunk[j].reason,
            holder: chunk[j].holder,
            amount: seiFromUsei(balances[j]),
            src: explorer + chunk[j].holder,
          });
        }
      }
    }

    const ceiling = total - excluded.reduce((s, e) => s + e.amount, 0);
    if (!(ceiling > 0) || !(ceiling <= total)) throw new Error('sei: bad circulating supply ' + ceiling);
    const publish = r.circulating !== false;
    return {
      circulating: publish ? ceiling : null,
      total,
      src: 'https://seistream.app/blockchain',
      excluded,
      note: r.note,
    };
  },
  // Avalanche (AVAX): staked AVAX counts as circulating (same policy as ETH and SOL, and matching
  // Avalanche's own published figure). We read P-Chain platform.getCurrentSupply, the C-Chain burn
  // address (0x0100...0000) via evm('avax', 'eth_getBalance', ...), and Avalanche's first-party
  // Data API (data-api.avax.network/v1/avax/supply, getAvaxSupply on docs.avax.network), which
  // subtracts C-Chain, P-Chain and X-Chain burned AVAX from minted supply (genesisUnlock +
  // totalRewards) without subtracting stake. The live C-Chain burn balance and the P-Chain net
  // supply are cross-checked against the Data API every pass so any stale or broken source fails closed.
  async avax() {
    const pRpc = 'https://api.avax.network/ext/bc/P';
    const apiUrl = 'https://data-api.avax.network/v1/avax/supply';
    const cBurnAddr = '0x0100000000000000000000000000000000000000';
    const [pRes, cBurnHex, api] = await Promise.all([
      getJSON(pRpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'platform.getCurrentSupply', params: {} }),
      }),
      evm('avax', 'eth_getBalance', [cBurnAddr, 'latest']),
      getJSON(apiUrl),
    ]);
    if (pRes?.error) throw new Error(`avax platform.getCurrentSupply: ${pRes.error.message || JSON.stringify(pRes.error)}`);
    const rawPSupply = pRes?.result?.supply;
    if (typeof rawPSupply !== 'string' || !/^\d+$/.test(rawPSupply)) throw new Error('avax: bad P-Chain supply');
    const pSupply = Number(BigInt(rawPSupply)) / 1e9;
    if (!(pSupply > 4e8)) throw new Error(`avax: implausible P-Chain supply ${pSupply}`);

    if (typeof cBurnHex !== 'string' || !/^0x[0-9a-f]+$/i.test(cBurnHex)) throw new Error('avax: bad C-Chain burn balance');
    const cBurnChain = Number(BigInt(cBurnHex) / 10n ** 9n) / 1e9;
    if (!(cBurnChain > 0)) throw new Error('avax: empty C-Chain burn balance');

    const apiTotal = Number(api?.totalSupply);
    const apiCirc = Number(api?.circulatingSupply);
    const cBurnApi = Number(api?.totalCBurned);
    const pBurnApi = Number(api?.totalPBurned);
    const xBurnApi = Number(api?.totalXBurned);
    if (![apiTotal, apiCirc, cBurnApi, pBurnApi, xBurnApi].every(v => Number.isFinite(v) && v >= 0)) {
      throw new Error('avax: invalid Data API supply or burn figures');
    }
    if (!(apiTotal > 4e8) || !(apiCirc > 4e8) || !(cBurnApi > 0)) {
      throw new Error(`avax: implausible Data API supply total=${apiTotal} circ=${apiCirc}`);
    }
    if (apiCirc > apiTotal) throw new Error(`avax: circulating ${apiCirc} exceeds total ${apiTotal}`);
    if (apiCirc < apiTotal - 1) throw new Error(`avax: Data API circulating ${apiCirc} below total ${apiTotal}`);

    if (api?.lastUpdated !== undefined) {
      const updatedMs = Date.parse(api.lastUpdated);
      if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > 2 * 24 * 3600e3) {
        throw new Error(`avax: Data API lastUpdated ${api.lastUpdated} is stale or invalid`);
      }
    }

    if (api?.genesisUnlock !== undefined || api?.totalRewards !== undefined) {
      const genesis = Number(api?.genesisUnlock);
      const rewards = Number(api?.totalRewards);
      if (!Number.isFinite(genesis) || !Number.isFinite(rewards) || !(genesis > 0) || !(rewards > 0)) {
        throw new Error('avax: invalid Data API genesisUnlock or totalRewards');
      }
      const minted = genesis + rewards;
      const totalBurnedApi = cBurnApi + pBurnApi + xBurnApi;
      if (Math.abs(minted - totalBurnedApi - apiTotal) > 1) {
        throw new Error(`avax: Data API parts do not reconcile (${minted} - ${totalBurnedApi} != ${apiTotal})`);
      }
      if (minted > pSupply + 1) {
        throw new Error(`avax: Data API minted ${minted} exceeds P-Chain upper bound ${pSupply}`);
      }
    }

    // C-Chain burn address holds burned C-Chain fees plus small direct transfers (~6.7K AVAX); must agree within 0.5%.
    if (Math.abs(cBurnChain / cBurnApi - 1) > 0.005) {
      throw new Error(`avax: C-Chain burn ${cBurnChain} disagrees with Data API totalCBurned ${cBurnApi}`);
    }
    // P-Chain getCurrentSupply includes ~1.26M AVAX of potential rewards for active staking periods not yet completed,
    // so pSupply minus C/P/X burns sits ~0.27% above Data API totalSupply; more than 1% drift fails the read.
    const chainNet = pSupply - cBurnChain - pBurnApi - xBurnApi;
    if (!(chainNet > 4e8) || Math.abs(apiTotal / chainNet - 1) > 0.01) {
      throw new Error(`avax: Data API total ${apiTotal} disagrees with chain net supply ${chainNet}`);
    }

    const total = Math.min(apiTotal, chainNet);
    const circulating = Math.min(apiCirc, total);
    return {
      circulating,
      total,
      src: apiUrl,
      excluded: [
        {
          reason: 'C-Chain burned AVAX (fee burn address)',
          holder: cBurnAddr,
          amount: cBurnChain,
          src: `${EXPLORER.avax}/address/${cBurnAddr}`,
        },
        {
          reason: 'X-Chain burned transaction fees',
          amount: xBurnApi,
          src: apiUrl,
        },
        {
          reason: 'P-Chain burned transaction fees',
          amount: pBurnApi,
          src: apiUrl,
        },
      ],
      note: 'P-Chain supply minus C-Chain, P-Chain and X-Chain burned AVAX, cross-checked between Avalanche Data API and live P-Chain / C-Chain RPC reads (staked AVAX counts as circulating).',
    };
  },
  // Plasma (XPL): total is read from Plasma mainnet by verifying the official 10B genesis block stateRoot and
  // subtracting native XPL permanently burned at the zero and dead addresses, while verifying that consensus
  // withdrawals remain empty and the Aquila validator-set contract holds no external stake (if validator inflation
  // activates later, this check fails closed rather than publishing a stale formula). Bridged XPL on BSC (LayerZero
  // OFT) is checked against the native XPL locked in Plasma's OFT adapter so nothing is double-counted.
  // Circulating is withheld: Team (25%), Investors (25%) and Ecosystem & Growth (32% post-launch) unlock through
  // September 2028, but XPL has no protocol-level transfer lock (MiCA whitepaper G.11) and the Team and Investor
  // genesis Safes have moved their allocations to unpublished custody wallets, so subtracting only the genesis
  // Safes would overstate circulating supply.
  async plasma(r = {}) {
    const xplBal = async addr => {
      const hex = await evm('plasma', 'eth_getBalance', [addr, 'latest']);
      if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex)) throw new Error('plasma: bad balance for ' + addr);
      return Number(BigInt(hex) / 10n ** 12n) / 1e6;
    };
    // Public rpc.plasma.to resets bursts above ~4 concurrent TLS handshakes; cap concurrency at 2 so undici reuses sockets.
    const pool2 = async tasks => {
      const out = new Array(tasks.length);
      let k = 0;
      await Promise.all([0, 1].map(async () => {
        while (k < tasks.length) { const i = k++; out[i] = await tasks[i](); }
      }));
      return out;
    };
    const extraCfg = r.exclude || [];
    const [genesis, head, bscOftTotal, valSetBal, zero, dead, bridgeLocked, ...restBals] = await pool2([
      () => evm('plasma', 'eth_getBlockByNumber', ['0x0', false]),
      () => evm('plasma', 'eth_getBlockByNumber', ['latest', false]),
      () => erc20TotalSupply('bsc', PLASMA_OFT),
      () => xplBal(PLASMA_VALIDATOR_SET),
      () => xplBal(ZERO),
      () => xplBal(BURN),
      () => xplBal(PLASMA_OFT),
      ...PLASMA_PROTOCOL_SAFES.map(([h]) => () => xplBal(h)),
      ...extraCfg.map(e => () => xplBal(e.holder)),
    ]);
    const safeBals = restBals.slice(0, PLASMA_PROTOCOL_SAFES.length);
    const extraBals = restBals.slice(PLASMA_PROTOCOL_SAFES.length);
    if (String(genesis?.hash).toLowerCase() !== PLASMA_GENESIS_HASH || String(genesis?.stateRoot).toLowerCase() !== PLASMA_GENESIS_STATE) {
      throw new Error('plasma: unexpected genesis block or stateRoot');
    }
    const blockNum = typeof head?.number === 'string' && /^0x[0-9a-f]+$/i.test(head.number) ? Number(BigInt(head.number)) : NaN;
    if (!(blockNum > 0) || !Array.isArray(head?.withdrawals) || head.withdrawals.length !== 0) {
      throw new Error('plasma: unexpected head block or active consensus withdrawals');
    }
    if (valSetBal !== 0) {
      throw new Error(`plasma: validator-set contract holds ${valSetBal} XPL; review staking emission state`);
    }
    if (![zero, dead, bridgeLocked, bscOftTotal, ...safeBals, ...extraBals].every(v => Number.isFinite(v) && v >= 0) || !(bscOftTotal > 0)) {
      throw new Error('plasma: bad chain read');
    }
    if (bscOftTotal > bridgeLocked * 1.0001) {
      throw new Error(`plasma: BSC bridged XPL ${bscOftTotal} above the ${bridgeLocked} locked in Plasma OFT adapter`);
    }
    const burned = zero + dead;
    const total = PLASMA_GENESIS_XPL - burned;
    if (!Number.isFinite(total) || !(total > 0 && total <= PLASMA_GENESIS_XPL)) {
      throw new Error('plasma: bad total supply ' + total);
    }
    const addrUrl = h => `${EXPLORER.plasma}/address/${h}`;
    const excluded = [
      ...(zero > 0 ? [{ reason: 'Zero address (unspendable)', holder: ZERO, amount: zero, src: addrUrl(ZERO) }] : []),
      ...(dead > 0 ? [{ reason: 'Burn address', holder: BURN, amount: dead, src: addrUrl(BURN) }] : []),
      ...PLASMA_PROTOCOL_SAFES.map(([h, reason], i) => ({
        reason: `${reason}, per Plasma mainnet genesis.json`,
        holder: h,
        amount: safeBals[i],
        src: PLASMA_GENESIS_SRC,
      })).filter(e => e.amount > 0),
      ...extraCfg.map((e, i) => ({
        reason: e.reason,
        holder: e.holder,
        amount: extraBals[i],
        src: e.src || addrUrl(e.holder),
      })).filter(e => e.amount > 0),
    ];
    const safeHeld = safeBals.reduce((a, b) => a + b, 0) + extraBals.reduce((a, b) => a + b, 0);
    const ceiling = total - safeHeld;
    if (!(ceiling > 0 && ceiling <= total)) throw new Error('plasma: bad supply ceiling ' + ceiling);
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const fmt2 = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      circulating: r.circulating === true ? ceiling : null,
      total,
      src: PLASMA_DOCS_SRC,
      parts: [{ chain: 'plasma', amount: total, src: EXPLORER.plasma }],
      excluded,
      note: `Total read from Plasma mainnet (verified 10,000,000,000 XPL genesis stateRoot in ${PLASMA_GENESIS_SRC}, less ${fmt2(burned)} XPL burned at the zero and dead addresses; consensus withdrawals are empty and validator inflation is inactive until external stake delegation launches per ${PLASMA_DOCS_SRC}). The ${fmt(bscOftTotal)} bridged XPL on BNB Smart Chain (${EXPLORER.bsc}/token/${PLASMA_OFT}) are LayerZero OFT tokens backed by ${fmt(bridgeLocked)} XPL locked in Plasma's OFT adapter (${addrUrl(PLASMA_OFT)}), so they sit inside the mainnet total. The genesis and protocol Safes still hold ${fmt(safeHeld)} XPL on-chain. Circulating is withheld: Team (25%), Investors (25%) and Ecosystem & Growth (32% post-launch) unlock on schedule through 25 Sep 2028 (${PLASMA_DOCS_SRC}), XPL carries no protocol-level transfer lock (MiCA whitepaper G.11), and the Team and Investor genesis Safes moved their allocations to unpublished custody wallets, so subtracting only the genesis Safes would overstate circulating.`,
    };
  },
  // LayerZero (ZRO): total is read across all 7 public EVM OFT deployments (eth, arbitrum, bsc, base, optimism,
  // polygon, avax), net of zero/dead-address burns. LayerZeroToken (0x6985...71cd) minted the fixed 1B cap once
  // at Ethereum deploy with no mint() or burn() function, and fee-switch referendums #1-#4 all voted Off; the gap
  // between 1,000,000,000 and the 7-chain totalSupply sum was bridged out via OFT._debit to EID 33002 (zerointerop,
  // LayerZero's native-ZRO Zero L1 verified via peers(33002) on Ethereum, which has no public RPC yet, plus minor
  // in-flight OFT messages). Labeled and Foundation-disclosed holdings (LayerZero 1, the Foundation Stargate-revenue
  // buyback multisig, and tokens stuck at the OFT contracts themselves) are read live into excluded, while
  // circulating stays withheld because Strategic Partners (32.2%) and Core Contributors (25.5%) vest monthly through
  // 20 Jun 2027 in unlabelled Safes, BitGo WalletSimple contracts and EOAs.
  async layerzero(r = {}) {
    const parts = [];
    const burnList = [];
    const stuckList = [];
    let rawTotal = 0;
    for (const chain of ZRO_CHAINS) {
      const supply = await erc20TotalSupply(chain, ZRO);
      const [zero, dead] = await Promise.all([
        erc20Balance(chain, ZRO, ZERO),
        erc20Balance(chain, ZRO, BURN),
      ]);
      const atSelf = await erc20Balance(chain, ZRO, ZRO);
      if (![supply, zero, dead, atSelf].every(v => Number.isFinite(v) && v >= 0) || !(supply > 0)) {
        throw new Error(`layerzero: bad ${chain} chain read`);
      }
      if (zero + dead + atSelf >= supply) {
        throw new Error(`layerzero: ${chain} unspendable ZRO exceeds supply`);
      }
      rawTotal += supply;
      const p = { chain, address: ZRO };
      parts.push({ chain, amount: supply, src: tokenLink(p) });
      if (zero > 0) burnList.push({ reason: `Zero address on ${chain} (unspendable)`, holder: ZERO, amount: zero, src: holderLink(p, ZERO) });
      if (dead > 0) burnList.push({ reason: `Burn address on ${chain}`, holder: BURN, amount: dead, src: holderLink(p, BURN) });
      if (atSelf > 0) stuckList.push({ reason: `Parked at the ZRO OFT contract on ${chain} (no rescue function)`, holder: ZRO, amount: atSelf, src: holderLink(p, ZRO) });
    }
    const zeroPeer = await evm('eth', 'eth_call', [{ to: ZRO, data: ZRO_ZERO_EID_CALL }, 'latest']);
    if (typeof zeroPeer !== 'string' || zeroPeer.toLowerCase() !== ZRO_ZERO_PEER) {
      throw new Error(`layerzero: unexpected Ethereum peers(33002) ${zeroPeer}`);
    }
    const walletBals = [];
    for (const [h] of ZRO_WALLETS) walletBals.push(await erc20Balance('eth', ZRO, h));
    const extraCfg = r.exclude || [];
    const extraBals = [];
    for (const e of extraCfg) extraBals.push(await erc20Balance(e.chain || 'eth', ZRO, e.holder));
    if (![...walletBals, ...extraBals].every(v => Number.isFinite(v) && v >= 0)) {
      throw new Error('layerzero: bad wallet balance');
    }
    const max = Number(r.max || ZRO_CAP);
    if (!(rawTotal > 1e8) || rawTotal > max * 1.0001) {
      throw new Error(`layerzero: 7-chain OFT supply ${rawTotal} outside 1e8..${max}`);
    }
    const burned = burnList.reduce((s, e) => s + e.amount, 0);
    const total = rawTotal - burned;
    const bridgedOut = Math.max(0, ZRO_CAP - rawTotal);
    const ethToken = { chain: 'eth', address: ZRO };
    const walletList = ZRO_WALLETS.map(([h, reason, src], i) => ({
      reason,
      holder: h,
      amount: walletBals[i],
      src: src || holderLink(ethToken, h),
    })).filter(e => e.amount > 0);
    const extraList = extraCfg.map((e, i) => ({
      reason: e.reason,
      holder: e.holder,
      amount: extraBals[i],
      src: e.src || holderLink({ chain: e.chain || 'eth', address: ZRO }, e.holder),
    })).filter(e => e.amount > 0);
    const nonBurnHeld = stuckList.reduce((s, e) => s + e.amount, 0)
      + walletList.reduce((s, e) => s + e.amount, 0)
      + extraList.reduce((s, e) => s + e.amount, 0);
    const ceiling = total - nonBurnHeld;
    if (!(ceiling > 0 && ceiling <= total)) throw new Error('layerzero: bad supply ceiling ' + ceiling);
    const fmt = v => Math.round(v).toLocaleString('en-US');
    const fmt2 = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      circulating: r.circulating === true ? ceiling : null,
      total,
      src: `${EXPLORER.eth}/token/${ZRO}`,
      parts,
      excluded: [...burnList, ...stuckList, ...walletList, ...extraList],
      note: `Total read across all 7 public EVM OFT deployments (${fmt(rawTotal)} ZRO, less ${fmt2(burned)} ZRO at burn addresses). LayerZeroToken (${EXPLORER.eth}/address/${ZRO}#code) minted the fixed 1,000,000,000 ZRO cap once in its Ethereum constructor with no mint() or burn() function, and protocol fee-switch referendums #1-#4 all voted Off (${ZRO_FEE_SWITCH_SRC}). Scanning peers(eid) across EIDs 1..40499 confirms that the remaining ${fmt(bridgedOut)} ZRO left the 7 EVM OFTs via OFT._debit to the 8th active OFT peer EID 33002 (zerointerop, LayerZero's native-ZRO Zero L1 bound on 2026-11-21 to peer 0x1ced7d571059a30db0fc9adc40346d2a1ce55b31 and listed in https://metadata.layerzero-api.com/v1/metadata with no public RPC yet, plus minor in-flight OFT messages). Excluded balances read live: ${fmt(nonBurnHeld)} ZRO across tokens parked at the OFT contracts themselves, the labeled LayerZero 1 wallet (0x1f90...3909), and the Foundation Stargate-revenue buyback multisig (${ZRO_BUYBACKS_SRC}). Circulating is withheld: per LayerZero's tokenomics (${ZRO_TOKENOMICS_SRC}), Strategic Partners (32.2%, 322M ZRO) and Core Contributors (25.5%, 255M ZRO) vest over 3 years (1-year lock then 24 monthly unlocks through 20 Jun 2027) alongside Foundation Ecosystem & Growth (14.5%, 145M ZRO), while other large Ethereum holders (GnosisSafeProxy 0x744D...DA24 and 0x806f...8431, BitGo WalletSimple contracts 0x6e0e...2427 / 0x637c...F7BF / 0xC2f3...D412, and EOA 0x7be1...7CFD) carry no public treasury or vesting label, so subtracting only the labeled wallets would overstate circulating.`,
    };
  },
};

const SEI_GRINGOTTS_INFO = Buffer.from('{"info":{}}').toString('base64');
const seiFromUsei = u => Number(u / 1_000_000n) + Number(u % 1_000_000n) / 1e6;
function seiTimestampMs(raw) {
  const s = String(raw ?? '');
  if (!/^\d+$/.test(s)) throw new Error('sei: bad vesting timestamp');
  const v = BigInt(s);
  if (v > 10n ** 15n) return Number(v / 1_000_000n);
  if (v > 10n ** 11n) return Number(v);
  return Number(v * 1000n);
}

// Full SEI balance (liquid + staked delegations + unbonding delegations) of one pacific-1 address in usei.
// Delegated SEI moves out of x/bank into the staking pool, so subtracting a staked vesting contract or
// treasury wallet requires summing all three.
async function seiAccountUsei(lcd, addr) {
  const [bal, del0, unb0] = await Promise.all([
    getJSON(`${lcd}/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=usei`),
    getJSON(`${lcd}/cosmos/staking/v1beta1/delegations/${addr}?pagination.limit=200`),
    getJSON(`${lcd}/cosmos/staking/v1beta1/delegators/${addr}/unbonding_delegations?pagination.limit=200`),
  ]);
  const rawBal = bal?.balance?.amount;
  if (typeof rawBal !== 'string' || !/^\d+$/.test(rawBal)) throw new Error('sei: bad bank balance for ' + addr);
  let sum = BigInt(rawBal);

  for (let page = 0, del = del0; ; page++) {
    if (!Array.isArray(del?.delegation_responses)) throw new Error('sei: bad delegations for ' + addr);
    for (const d of del.delegation_responses) {
      const a = d?.balance?.amount;
      if (typeof a !== 'string' || !/^\d+$/.test(a)) throw new Error('sei: bad delegation amount for ' + addr);
      sum += BigInt(a);
    }
    const next = del.pagination?.next_key;
    if (!next) break;
    if (page >= 20) throw new Error('sei: too many delegation pages for ' + addr);
    del = await getJSON(`${lcd}/cosmos/staking/v1beta1/delegations/${addr}?pagination.limit=200&pagination.key=${encodeURIComponent(next)}`);
  }

  for (let page = 0, unb = unb0; ; page++) {
    if (!Array.isArray(unb?.unbonding_responses)) throw new Error('sei: bad unbonding delegations for ' + addr);
    for (const u of unb.unbonding_responses) {
      if (!Array.isArray(u?.entries)) throw new Error('sei: bad unbonding entries for ' + addr);
      for (const e of u.entries) {
        if (typeof e?.balance !== 'string' || !/^\d+$/.test(e.balance)) throw new Error('sei: bad unbonding balance for ' + addr);
        sum += BigInt(e.balance);
      }
    }
    const next = unb.pagination?.next_key;
    if (!next) break;
    if (page >= 20) throw new Error('sei: too many unbonding pages for ' + addr);
    unb = await getJSON(`${lcd}/cosmos/staking/v1beta1/delegators/${addr}/unbonding_delegations?pagination.limit=200&pagination.key=${encodeURIComponent(next)}`);
  }
  return sum;
}

export async function readSupply(rule) {
  const f = METHODS[rule?.method];
  if (!f) throw new Error('unknown supply method ' + rule?.method);
  const s = await f(rule);
  if (!s) return null;
  return { max: rule.max ?? null, ...s, checked: true, method: rule.method, at: Date.now() };
}
