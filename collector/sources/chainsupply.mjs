// Supply read by us, from the chains themselves (or chain explorers that just add up chain data).
// Each checked coin has a rule in coins.json: { supply: { method, ... } }. A rule may list wallets that are
// not circulating (team, treasury, locked, burn) with a reason; their balances are read from the chain and
// subtracted, and the coin page shows each one.
import { getJSON } from '../../src/util.mjs';
import { erc20TotalSupply, erc20Balance, splBalance, trc20Balance, sol, substrateValue, evm, EXPLORER } from '../chains.mjs';
import { resetSupply } from './trac.mjs';
import { extraSupply } from './extra.mjs';

const BURN = '0x000000000000000000000000000000000000dEaD';
const LINK_TOKEN = '0x514910771AF9Ca656af840dff83E8264EcF986CA'; // Chainlink ERC-20 on Ethereum

// Algorand (ALGO): total supply comes from AlgoNode /v2/ledger/supply (total-money / 1e6).
// The 74 published Foundation and protocol addresses are from the archived Algorand Foundation
// transparency page (last updated July 19, 2025; live URL currently 301-redirects to home):
//   https://web.archive.org/web/20261003091805/https://algorand.co/algorand-foundation/transparency
// Because the Foundation's Q2 2026 Transparency Report ("Foundation holdings & reconciliation", p. 3,
// https://algorand.co/hubfs/Algorand%20Transparency%20Report%20Q2.pdf) puts ending Foundation holdings
// at 1,035,603k ALGO while the 74 published addresses currently hold less on-chain, we subtract
// Math.max(livePublishedSum, reportedFoundation) so circulating supply is never overstated.
const ALGO_API = 'https://mainnet-api.algonode.cloud';
const ALGO_EXPLORER = 'https://allo.info/account/';
const ALGO_TRANSPARENCY_ARCHIVE = 'https://web.archive.org/web/20261003091805/https://algorand.co/algorand-foundation/transparency';
const ALGO_Q2_2026_REPORT_URL = 'https://algorand.co/hubfs/Algorand%20Transparency%20Report%20Q2.pdf';
const ALGO_Q2_2026_FOUNDATION_HOLDINGS = 1035603000;
const ALGO_FOUNDATION_ACCOUNTS = [
  // Foundation Treasury (61 accounts)
  ...[
    'RW466IANOKLA36QARHMBX5VCY3PYDR3H2N5XHPDARG6UBOKCIK7WAMLSCA',
    '5NTF3MGWL5B2X426P27FE3AUPOUU3OYSRCLP3O4Y7JI2BFGJWPGUBOB2NI',
    'JEBTS2MKIIN2EWSXPWEWJ4GUMVOYB2JYZ4XCRD4KJPVNAO6YBJTPBBJBE4',
    'T5TGE4UXGMKZBQ3D3SOB34CQDMSRDXO5H6O55663SRD275ZMK6UG7PYNC4',
    'BMZT7U2KSXVGI7LWRJVDM7S7CEPT2VFOBMA45QC25WJ2TRB5P7USAD3TR4',
    '4SN2OPSTRXDAXAG5HY7GVSQUXYL5NXPENLMHRG2SH5Q2ZF5ACXJRGWDYNE',
    'IOSADRTSZUE6WBNXH7ANZANFDQ3GVCVUGZI3IP6T3AQI6RLGLI6TPNJQZA',
    'XNFDTOTUQME3NI2UWDJ5Y6LYOJKHNP4C7BKZYQ5GSDQ7JBXKEJ6HLM3LOE',
    '2TZAMEZZDWFY37QV66HXWQIYWYJIZKE2KP3QNPI2QHHKSMKUZEICNMMUFU',
    'TVUQW6NXMHZFZAV6D7PQMW4DIUL5UB42L2JLIYNGRHH6UW362HGNVI26DY',
    'B223SVF452UWAMMLNIHIUAPHYPX5J3HLVJF6MNOHUJE2NWJBG7C66JILGE',
    '4E7OINW7M6G6OT2SQZ7ZKFPWJ7CAAFTPOG2RZISJ3YZU5VCJQ64ZIROC44',
    'JB2EEILIBYWA3WACBIERYPG5TV6K6IHOWJKDFDHRGSCOEHTMEUUML7YXGE',
    '5WCIZNGQQT747WX3RTQIBJHOMJTQRUQBBH3PMK4YLP2X33AICJEUTL6F2E',
    'TBN2J7U3J5D4I7R2EK7XIBFNTEGVLHNORAXQ6YBJY5IVNY5IIKOXSJRYCE',
    '4H5UNRBJ2Q6JENAXQ6HNTGKLKINP4J4VTQBEPK5F3I6RDICMZBPGNH6KD4',
    'VEJGTLTKNT3VGLG2GVB2LMXC55WYW6J6WPZ76XTY2Y46TRJQOORWERYXYE',
    'L5BLJ4FNK6FNM7V5NUVT5QI6NQAERLLHYT24XH6RS2DUC4WDHPM5LOLGBY',
    '2JGGWKOIKYZB4HLG2X5DWHD5EWCUOQR7DC6VOEMWELIVNVVAF3BEUWJR7Y',
    'NRDDQ7MFRTUTMDAP4CBXDQ2IVP5VSLKDASADLLANYLFIKR7NQOGOUINYM4',
    'XBYLS2E6YI6XXL5BWCAMOA4GTWHXWENZMX5UHXMRNWWUQ7BXCY5WC5TEPA',
    'LHVWNRKGGOTSSDYK4P4WKXTHZI5SAFKUO5ALAW7NJ6G76RG4UXLBCWN5LQ',
    'WDWBXGJIXO3N6A7AZ25XU4UX5Q3FJJ5CCKFCUEUWE75ZF5I6H47X37EY6M',
    'EG6JXQ3TQBWRSTR3OEDUS5RTPLMA4KTMJIV3N6DO7XN2XRKIFEN64DY3BU',
    'EU6CHYSH7ZXLJQAPPIN6W3KS7VAURYZCB5P3ZCXMYCWNJF6V5RTVL2UPHU',
    'GJGK42UVZK4IDKN5MGP53A6FJEHRI52PI4E3BBJZRZCQZ666BKYILYXI2E',
    'O4N25TS4Z5SC34VZ6R6RU74PCEIUTJFSDSKETNDYU4CXI3C2BFYXCYEKAU',
    '62UUOSMOMD6XOSRROCIIMVVF2VX6N4CMVLCUFUVWV4Q4T4BHD7ETFNWMOI',
    'IHYR5OZGAIRSCDCNQJVFOPAOJT2SPG3YXAE3GGJPZRI6JV2GQSJAYG5NUY',
    'MKZIWVBDBZV7UK6XQY3DFLYSBLSJWCDHDJWK3JAHWCFMNJOH4ZXQSMOUCE',
    'A66JRYUOU523Z4MU53AJL3YAEHESH3KMVV7OJI4SMFRVIDNNVDK2LHSL4Y',
    'HRLD25IMT2Q4UPYOEUZIWHDI3ELCUIC5NLNC75O2NE7OLDJK7GZXDIK5QQ',
    'ROVA2AHXIEUFK63ULPXQJOMAGDRG2C4EZMGD63QHMGJTMTBLHTG5RPZUTM',
    'V3ZJHYSUMAUZXMSPO6GNDO6QQUGB5OWCHNAB5A743TKYC3RWBPAL3P5IIA',
    'BOYDCIT7PLRNGQWLPV3TONU3I6YJZVCNIIZNZ2GT4JKOD6SGT5FETAU6JE',
    '2LTZXETMTLAWET4CL3AZ353CXJ2HZE4RXFIGVD3HIBLB66G32HHGOAQOXE',
    '2V26XPENXHP2WRI4S4NFDIELZID2NTNA4MFQD5OM6SBBSG6NTJECHJHM5I',
    'UHCZHQASE5UA36NJNH4PYGF2H2XBJGSMTIPGA4NS4YA2L44VLQBWNLWQCA',
    'HD4IX4PGBCCLIUGPVTD3DTBWMQFIRJ4UBI67KXLTSJ23FUP54F67IXNLRE',
    'OFTMUIRIUX5YZDBIWJOGGK5IPR46HYHQ5OJTBYWDI5QOLVTSCUKPOODZ5U',
    '7ZCTFU4SA7KOYWCHEDYC5QTTH3NWOS3WDGSGJ5J263IRFWOMWNU2VIRSEA',
    'BWM3QGF2EIBSSE2YND52F7KR7TMFJIKAHR4FLRH5W2H3VWUQUNG6V6LWYM',
    'E4VMOYKWJCTKYVY447ALPOZMORITQYQVZVSYJ4ABLCCAAX4ZE6RNFDXZPI',
    'OMHYS6DGAS2GQIMALPYPSMNDQ2735J7Z76RQFH7KP2MIPDHXOZYVV3TVO4',
    'VZBMOTCMEHRITULBNLCWHA5U62UUXLQZMLVM6HPBPCMIM2YOMHDQRTK64E',
    'SSXTVQ2W3EICPJZ4SGX273KO2A6S37URYRF2ZKGBAQCFVKPC5MXUUI6UB4',
    'PS5RV6QGU5IVOFBTCYQVZHB3PQSVLR335OY7BVGB62ZV52SDEQ2PNTYUUQ',
    'DAV5VECJYNSFQFKWX37YANONLSMWHGUVPGNLLQLX6ANW4WN2SFLZQPXRXI',
    'JGIPWSM6QR6XYZIKDRJ54OGSYATLGPSTUMETAFULUS3JXWFALPLGU7OMOI',
    'LLDPRZJUNWC75TS4GUGH5WFDD4GFMFKLAMLCGO4SX5WDMIKCQPCZ6ESERM',
    'KEU3FQHJ5CVO7DC5OJKHR74Z6M3X26O4IZYHHAIV6T7SLYHJJG32LCHICQ',
    'XUPBGF6OXIRVIGU2VHHYJFI4JEHLLIPNLMWNCSUZ7F44KYFRPV52ULIYNI',
    '3NGBML54PC7AJATJGW5BXMF6ZOFO2V4VTKKRTS3EAZXTVVHSPXTNV2GKEA',
    'VAOTJJLJP54QIKGCCFNJZVNHXXFZUZ3AAXCVGX5LRDQXQOUZRWBFBASUDQ',
    'OM2NLTOCWVDGX5XI6ETIQPW2CEILSEJFOC4NX5TJCTU6WMNC2KT2OUCT4M',
    'EOU3RSLHSCS247TWWMWQY2FPMOTEALFCNXCR2BV4B3E2HMIIHWCJNIGKFM',
    'GKKTNJ42QIW2BO7UUWGLTMFPVN744LJ5T3QXVSRAV5752476LXTQHWOUUM',
    'CFB4XBBO6KDDFPGWT2LDF7O7FJBVSPXH2ZBBTRAZAC4DVUM6KB5IU7XH3E',
    '4STCN6LMGELTGPF5JTOIPNWM3UBJL6IGBZG6I4TKAL2K3BEJBBYVE56QQY',
    '6OZQ3ENWXS4JFMIUKMKHPTQPWJVSN6VGBMSBR2E3BY3S5CPF2JPLGUXAJQ',
    '2ZHDNJEHQ7NIDKRML7IWSYJXGCN6WUURKT5LGTLF7I5ABFCM2KE4NL3XT4',
  ].map(holder => ({ holder, reason: 'Algorand Foundation treasury' })),
  // Protocol fee sink (1 account)
  { holder: 'Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA', reason: 'Protocol fee sink (listed by the Foundation)' },
  // Structured selling / Market Operations (2 accounts)
  { holder: '37VPAD3CK7CDHRE4U3J75IE4HLFN5ZWVKJ52YFNBX753NNDN6PUP2N7YKI', reason: 'Algorand Foundation structured selling' },
  { holder: '44GWRTQGSAYUJJCQ3GFINYKZXMBDVKCF75VMCXKORN7ZJ6BKPNG2RMGH7E', reason: 'Algorand Foundation structured selling' },
  // Governance and reward payments (10 accounts)
  ...[
    'DLG5EP7UMPHQNA7Z4IEO6GTIDSN6WG4HUUXBJ72E7PTP2NXIOLGNS4DNKI',
    'E53AV44SU2UFR3SD6EW3KEVXMPC4HFNRYSDXYNKKYNPPC63ID7USKWCKXI',
    '2K24MUDRJPOOZBUTE5WW44WCZZUPVWNYWVWG4Z2Z2ZZVCYJPVDWRVHVJEQ',
    '5GPWAOJJC45WCM5QBMRW5F53MTDVAFJDIDNF2YMTI7EN5YUQMLFJLKSKUM',
    'DRWUX3L5EW7NAYCFL3NWGDXX4YC6Y6NR2XVYIC6UNOZUUU2ERQEAJHOH4M',
    'PN4J5F5HRMQ7VAHRQWQ3G52T25KAUMPKUDU7B2GWFNLI3ZDU4W4DQITPIA',
    'BU3I4ASYTQULW5KWMNCBMF6NQSSC6WM52KRUQEVVH4WQP2VHDKUKHR2W5Q',
    'OHYAQI5UJAY77R4TIZZVYPNNKVYEHHI36QUIU3NUKPMIZJAQKDRFC77XMM',
    '3KWWDTQLXPKUPL3W4M4VVAE3VITOYIRCDT5Z2RRHNJE5KY3CTYMV6J2LF4',
    'NSIVDOYUJCIYYC33XJABCZZNARSU6J6ZC5DPUOWIIFQQY4IIZIJTTEE4NY',
  ].map(holder => ({ holder, reason: 'Algorand Foundation governance and reward payments' })),
];

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
  // Algorand (ALGO): ledger total-money from AlgoNode minus the larger of (a) the live sum of the
  // 74 Foundation & protocol fee-sink addresses from the archived transparency page and (b) the
  // Foundation's Q2 2026 Transparency Report balance (1,035,603k ALGO), so unlisted Foundation wallets
  // never cause circulating supply to be overstated.
  async algorand(r = {}) {
    const supplyUrl = `${ALGO_API}/v2/ledger/supply`;
    const sup = await getJSON(supplyUrl);
    const totalMicro = sup?.['total-money'];
    // ~9.82B ALGO in microAlgos (~9.82e15) exceeds Number.MAX_SAFE_INTEGER (9.007e15).
    if (typeof totalMicro !== 'number' || !Number.isFinite(totalMicro) || totalMicro <= 0) {
      throw new Error('bad Algorand ledger supply');
    }
    const total = totalMicro / 1e6;
    if (!(total > 5e9)) throw new Error('bad Algorand total supply ' + total);
    const excluded = [];
    let liveSum = 0;
    for (let i = 0; i < ALGO_FOUNDATION_ACCOUNTS.length; i += 10) {
      const batch = ALGO_FOUNDATION_ACCOUNTS.slice(i, i + 10);
      const res = await Promise.all(batch.map(async a => {
        // algod returns HTTP 200 with amount: 0 for closed/empty accounts; never catch 404 as 0.
        const acct = await getJSON(`${ALGO_API}/v2/accounts/${a.holder}?exclude=all`);
        if (typeof acct?.amount !== 'number' || !Number.isFinite(acct.amount) || acct.amount < 0) {
          throw new Error('bad Algorand account balance for ' + a.holder);
        }
        return { ...a, algo: acct.amount / 1e6 };
      }));
      for (const a of res) {
        liveSum += a.algo;
        if (a.algo > 0) {
          excluded.push({
            reason: a.reason,
            holder: a.holder,
            amount: a.algo,
            src: ALGO_EXPLORER + a.holder,
          });
        }
      }
    }
    const reportedFloor = r.reportedFoundation ?? ALGO_Q2_2026_FOUNDATION_HOLDINGS;
    if (typeof reportedFloor !== 'number' || !Number.isFinite(reportedFloor) || reportedFloor < 0) {
      throw new Error('bad Algorand reported Foundation balance');
    }
    const usedFloor = reportedFloor > liveSum;
    if (usedFloor) {
      excluded.push({
        reason: `Unlisted Foundation holdings gap to Q2 2026 Transparency Report balance (${reportedFloor.toLocaleString('en-US')} ALGO reported vs ${Math.round(liveSum).toLocaleString('en-US')} ALGO on ${ALGO_FOUNDATION_ACCOUNTS.length} published addresses)`,
        amount: reportedFloor - liveSum,
        src: ALGO_Q2_2026_REPORT_URL,
      });
    }
    const appliedExcluded = usedFloor ? reportedFloor : liveSum;
    const circulating = total - appliedExcluded;
    if (!(circulating > 0) || circulating > total) throw new Error('bad Algorand circulating supply');
    const note = usedFloor
      ? `Algorand ledger total minus the larger of live published addresses (${Math.round(liveSum).toLocaleString('en-US')} ALGO across ${ALGO_FOUNDATION_ACCOUNTS.length} accounts from ${ALGO_TRANSPARENCY_ARCHIVE}) and the Q2 2026 Transparency Report Foundation balance (${reportedFloor.toLocaleString('en-US')} ALGO, ${ALGO_Q2_2026_REPORT_URL}). Applied: Q2 2026 report floor.`
      : `Algorand ledger total minus the larger of live published addresses (${Math.round(liveSum).toLocaleString('en-US')} ALGO across ${ALGO_FOUNDATION_ACCOUNTS.length} accounts from ${ALGO_TRANSPARENCY_ARCHIVE}) and the Q2 2026 Transparency Report Foundation balance (${reportedFloor.toLocaleString('en-US')} ALGO, ${ALGO_Q2_2026_REPORT_URL}). Applied: live published addresses sum.`;
    return {
      circulating,
      total,
      src: supplyUrl,
      excluded,
      note,
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
