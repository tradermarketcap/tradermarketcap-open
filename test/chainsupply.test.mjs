import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSupply } from '../collector/sources/chainsupply.mjs';
import { EVM_RPC } from '../collector/chains.mjs';
import { tnkReset } from '../collector/sources/trac.mjs';

// Real response shapes, captured from BNB Chain's public RPC and bnbburn.info on 2026-11-21. No network in tests.
const BALANCES = {
  '0x0000000000000000000000000000000000001004': '0x157a9cb53fd94060e95045', // TokenHub ~25,966,461.7
  '0x000000000000000000000000000000000000dead': '0xf02fa7f3c8ab4aed33f9e', // burn address ~18,147,952.9
  '0x0000000000000000000000000000000000000000': '0x150430259f7af74df946', // zero address ~99,246.95
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const runeSource = 'https://gateway.liquify.com/chain/thorchain_api/thorchain/supply';
function mockRuneSupply(body) {
  globalThis.fetch = async url => {
    assert.equal(String(url), runeSource);
    return { ok: true, json: async () => body };
  };
}

test('RUNE: the seed rule returns the node’s whole-RUNE supply and reserve without double deduction', async () => {
  const { thorchain } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  assert.equal(thorchain.symbol, 'RUNE');
  // Native THORNode response. Independent truncation leaves a one-RUNE difference.
  mockRuneSupply({ total: 353826119, circulating: 329090305, locked: { reserve: 24735813 } });
  const s = await readSupply(thorchain.supply);
  assert.equal(s.total, 353826119);
  assert.equal(s.circulating, 329090305);
  assert.deepEqual(s.excluded, [{ reason: 'THORChain reserve module', amount: 24735813, src: runeSource }]);
  assert.equal(s.checked, true);
  assert.equal(s.src, runeSource);
});

test('RUNE: reject missing reserve, invalid units or inconsistent totals', async () => {
  for (const body of [
    { total: 100, circulating: 100 },
    { total: 100, circulating: 97, locked: { reserve: '3' } },
    { total: 100, circulating: 101, locked: { reserve: 0 } },
    { total: 100, circulating: 95, locked: { reserve: 3 } },
  ]) {
    mockRuneSupply(body);
    await assert.rejects(readSupply({ method: 'thorchain' }), /THORNode RUNE supply/);
  }
  mockRuneSupply({ total: 100, circulating: 100, locked: { reserve: 0 } });
  assert.equal((await readSupply({ method: 'thorchain' })).circulating, 100);
});

// Fake fetch: answers eth_getBalance from BALANCES and the burn tracker with the given body.
function fakeChain(tracker) {
  globalThis.fetch = async (url, opts = {}) => {
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (String(url).includes('bnbburn.info')) return reply(tracker);
    const req = JSON.parse(opts.body);
    assert.equal(req.method, 'eth_getBalance');
    return reply({ jsonrpc: '2.0', id: req.id, result: BALANCES[req.params[0].toLowerCase()] });
  };
}

test('bnb: circulating is the lower of the chain ceiling and BNB Chain burn tracker', async () => {
  fakeChain({ bcSupply: 0, bscSupply: 131510229.21 });
  const s = await readSupply({ method: 'bnb' });
  const ceiling = 176406560.9 - 25966461.675289 - 18147952.881559 - 99246.95247;
  assert.ok(Math.abs(s.total - ceiling) < 0.01);
  assert.ok(Math.abs(s.circulating - 131510229.21) < 0.01);
  assert.ok(s.circulating <= s.total);
  const out = s.excluded.reduce((a, e) => a + e.amount, 0);
  assert.ok(Math.abs(176406560.9 - out - s.circulating) < 0.01, 'excluded wallets explain the whole gap');
  assert.equal(s.checked, true);
});

test('bnb: tracker above the chain ceiling never raises circulating', async () => {
  fakeChain({ bcSupply: 0, bscSupply: 132500000 });
  const s = await readSupply({ method: 'bnb' });
  assert.equal(s.circulating, s.total);
  assert.equal(s.excluded.length, 3);
});

test('bnb: a broken tracker fails the read instead of guessing', async () => {
  fakeChain({ bcSupply: 0, bscSupply: 0 });
  await assert.rejects(readSupply({ method: 'bnb' }), /tracker/);
  fakeChain({ bcSupply: 0, bscSupply: 90000000 });
  await assert.rejects(readSupply({ method: 'bnb' }), /tracker/);
});

test('chainlink: reads official supply and non-circulating wallets', async () => {
  const total = 1000000000n * 10n ** 18n;
  const excluded = 50000000n * 10n ** 18n;
  const circ = total - excluded;
  globalThis.fetch = async url => {
    assert.ok(String(url).includes('supply.chain.link'));
    return { ok: true, status: 200, json: async () => ({
      totalSupply: total.toString(), circulatingSupply: circ.toString(),
      balances: [{ address: '0xabc', balance: excluded.toString() }, { address: '0xzero', balance: '0' }],
    }) };
  };
  const s = await readSupply({ method: 'chainlink' });
  assert.equal(s.total, 1000000000);
  assert.equal(s.circulating, 950000000);
  assert.equal(s.excluded.length, 1);
  assert.equal(s.excluded[0].amount, 50000000);
  assert.equal(s.checked, true);
});

test('chainlink: a supply that does not reconcile fails the read', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    totalSupply: (1000n * 10n ** 18n).toString(), circulatingSupply: (900n * 10n ** 18n).toString(), balances: [],
  }) });
  await assert.rejects(readSupply({ method: 'chainlink' }), /reconcile/);
});

// Fake Sui endpoints: GraphQL returns the given total (in mist), the Explorer circulation API
// returns the given circulating figure. Response shapes captured 2026-11-21.
function fakeSui({ totalMist = '10000000000000000000', circ = 4139043544.1303763 } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('graphql.mainnet.sui.io')) {
      return { ok: true, status: 200, json: async () => ({ data: { coinMetadata: { decimals: 9, supply: totalMist } } }) };
    }
    assert.ok(u.includes('sui-circulation.suiexplorer.com'));
    return { ok: true, status: 200, json: async () => circ };
  };
  return () => { globalThis.fetch = realFetch; };
}

test('sui: total comes from Sui GraphQL, circulating from the Explorer API, locked remainder excluded', async () => {
  const restore = fakeSui();
  try {
    const s = await readSupply({ method: 'sui', max: 10000000000 });
    assert.equal(s.circulating, 4139043544.1303763);
    assert.equal(s.total, 10000000000);
    assert.equal(s.excluded.length, 1);
    assert.ok(Math.abs(s.excluded[0].amount - (10000000000 - 4139043544.1303763)) < 0.01);
    assert.equal(s.checked, true);
  } finally { restore(); }
});

test('sui: a broken API answer fails the read', async () => {
  const restore = fakeSui({ circ: 0 });
  try { await assert.rejects(readSupply({ method: 'sui' }), /bad sui/); }
  finally { restore(); }
});

// AERO on Base. Values below are the live reads on 2026-11-23, Base block 61,194,455:
// new AERO totalSupply 2,149,873,046, sAERO 1,080,578,812, and the two migration vaults
// 274,913,277 + 10,614,436. Aero's upgrade page publishes ~1.07B as the MAXIMUM circulating
// supply after every holder upgrades and says tokens never upgraded never reach circulation,
// so AERO parked in the migration contracts is not circulating. The three exclusions
// reconcile: 783,766,521 circulating + 285,527,713 in the vaults = 1,069,294,234, which is
// exactly total less sAERO, i.e. the published ~1.07B maximum.
const AERO = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';
const AERO_SAERO = '0xbf7977e1521e9a3032bf7243ee4712f311f13915';
const AERO_VAULTS = ['0x22a2f7340a3fb4c7c389d91ee954766b12476721', '0x6dae95fe833f190640db1176f8c8a2e50c6a66c0'];
const AERO_EXCLUDE = [
  { chain: 'base', holder: '0xBF7977E1521e9a3032bf7243Ee4712f311f13915', reason: 'sAERO' },
  { chain: 'base', holder: '0x22a2F7340a3fB4C7C389D91eE954766B12476721', reason: 'migration vault' },
  { chain: 'base', holder: '0x6daE95FE833f190640dB1176F8C8a2e50C6a66c0', reason: 'migration vault' },
];

function fakeBase({ total = '0x' + (2149873046n * 10n ** 18n).toString(16),
                    saero = '0x' + (1080578812n * 10n ** 18n).toString(16),
                    vault1 = '0x' + (274913277n * 10n ** 18n).toString(16),
                    vault2 = '0x' + (10614436n * 10n ** 18n).toString(16),
                    failAt = null } = {}) {
  const balances = { [AERO_SAERO]: saero, [AERO_VAULTS[0]]: vault1, [AERO_VAULTS[1]]: vault2 };
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    const { to, data } = req.params[0];
    seen.push({ to: to.toLowerCase(), selector: data.slice(0, 10) });
    if (data.startsWith('0x313ce567')) return reply('0x' + (18).toString(16).padStart(64, '0'));
    if (data.startsWith('0x18160ddd')) return reply(total);
    const holder = '0x' + data.slice(-40);
    if (failAt === holder) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return reply(balances[holder] || '0x' + (0n).toString(16));
  };
  return seen;
}

const aeroRule = () => ({ method: 'tokens', parts: [{ chain: 'base', address: '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee' }], exclude: AERO_EXCLUDE });

test('aero: circulating subtracts sAERO and both migration vaults, and the three reconcile to the published ~1.07B maximum', async () => {
  const seen = fakeBase();
  const s = await readSupply(aeroRule());
  assert.equal(s.total, 2149873046);
  for (const h of [AERO_SAERO, ...AERO_VAULTS]) {
    const e = s.excluded.find(x => x.holder.toLowerCase() === h);
    assert.ok(e, `excluded ${h}`);
  }
  // each excluded balance is subtracted exactly once
  assert.equal(s.excluded.find(e => e.holder.toLowerCase() === AERO_SAERO).amount, 1080578812);
  assert.equal(s.excluded.find(e => e.holder.toLowerCase() === AERO_VAULTS[0]).amount, 274913277);
  assert.equal(s.excluded.find(e => e.holder.toLowerCase() === AERO_VAULTS[1]).amount, 10614436);
  assert.equal(s.circulating, 2149873046 - 1080578812 - 274913277 - 10614436);
  // circulating + still-unclaimed vault balances == total less sAERO == Aero's published max (~1.07B)
  const max = s.circulating + 274913277 + 10614436;
  assert.ok(Math.abs(max - 1.07e9) < 1e7, `reconciles to ~1.07B, got ${max}`);
  // circulating can never exceed the published maximum
  assert.ok(s.circulating < 1.07e9);
  // only the live AERO contract is queried
  assert.ok(seen.every(c => c.to === AERO));
});

test('aero: a failed migration-vault balance read throws instead of publishing an overstated circulating', async () => {
  fakeBase({ failAt: AERO_VAULTS[0] });
  await assert.rejects(readSupply(aeroRule()));
});

test('aero: a failed sAERO balance read throws instead of publishing an overstated circulating', async () => {
  fakeBase({ failAt: AERO_SAERO });
  await assert.rejects(readSupply(aeroRule()));
});

// Real shapes captured 2026-11-23.
// Chain: POST api.mainnet.aptoslabs.com/v1/view {function:'0x1::coin::supply'}
//        -> [{"vec":["121198072837308975"]}]
// Foundation: GET aptos-supply.dev.gcp.aptosdev.com/supply
//        -> {current_circulating_supply:889393790.55, current_total_supply:1211980728.41, ...}
function fakeAptos({ chain = [{ vec: ['121198072837308975'] }],
                     pub = { current_circulating_supply: 889393790.5553615, current_total_supply: 1211980728.417503 },
                     pubFails = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('aptos-supply')) {
      if (pubFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => pub };
    }
    assert.ok(u.includes('api.mainnet.aptoslabs.com/v1/view'), 'only the mainnet chain view is called');
    const req = JSON.parse(opts.body);
    assert.equal(req.function, '0x1::coin::supply');
    assert.deepEqual(req.type_arguments, ['0x1::aptos_coin::AptosCoin']);
    return { ok: true, status: 200, json: async () => chain };
  };
  return calls;
}

test('aptos: circulating is the Foundation\'s published figure and total is the chain read', async () => {
  const calls = fakeAptos();
  const s = await readSupply({ method: 'aptos', max: 2100000000 });
  assert.ok(Math.abs(s.total - 1211980728.3730898) < 1e-5, 'total from the chain read');
  assert.ok(Math.abs(s.circulating - 889393790.5553615) < 1e-4, 'circulating from the Foundation API');
  assert.ok(s.circulating < s.total);
  assert.equal(s.checked, true);
  assert.equal(s.max, 2100000000);
  // both first-party endpoints were actually consulted
  assert.ok(calls.some(u => u.includes('aptos-supply')), 'Foundation supply API queried');
  assert.ok(calls.some(u => u.includes('api.mainnet.aptoslabs.com/v1/view')), 'chain queried');
  assert.match(s.note, /Foundation/i);
});

test('aptos: the older nested-array chain shape is read too', async () => {
  fakeAptos({ chain: [['121198072837308975']] });
  const s = await readSupply({ method: 'aptos' });
  assert.ok(Math.abs(s.total - 1211980728.3730898) < 1e-5);
  assert.ok(Math.abs(s.circulating - 889393790.5553615) < 1e-4);
});

test('aptos: a Foundation total that disagrees with the chain fails instead of publishing', async () => {
  // stale or wrong-network API: its total is far from the chain's
  fakeAptos({ pub: { current_circulating_supply: 654537401.49, current_total_supply: 1151290520.58 } });
  await assert.rejects(readSupply({ method: 'aptos' }), /foundation total .* != chain total/);
});

test('aptos: a Foundation API failure fails the read instead of guessing circulating', async () => {
  fakeAptos({ pubFails: true });
  await assert.rejects(readSupply({ method: 'aptos' }));
});

test('aptos: circulating above total is rejected', async () => {
  fakeAptos({ pub: { current_circulating_supply: 1300000000, current_total_supply: 1211980728.417503 } });
  await assert.rejects(readSupply({ method: 'aptos' }), /circulating .* exceeds total/);
});

test('aptos: a missing or junk supply answer fails the read instead of publishing 0', async () => {
  fakeAptos({ chain: [{ vec: [] }] });
  try { await assert.rejects(readSupply({ method: 'aptos' }), /no integer supply/); }
  finally { globalThis.fetch = realFetch; }
  fakeAptos({ chain: [{ vec: ['12.5e6'] }] });
  try { await assert.rejects(readSupply({ method: 'aptos' }), /no integer supply/); }
  finally { globalThis.fetch = realFetch; }
  fakeAptos({ chain: [] });
  try { await assert.rejects(readSupply({ method: 'aptos' }), /no integer supply/); }
  finally { globalThis.fetch = realFetch; }
});

// Real response shapes captured from tonapi.io and toncenter.com on 2026-11-22.
function fakeTon({
  seqno = 106899815,
  mcGrams = '2518587368660000000',
  shards = [{ last_known_block: { value_flow: { to_next_blk: { grams: '2769169539050000000' } } } }],
  lockerOk = true,
  lockerNano = '1240902290670000000',
  suspendedUntil = Math.floor(Date.now() / 1000) + 86400 * 90,
  suspendedAccounts = Array.from({ length: 105 }, (_, i) => `0:${String(i).padStart(64, '0')}`),
  bulkFail = false,
  bulkShort = false,
} = {}) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (u.endsWith('/v2/blockchain/masterchain-head')) {
      return reply({ seqno, value_flow: { to_next_blk: { grams: mcGrams } } });
    }
    if (u.endsWith(`/v2/blockchain/masterchain/${seqno}/shards`)) {
      return reply({ shards });
    }
    if (u.includes('toncenter.com/api/v2/getAddressBalance')) {
      return reply({ ok: lockerOk, result: lockerNano });
    }
    if (u.endsWith('/v2/blockchain/config')) {
      return reply({ '44': { suspended_until: suspendedUntil, accounts: suspendedAccounts } });
    }
    if (u.endsWith('/v2/accounts/_bulk')) {
      if (bulkFail) return { ok: false, status: 500, text: async () => 'bulk error', json: async () => ({}) };
      const req = JSON.parse(opts.body);
      const list = bulkShort ? req.account_ids.slice(0, -1) : req.account_ids;
      return reply({ accounts: list.map(addr => ({ address: addr, balance: '10000000000000' })) }); // 10,000 TON each
    }
    throw new Error('unexpected url ' + u);
  };
  return () => { globalThis.fetch = prevFetch; };
}

test('ton: sums masterchain and shards and subtracts Believers Fund locker and config param 44 frozen wallets', async () => {
  const restore = fakeTon();
  try {
    const s = await readSupply({ method: 'ton' });
    const expectedTotal = 2518587368.66 + 2769169539.05;
    const expectedFrozen = 105 * 10000;
    const expectedCirc = expectedTotal - 1240902290.67 - expectedFrozen;
    assert.ok(Math.abs(s.total - expectedTotal) < 0.01);
    assert.ok(Math.abs(s.circulating - expectedCirc) < 0.01);
    assert.equal(s.excluded.length, 2);
    assert.ok(s.excluded[1].reason.startsWith('105 frozen early-miner wallets'));
    assert.equal(s.checked, true);
  } finally {
    restore();
  }
});

test('ton: skips config param 44 frozen wallets once suspended_until has passed', async () => {
  const restore = fakeTon({ suspendedUntil: 1700000000 });
  try {
    const s = await readSupply({ method: 'ton' });
    assert.equal(s.excluded.length, 1);
    assert.equal(s.excluded[0].holder, 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2');
  } finally {
    restore();
  }
});

test('ton: fails when masterchain, locker, or param 44 bulk balance read fails', async () => {
  let restore = fakeTon({ mcGrams: null });
  try { await assert.rejects(readSupply({ method: 'ton' }), /masterchain head/); }
  finally { restore(); }

  restore = fakeTon({ lockerOk: false });
  try { await assert.rejects(readSupply({ method: 'ton' }), /locker balance/); }
  finally { restore(); }

  restore = fakeTon({ bulkFail: true });
  try { await assert.rejects(readSupply({ method: 'ton' }), /500/); }
  finally { restore(); }

  restore = fakeTon({ bulkShort: true });
  try { await assert.rejects(readSupply({ method: 'ton' }), /bulk response/); }
  finally { restore(); }
});


test('jupiter: circulating comes from Jupiter Token API and never exceeds total', async () => {
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => [{ id: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', circSupply: 3319369204.37, totalSupply: 6861485633.51101 }],
  });
  const s = await readSupply({ method: 'jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' });
  assert.equal(s.circulating, 3319369204.37);
  assert.equal(s.total, 6861485633.51101);
  assert.equal(s.excluded.length, 1);
  assert.ok(Math.abs(s.excluded[0].amount - (6861485633.51101 - 3319369204.37)) < 1e-3);
  assert.equal(s.checked, true);
});

test('jupiter: a mint mismatch fails the read', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [{ id: 'OtherMint1111111111111111111111111111111111', circSupply: 1, totalSupply: 2 }] });
  await assert.rejects(readSupply({ method: 'jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' }), /mint mismatch/);
});

test('jupiter: bad API payload fails the read', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [{ id: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', circSupply: 0, totalSupply: 0 }] });
  await assert.rejects(readSupply({ method: 'jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' }), /bad jupiter supply/);
});


// Fake Solana RPC: getTokenSupply returns the mint total, getTokenAccountsByOwner returns the
// given holder balances. Response shapes captured from api.mainnet-beta.solana.com on 2026-11-22.
function fakeSol({ total = '9999958592238969', holders = {} } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    assert.ok(String(url).includes('solana'), 'only the Solana RPC host is called');
    const req = JSON.parse(opts.body);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    if (req.method === 'getTokenSupply') return reply({ value: { amount: total, decimals: 6, uiAmountString: (Number(total) / 1e6).toString() } });
    assert.equal(req.method, 'getTokenAccountsByOwner');
    const amt = holders[req.params[0]];
    if (amt === undefined) return reply({ value: [] });
    return reply({ value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: String(amt) } } } } } }] });
  };
  return () => { globalThis.fetch = realFetch; };
}

const PYTH_RULE = {
  method: 'tokens',
  parts: [{ chain: 'sol', address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' }],
  circulating: false,
  max: 10000000000,
  exclude: [{ chain: 'sol', holder: 'Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak', reason: 'Pyth DAO Treasury (native SOL wallet)' }],
};

test('pyth: total is read from the mint and circulating stays unpublished', async () => {
  const restore = fakeSol({ total: '9999958592238969', holders: { Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak: 51523852.59021 } });
  try {
    const s = await readSupply(PYTH_RULE);
    assert.equal(s.circulating, null, 'circulating is withheld, never overstated');
    assert.ok(Math.abs(s.total - 9999958592.238969) < 0.01);
    assert.equal(s.max, 10000000000);
    assert.equal(s.excluded.length, 1);
    assert.equal(s.excluded[0].amount, 51523852.59021);
    assert.ok(!JSON.stringify(s.excluded).includes('CO-PIP-105'), 'the reassigned publisher accounts are not cited as locked supply');
    assert.equal(s.checked, true);
    assert.equal(s.method, 'tokens');
  } finally { restore(); }
});

test('pyth: a treasury wallet that has moved fails the read rather than guessing', async () => {
  const restore = fakeSol({ total: '9999958592238969', holders: {} });
  try {
    const s = await readSupply(PYTH_RULE);
    assert.equal(s.circulating, null, 'circulating stays withheld even when the treasury reads 0');
    assert.equal(s.excluded.length, 0, 'a zero balance is not reported as an exclusion');
    assert.ok(Math.abs(s.total - 9999958592.238969) < 0.01);
  } finally { restore(); }
});

// QNT: totalSupply() on 0x4a22...4675 is a pre-burn artefact (it reads 45,467,000 forever because the
// 2018 burn parked the unsold tokens at the contract address instead of decrementing the counter).
// Real values read on Ethereum mainnet, 2026-11-22:
//   totalSupply()            45,467,000
//   balanceOf(contract)       9,550,897.141327927
//   balanceOf(0x...dEaD)          0.11700656748701552
const QNT = '0x4a220E6096B25EADb88358cb44068A3248254675';
const QNT_TOTAL_HEX = '0x000000000000000000000000000000000000000000259c03024205ba6ae00000'; // 45,467,000
const QNT_CONTRACT_HEX = '0x00000000000000000000000000000000000000000007e67b2be6cff4afd16600'; // 9,550,897.141327927
const QNT_DEAD_HEX = '0x000000000000000000000000000000000000000000000000019fb0da6b738a60'; // 0.11700656748701552

function fakeQuant({ total = QNT_TOTAL_HEX, atContract = QNT_CONTRACT_HEX, atBurn = QNT_DEAD_HEX } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    const data = req.params[0].data;
    calls.push(data);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    if (data.startsWith('0x313ce567')) return reply('0x' + '12'.padStart(64, '0')); // 18 decimals
    if (data.startsWith('0x18160ddd')) return reply(total);
    // balanceOf: which holder?
    const holder = '0x' + data.slice(-40);
    return reply(holder === '0x000000000000000000000000000000000000dead' ? atBurn : atContract);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const QNT_RULE = {
  method: 'quant',
  address: QNT,
  disclosedTotal: 14612493.080826178,
  burnedAt2018: 9545765.95,
  max: 14612493.080826178,
};

// Live rule as shipped: circulating is unpublished because Quant's current company holdings
// are unknown, so only the total (a fixed, disclosed number) is published.
const QNT_SHIPPED = { ...QNT_RULE, circulating: false };

test('quant: publishes the disclosed post-burn total, not the 45.4M totalSupply() artefact', async () => {
  const f = fakeQuant();
  try {
    const s = await readSupply(QNT_RULE);
    // the counter is read (to prove it is still the artefact) but must never become the published total
    assert.ok(f.calls.some(d => d.startsWith('0x18160ddd')), 'totalSupply() was queried');
    assert.equal(s.total, 14612493.080826178);
    assert.ok(s.total < 45467000, 'the pre-burn counter is not published as supply');
    assert.equal(s.checked, true);
    assert.ok(Math.abs(s.circulating - 14607361.772491684) < 1e-6);
    assert.ok(s.circulating < s.total);
    // excluded: the burned remainder parked at the contract, plus the burn address
    assert.equal(s.excluded.length, 2);
    const parked = s.excluded.find(e => e.holder.toLowerCase() === QNT.toLowerCase());
    assert.ok(Math.abs(parked.amount - 5131.191327927) < 1e-6);
    assert.match(parked.reason, /parked at the token contract/i);
    assert.ok(Math.abs(s.excluded.reduce((a, e) => a + e.amount, 0) + s.circulating - s.total) < 1e-6,
      'excluded balances explain the whole gap');
  } finally { f.restore(); }
});

test('quant: circulating:false publishes the total and leaves circulating unpublished', async () => {
  const f = fakeQuant();
  try {
    const s = await readSupply(QNT_SHIPPED);
    assert.equal(s.total, 14612493.080826178);
    assert.equal(s.circulating, null, 'circulating is unpublished, never a guess');
    assert.equal(s.checked, true);
    // the burn evidence is still reported, so a reader can see what was reconciled
    assert.equal(s.excluded.length, 2);
    assert.match(s.note, /not totalSupply/);
  } finally { f.restore(); }
});

test('quant: the shipped rule publishes total only and explains the unpublished circulating', () => {
  const coins = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url)));
  const rule = coins.quant.supply;
  assert.equal(rule.circulating, false, 'shipped rule leaves circulating unpublished');
  assert.equal(rule.disclosedTotal, 14612493.080826178);
  // the note must name the reason a reader would look for
  assert.match(rule.note, /Circulating supply is not published/);
  assert.match(rule.note, /company/i);
  assert.match(rule.note, /4,648,234/);
});

test('quant: a counter that is no longer the pre-burn artefact fails instead of guessing', async () => {
  // 14.7M — i.e. someone finally decremented the counter. This rule's reasoning no longer holds.
  const f = fakeQuant({ total: '0x' + BigInt(14700000 * 1e18).toString(16) });
  try { await assert.rejects(readSupply(QNT_RULE), /not the pre-burn counter/); }
  finally { f.restore(); }
});

test('quant: if the burned tokens are not at the contract address the read fails', async () => {
  const f = fakeQuant({ atContract: '0x' + BigInt(5000 * 1e18).toString(16) });
  try { await assert.rejects(readSupply(QNT_RULE), /burn not at contract address/); }
  finally { f.restore(); }
});

test('quant: a rule missing the disclosed total fails rather than publishing totalSupply()', async () => {
  const f = fakeQuant();
  try { await assert.rejects(readSupply({ method: 'quant', address: QNT }), /disclosedTotal and burnedAt2018/); }
  finally { f.restore(); }
});


// Fake algod: /v2/ledger/supply returns the given microAlgos total, /v2/accounts/<addr> returns
// ACCOUNTS[addr] microAlgos. algod answers 200 with amount 0 for closed accounts; a missing
// key answers 404, which must now fail the read rather than count 0.
const ALGO_ACCOUNTS = {
  WALLET_A: '5000000000', // 5,000 ALGO
  WALLET_B: '2500000000', // 2,500 ALGO
  CLOSED_WALLET: '0',
};
function fakeAlgod(totalMicro) {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.endsWith('/v2/ledger/supply')) return { ok: true, status: 200, json: async () => ({ 'total-money': String(totalMicro) }) };
    const m = u.match(/\/v2\/accounts\/([^/?]+)$/);
    if (m && m[1] in ALGO_ACCOUNTS) return { ok: true, status: 200, json: async () => ({ amount: ALGO_ACCOUNTS[m[1]] }) };
    if (m) return { ok: false, status: 404, json: async () => ({}) };
    throw new Error('unexpected url ' + u);
  };
}
const ALGO_RULE = { method: 'algorand', api: 'https://algod.test', exclude: [
  { holder: 'WALLET_A', reason: 'Algorand Foundation treasury' },
  { holder: 'WALLET_B', reason: 'Algorand Foundation governance' },
  { holder: 'CLOSED_WALLET', reason: 'Algorand Foundation treasury' },
] };

test('algorand: foundation wallets are read live and subtracted from total supply', async () => {
  fakeAlgod(9821368789728523); // ~9.82B ALGO in microAlgos
  const s = await readSupply(ALGO_RULE);
  assert.ok(Math.abs(s.total - 9821368789.728523) < 0.001);
  assert.ok(Math.abs(s.circulating - (9821368789.728523 - 7500)) < 0.001);
  assert.equal(s.excluded.length, 3);
  assert.equal(s.excluded[2].amount, 0); // closed account answers 200 amount 0
});

test('algorand: a nonsense total fails the read', async () => {
  fakeAlgod(1000);
  await assert.rejects(readSupply(ALGO_RULE), /bad Algorand total supply/);
});

test('algorand: reportedFloor above the live wallet sum is subtracted instead', async () => {
  fakeAlgod(9821368789728523);
  const s = await readSupply({ ...ALGO_RULE, reportedFloor: 8000, reportedFloorSrc: 'https://example.com/report.pdf' });
  assert.ok(Math.abs(s.circulating - (9821368789.728523 - 8000)) < 0.001);
  assert.equal(s.excluded.length, 4);
  assert.equal(s.excluded[3].amount, 500); // 8000 floor - 7500 live
  assert.equal(s.excluded[3].src, 'https://example.com/report.pdf');
});

test('algorand: reportedFloor below the live wallet sum changes nothing', async () => {
  fakeAlgod(9821368789728523);
  const s = await readSupply({ ...ALGO_RULE, reportedFloor: 100 });
  assert.ok(Math.abs(s.circulating - (9821368789.728523 - 7500)) < 0.001);
  assert.equal(s.excluded.length, 3);
});

test('algorand: a malformed account balance fails the read instead of publishing NaN', async () => {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.endsWith('/v2/ledger/supply')) return { ok: true, status: 200, json: async () => ({ 'total-money': '9821368789728523' }) };
    return { ok: true, status: 200, json: async () => ({ address: 'X' }) }; // no amount field
  };
  await assert.rejects(readSupply({ method: 'algorand', api: 'https://algod.test', exclude: [{ holder: 'WALLET_A', reason: 'test' }] }), /bad Algorand balance/);
});

test('aptos: totals read moments apart (a few thousand APT) still agree', async () => {
  fakeAptos({ pub: { current_circulating_supply: 889397967.12, current_total_supply: 1211984907.54 } });
  const s = await readSupply({ method: 'aptos' });
  assert.ok(Math.abs(s.circulating - 889397967.12) < 1e-4);
});

// Real response shapes captured from https://sei-rest.publicnode.com on 2026-11-23 (pacific-1).
const SEI_TEAM_1200M = 'sei1letzrrlgdlrpxj6z279fx85hn5u34mm9nrc9hq4e6wxz5c79je2swt6x4a';
const SEI_TEAM_800M = 'sei1w0fvamykx7v2e6n5x0e2s39m0jz3krejjkpmgc3tmnqdf8p9fy5syg05yv';
const SEI_ECO_1700M = 'sei18qgau4n88tdaxu9y2t2y2px29yvwp50mk4xctp7grwfj7fkcdn8qvs9ry8';
const SEI_FDN_700M = 'sei19se8ass0qvpa2cc60ehnv5dtccznnn5m505cug5tg2gwsjqw5drqm5ptnx';
const SEI_UNLOCK_DIST = 'sei1prndl4f7hg6nsdavrlk6a26ea9a4q4780zjfgp';
const SEI_GENESIS_DIST = 'sei1z3r0ccsssnvuaheuakul58zlu65rngw7njrjcz';
const SEI_LEGACY_1 = 'sei1ga833mj6jc6d2lye6j84stug9h2mpxcxuyw5ak';
const SEI_LEGACY_2 = 'sei15wfxcaz3phxa7hyl9z9wr064nc7zt6y79ywkvw';
const SEI_LEGACY_3 = 'sei1570e0uvdywv0wp79mz235v6zzuu69268xhvk6x';

function fakeSei({
  totalUsei = '9250781935022896',
  pool = [{ denom: 'usei', amount: '513304.109654857840223835' }],
  accounts = {},
  gringotts = {},
  failMatch = null,
} = {}) {
  const futureNs = String(BigInt(Date.now() + 86400_000 * 180) * 1_000_000n);
  const pastNs = String(BigInt(Date.now() - 86400_000 * 30) * 1_000_000n);
  const defaultAccounts = {
    [SEI_TEAM_1200M]: { liquid: '73654', staked: ['659999999926442'], unbonding: [] },
    [SEI_TEAM_800M]: { liquid: '8937209', staked: ['200634927691386'], unbonding: [] },
    [SEI_ECO_1700M]: { liquid: '413850', staked: [], unbonding: [] },
    [SEI_FDN_700M]: { liquid: '0', staked: ['699366'], unbonding: [] },
    [SEI_UNLOCK_DIST]: { liquid: '7575936933546', staked: [], unbonding: [] },
    [SEI_GENESIS_DIST]: { liquid: '42697592918', staked: ['140000000'], unbonding: [] },
    [SEI_LEGACY_1]: { liquid: '100000', staked: [], unbonding: [] },
    [SEI_LEGACY_2]: { liquid: '1000000', staked: [], unbonding: [] },
    [SEI_LEGACY_3]: { liquid: '1000000', staked: [], unbonding: [] },
    ...accounts,
  };
  const defaultGringotts = {
    [SEI_TEAM_1200M]: { vesting_timestamps: [pastNs, futureNs], vesting_amounts: ['96', '660000000000000'] },
    [SEI_TEAM_800M]: { vesting_timestamps: [pastNs, futureNs], vesting_amounts: ['634930628595', '200000006000000'] },
    [SEI_ECO_1700M]: { vesting_timestamps: [pastNs], vesting_amounts: ['413850'] },
    [SEI_FDN_700M]: { vesting_timestamps: [pastNs], vesting_amounts: ['699366'] },
    ...gringotts,
  };

  globalThis.fetch = async url => {
    const u = String(url);
    if (failMatch && u.includes(failMatch)) {
      return { ok: false, status: 500, json: async () => ({ code: 2, message: 'boom' }) };
    }
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (u.endsWith('/cosmos/bank/v1beta1/supply/usei')) {
      return reply({ amount: { denom: 'usei', amount: totalUsei } });
    }
    if (u.endsWith('/cosmos/distribution/v1beta1/community_pool')) {
      return reply({ pool });
    }
    let m = u.match(/\/cosmos\/bank\/v1beta1\/balances\/([^/?]+)\/by_denom\?denom=usei$/);
    if (m) {
      const acc = defaultAccounts[m[1]] || { liquid: '0' };
      return reply({ balance: { denom: 'usei', amount: acc.liquid } });
    }
    m = u.match(/\/cosmos\/staking\/v1beta1\/delegations\/([^/?]+)\?pagination\.limit=200(?:&pagination\.key=([^&]+))?$/);
    if (m) {
      const acc = defaultAccounts[m[1]] || { staked: [] };
      if (acc.stakedPages) {
        const idx = m[2] ? Number(decodeURIComponent(m[2])) : 0;
        const nextKey = idx + 1 < acc.stakedPages.length ? String(idx + 1) : null;
        return reply({
          delegation_responses: acc.stakedPages[idx].map(amount => ({ balance: { denom: 'usei', amount } })),
          pagination: { next_key: nextKey },
        });
      }
      return reply({
        delegation_responses: (acc.staked || []).map(amount => ({ balance: { denom: 'usei', amount } })),
        pagination: { next_key: null },
      });
    }
    m = u.match(/\/cosmos\/staking\/v1beta1\/delegators\/([^/?]+)\/unbonding_delegations\?pagination\.limit=200(?:&pagination\.key=([^&]+))?$/);
    if (m) {
      const acc = defaultAccounts[m[1]] || { unbonding: [] };
      return reply({
        unbonding_responses: (acc.unbonding || []).length ? [{ entries: acc.unbonding.map(balance => ({ balance })) }] : [],
        pagination: { next_key: null },
      });
    }
    m = u.match(/\/cosmwasm\/wasm\/v1\/contract\/([^/?]+)\/smart\/([^/?]+)$/);
    if (m) {
      assert.equal(Buffer.from(m[2], 'base64').toString('utf8'), '{"info":{}}');
      return reply({ data: defaultGringotts[m[1]] });
    }
    throw new Error('unexpected sei url ' + u);
  };
}

test('sei: seed rule reads bank total and active Gringotts/staging exclusions while withholding circulating', async () => {
  const { sei } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  assert.equal(sei.symbol, 'SEI');
  assert.equal(sei.supply.circulating, false, 'shipped rule leaves circulating unpublished rather than overstating');
  assert.match(sei.supply.note, /Circulating supply is not published/);
  assert.match(sei.supply.note, /withdrawn_unlocked/);
  assert.match(sei.supply.note, /genesis\.json/);
  fakeSei();
  const s = await readSupply(sei.supply);
  assert.equal(s.total, 9250781935.022896);
  assert.equal(s.circulating, null, 'circulating is withheld, never overstated');
  assert.equal(s.max, 10000000000);
  assert.equal(s.checked, true);
  assert.equal(s.src, 'https://seistream.app/blockchain');
  // 1 community pool + 2 active Gringotts contracts + 2 staging/genesis wallets + 3 legacy vesting accounts = 8
  assert.equal(s.excluded.length, 8);
  assert.ok(!s.excluded.some(e => e.holder === SEI_ECO_1700M || e.holder === SEI_FDN_700M),
    'fully vested 2025-08-15 dust shells are not listed as active reserve exclusions');
  const team1200 = s.excluded.find(e => e.holder === SEI_TEAM_1200M);
  const team800 = s.excluded.find(e => e.holder === SEI_TEAM_800M);
  assert.ok(Math.abs(team1200.amount - 660000000.000096) < 1e-6, 'staked + liquid SEI in 1.2B Gringotts contract');
  assert.ok(Math.abs(team800.amount - 200634936.628595) < 1e-6, 'staked + liquid SEI in 800M Gringotts contract');
  assert.equal(team1200.src, `https://seistream.app/address/${SEI_TEAM_1200M}`);
});

test('sei: computes circulating = total - excluded when circulating is enabled', async () => {
  const { sei } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  fakeSei();
  const s = await readSupply({ ...sei.supply, circulating: true });
  const out = s.excluded.reduce((sum, e) => sum + e.amount, 0);
  assert.ok(Math.abs(s.total - out - s.circulating) < 1e-6, 'circulating + excluded reconciles to total');
  assert.ok(Math.abs(s.circulating - 8382528221.254115) < 1e-3);
});

test('sei: sums paginated delegations and unbonding delegations on excluded accounts', async () => {
  fakeSei({
    accounts: {
      W1: {
        liquid: '5000000', // 5 SEI
        stakedPages: [['10000000'], ['25000000']], // 10 + 25 SEI across 2 pages
        unbonding: ['60000000'], // 60 SEI unbonding
      },
    },
  });
  const s = await readSupply({
    method: 'sei',
    lcd: 'https://sei.test',
    exclude: [{ holder: 'W1', reason: 'Paginated test wallet' }],
  });
  const w1 = s.excluded.find(e => e.holder === 'W1');
  assert.equal(w1.amount, 100);
});

test('sei: fails closed if a Gringotts contract holds less SEI than its future unvested schedule', async () => {
  fakeSei({
    accounts: {
      // Simulate locked tokens migrated out of CosmWasm before their unlock date.
      [SEI_TEAM_1200M]: { liquid: '0', staked: [], unbonding: [] },
    },
  });
  const { sei } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  await assert.rejects(readSupply(sei.supply), /balance below unvested schedule/);
});

test('sei: fails closed when supply, community pool, bank balance, staking or CosmWasm query errors', async () => {
  const { sei } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  fakeSei({ totalUsei: '1000000' }); // absurdly small total
  await assert.rejects(readSupply(sei.supply), /bad total supply/);

  fakeSei({ pool: [] }); // missing usei entry in community pool
  await assert.rejects(readSupply(sei.supply), /missing usei community pool/);

  for (const failMatch of [
    '/cosmos/bank/v1beta1/supply/usei',
    '/cosmos/distribution/v1beta1/community_pool',
    `/cosmos/bank/v1beta1/balances/${SEI_UNLOCK_DIST}`,
    `/cosmos/staking/v1beta1/delegations/${SEI_TEAM_1200M}`,
    `/cosmos/staking/v1beta1/delegators/${SEI_TEAM_800M}/unbonding_delegations`,
    `/cosmwasm/wasm/v1/contract/${SEI_TEAM_1200M}/smart/`,
  ]) {
    fakeSei({ failMatch });
    await assert.rejects(readSupply(sei.supply));
  }
});

// Fake Ethereum RPC for the FET rule: totalSupply(), decimals() and balanceOf(holder).
// Response shapes captured from eth.drpc.org on 2026-11-23.
function fakeEth({ total = '2714384546671999999999656122', decimals = '0x12', holders = {} } = {}) {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    assert.ok(String(url).includes('eth.'), 'only the Ethereum RPC host is called');
    const req = JSON.parse(opts.body);
    assert.equal(req.method, 'eth_call');
    const data = req.params[0].data;
    let result;
    if (data === '0x18160ddd') result = '0x' + BigInt(total).toString(16).padStart(64, '0');
    else if (data === '0x313ce567') result = '0x' + BigInt(decimals).toString(16).padStart(64, '0');
    else if (data.startsWith('0x70a08231')) {
      const holder = '0x' + data.slice(10 + 24);
      const amt = holders[holder.toLowerCase()];
      result = '0x' + BigInt(amt === undefined ? 0 : amt).toString(16).padStart(64, '0');
    } else throw new Error('unexpected call data ' + data);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
  return () => { globalThis.fetch = prevFetch; };
}

const FET_RULE = {
  method: 'tokens',
  parts: [{ chain: 'eth', address: '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85' }],
  exclude: [
    { chain: 'eth', holder: '0xf58Db6A8c84b454CC8D2980b0d8B6017d0B645Dc', reason: 'ASI Alliance merger treasury' },
    { chain: 'eth', holder: '0x5a8de252ea228deCe61638C336fE43ac8166166a', reason: 'Fetch.ai Admin Multisig (Etherscan label)' },
    { chain: 'eth', holder: '0x8400ac235Ed4F139A3E05670A9A3C724e448129B', reason: 'Fetch.ai Foundation multisig (Etherscan label)' },
  ],
};

test('fetch-ai: the merger treasury and both labeled multisigs are subtracted from the ERC-20 total', async () => {
  const restore = fakeEth({ holders: {
    '0xf58db6a8c84b454cc8d2980b0d8b6017d0b645dc': '277549566000000000000000000',
    '0x5a8de252ea228dece61638c336fe43ac8166166a': '135806682359283411536904890',
    '0x8400ac235ed4f139a3e05670a9a3c724e448129b': '26691468094688173000000000',
  } });
  try {
    const s = await readSupply(FET_RULE);
    assert.ok(Math.abs(s.total - 2714384546.672) < 0.01);
    assert.equal(s.excluded.length, 3);
    const out = s.excluded.reduce((a, e) => a + e.amount, 0);
    assert.ok(Math.abs(out - 440047716.4539716) < 0.01, 'the three wallets hold ~440.0M FET');
    assert.ok(Math.abs(s.circulating - 2274336830.218) < 0.01);
    assert.ok(s.circulating < s.total, 'circulating is never the raw total');
    assert.equal(s.checked, true);
    assert.equal(s.method, 'tokens');
  } finally { restore(); }
});

test('fetch-ai: a wallet read that reverts fails the whole read instead of overstating circulating', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    const data = req.params[0].data;
    if (data.startsWith('0x70a08231')) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted' } }) };
    const result = data === '0x18160ddd' ? '0x' + BigInt('2714384546671999999999656122').toString(16).padStart(64, '0') : '0x' + BigInt(18).toString(16).padStart(64, '0');
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
  try {
    await assert.rejects(readSupply(FET_RULE), /rpc/);
  } finally { globalThis.fetch = prevFetch; }
});

test('fetch-ai: the seed rule attaches to the coin id the site actually serves', async () => {
  const { 'fetch-ai': fet } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  assert.equal(fet.symbol, 'FET');
  assert.equal(fet.supply.parts[0].address, '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85');
  assert.equal(fet.supply.exclude.length, 3);
  assert.ok(fet.supply.exclude.some(e => e.holder.toLowerCase() === '0xf58db6a8c84b454cc8d2980b0d8b6017d0b645dc'));
});

// Celestia: chain total is real (captured 2026-11-23), the published figures are the live API values.
const TIA_RULE = { method: 'celestia', lcd: 'https://lcd.test', api: 'https://supply.test', denom: 'utia' };
function fakeTia({ chainTotalUtia = '1182453406801789', circ = 993689595.687915, apiTotal = 1182213852.846135 } = {}) {
  globalThis.fetch = async url => {
    const u = String(url);
    const reply = val => ({ ok: true, status: 200, json: async () => val });
    if (u === 'https://lcd.test/cosmos/bank/v1beta1/supply/by_denom?denom=utia') {
      return reply({ amount: { denom: 'utia', amount: chainTotalUtia } });
    }
    if (u === 'https://supply.test/v0/circulating-supply') return reply(circ);
    if (u === 'https://supply.test/v0/total-supply') return reply(apiTotal);
    throw new Error('unexpected url: ' + u);
  };
}

test('celestia: total is a chain read and the unvested gap is published with its source', async () => {
  fakeTia();
  const s = await readSupply(TIA_RULE);
  assert.ok(Math.abs(s.total - 1182453406.801789) < 1e-6);
  assert.equal(s.circulating, 993689595.687915);
  assert.equal(s.src, 'https://supply.test');
  assert.equal(s.checked, true);
  assert.equal(s.method, 'celestia');
  assert.equal(s.excluded.length, 1);
  assert.ok(Math.abs(s.excluded[0].amount - (1182453406.801789 - 993689595.687915)) < 1e-6);
  assert.match(s.excluded[0].src, /celestiaorg\/supply/);
  // circulating never exceeds the chain total
  assert.ok(s.circulating < s.total);
});

test('celestia: circulating above the published total fails the read', async () => {
  fakeTia({ circ: 5e9, apiTotal: 1e9 });
  await assert.rejects(readSupply(TIA_RULE), /circ|Invalid Celestia supply/);
});

test('celestia: a non-positive or missing figure fails instead of publishing zero or NaN', async () => {
  for (const bad of [0, -10, 'oops', null]) {
    fakeTia({ circ: bad });
    await assert.rejects(readSupply(TIA_RULE), /Invalid Celestia supply/);
  }
  fakeTia({ apiTotal: 0 });
  await assert.rejects(readSupply(TIA_RULE), /Invalid Celestia supply/);
});

test('celestia: a chain total that no longer matches the published schedule fails the read', async () => {
  // chain moved 5% away from the schedule total: one of the two is stale, so refuse to publish
  fakeTia({ chainTotalUtia: '1241576077141878' });
  await assert.rejects(readSupply(TIA_RULE), /disagrees with chain total/);
});

test('celestia: a broken chain read fails the read rather than falling back to the published number', async () => {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.startsWith('https://lcd.test')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => 993689595.687915 };
  };
  await assert.rejects(readSupply(TIA_RULE), /503|bad Celestia/);
});

// Avalanche (AVAX): real response shapes captured 2026-11-25 from P-Chain, C-Chain and Avalanche Data API.
const AVAX_RULE = { method: 'avax', max: 720000000 };
function fakeAvax({
  pSupplyNavax = '476887509040172100',
  cBurnWeiHex = '0x' + (5164689n * 10n ** 18n).toString(16), // 5,164,689 AVAX
  apiTotal = '470397937.2387678610679452232',
  apiCirc = '470397937.2387678610679452232',
  totalCBurned = '5157997.842849079892831740804',
  totalPBurned = '20447.09153962496915707490173',
  totalXBurned = '45627.31235855819265822198508',
  totalStaked = '222371198.189335',
  genesisUnlock = '360000000',
  totalRewards = '115622009.4855151241225922609',
  lastUpdated = new Date().toISOString(),
  pError = null,
  cError = null,
  apiStatus = 200,
} = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (val, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(val), json: async () => val });
    if (u === 'https://api.avax.network/ext/bc/P') {
      const req = JSON.parse(opts.body);
      assert.equal(req.method, 'platform.getCurrentSupply');
      if (pError) return reply({ jsonrpc: '2.0', id: req.id, error: pError });
      return reply({ jsonrpc: '2.0', id: req.id, result: { supply: pSupplyNavax, height: '25939995' } });
    }
    if (u.includes('/ext/bc/C/rpc')) {
      const req = JSON.parse(opts.body);
      assert.equal(req.method, 'eth_getBalance');
      assert.equal(req.params[0].toLowerCase(), '0x0100000000000000000000000000000000000000');
      if (cError) return reply({ jsonrpc: '2.0', id: req.id, error: cError });
      return reply({ jsonrpc: '2.0', id: req.id, result: cBurnWeiHex });
    }
    if (u === 'https://data-api.avax.network/v1/avax/supply') {
      if (apiStatus !== 200) return reply({}, apiStatus);
      return reply({
        totalSupply: apiTotal,
        circulatingSupply: apiCirc,
        totalPBurned,
        totalCBurned,
        totalXBurned,
        totalStaked,
        genesisUnlock,
        totalRewards,
        lastUpdated,
      });
    }
    throw new Error('unexpected url: ' + u);
  };
}

test('avax: publishes total and circulating with C/P/X burns subtracted and stake kept in circulating', async () => {
  fakeAvax();
  const s = await readSupply(AVAX_RULE);
  assert.ok(Math.abs(s.total - 470397937.23876786) < 1e-4);
  assert.equal(s.circulating, s.total, 'staked AVAX counts as circulating');
  assert.ok(s.circulating <= s.total);
  assert.equal(s.max, 720000000);
  assert.equal(s.checked, true);
  assert.equal(s.method, 'avax');
  assert.equal(s.src, 'https://data-api.avax.network/v1/avax/supply');
  assert.equal(s.excluded.length, 3);
  assert.equal(s.excluded[0].holder, '0x0100000000000000000000000000000000000000');
  assert.equal(s.excluded[0].amount, 5164689);
  assert.match(s.excluded[0].src, /snowtrace\.io\/address\/0x0100000000000000000000000000000000000000/);
  assert.ok(Math.abs(s.excluded[1].amount - 45627.312358558) < 1e-3);
  assert.ok(Math.abs(s.excluded[2].amount - 20447.091539625) < 1e-3);
});

test('avax: circulating above/below total, NaN, stale API, missing fields or RPC/HTTP failures fail closed', async () => {
  fakeAvax({ apiCirc: '480000000', apiTotal: '470397937.23876786' });
  await assert.rejects(readSupply(AVAX_RULE), /exceeds total/);

  fakeAvax({ apiCirc: '450000000', apiTotal: '470397937.23876786' });
  await assert.rejects(readSupply(AVAX_RULE), /below total/);

  fakeAvax({ lastUpdated: new Date(Date.now() - 3 * 24 * 3600e3).toISOString() });
  await assert.rejects(readSupply(AVAX_RULE), /stale/);

  fakeAvax({ totalRewards: '120000000' });
  await assert.rejects(readSupply(AVAX_RULE), /parts do not reconcile/);

  for (const bad of ['oops', '', '0', '-5', null]) {
    fakeAvax({ apiCirc: bad });
    await assert.rejects(readSupply(AVAX_RULE), /avax:/);
  }

  fakeAvax({ pSupplyNavax: 'not-a-number' });
  await assert.rejects(readSupply(AVAX_RULE), /bad P-Chain supply/);

  fakeAvax({ cBurnWeiHex: '0x0' });
  await assert.rejects(readSupply(AVAX_RULE), /empty C-Chain burn/);

  fakeAvax({ pError: { code: -32000, message: 'P-Chain unavailable' } });
  await assert.rejects(readSupply(AVAX_RULE), /platform\.getCurrentSupply/);

  fakeAvax({ cError: { code: -32000, message: 'C-Chain unavailable' } });
  await assert.rejects(readSupply(AVAX_RULE), /avax rpc/);

  fakeAvax({ apiStatus: 503 });
  await assert.rejects(readSupply(AVAX_RULE), /503/);
});

test('avax: divergence between Data API and P-Chain or C-Chain burn fails the read', async () => {
  // Data API total drifts >1% away from P-Chain net supply
  fakeAvax({ pSupplyNavax: '510000000000000000' });
  await assert.rejects(readSupply(AVAX_RULE), /disagrees with chain net supply/);

  // C-Chain on-chain burn balance drifts >0.5% from Data API totalCBurned
  fakeAvax({ cBurnWeiHex: '0x' + (4000000n * 10n ** 18n).toString(16) });
  await assert.rejects(readSupply(AVAX_RULE), /C-Chain burn .* disagrees/);
});

test('avax: the seed rule attaches to the avalanche coin id served by the site', async () => {
  const { avalanche } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  assert.equal(avalanche.symbol, 'AVAX');
  assert.equal(avalanche.name, 'Avalanche');
  assert.equal(avalanche.supply.method, 'avax');
  assert.equal(avalanche.supply.max, 720000000);
});

// TAP, from Trac's TAP Protocol reader. Real responses captured 2026-11-25 (test/fixtures/tap-reader.json).
const TAP_FX = JSON.parse(readFileSync(new URL('./fixtures/tap-reader.json', import.meta.url), 'utf8'));
const TAP_BURN = '1BitcoinEaterAddressDontSendf59kuE';
const TAP_R1 = 'https://reader.tapscope.io', TAP_R2 = 'https://tap-reader.example.org';
const tapLocks = () => structuredClone(TAP_FX['getTickerLocks/tap?offset=0&max=500']);
// readers: { base: { path: body | { status } } } on top of the captured responses.
function fakeTap(readers = { [TAP_R1]: {} }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    const base = Object.keys(readers).find(b => u.startsWith(b + '/'));
    assert.ok(base, 'unexpected url ' + u);
    const p = u.slice(base.length + 1);
    calls.push(base + ' ' + p);
    const body = p in readers[base] ? readers[base][p] : structuredClone(TAP_FX[p]);
    if (body?.status) return { ok: false, status: body.status, json: async () => ({}) };
    assert.ok(body !== undefined, 'no fixture for ' + p);
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}
const tapRule = () => JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8')).tap;

test('TAP: total = minted minus burned from the TAP reader, HTLC trade escrow stays circulating', async () => {
  delete process.env.TMC_TAP_READER2;
  const rule = tapRule();
  assert.deepEqual(rule.supply, { method: 'tap', max: 21000000 });
  const calls = fakeTap();
  const s = await readSupply(rule.supply);
  assert.equal(s.max, 21000000);
  assert.equal(s.total, 21000000 - 5882.11);
  assert.equal(s.circulating, s.total, 'HTLC escrow is not subtracted');
  assert.deepEqual(s.excluded, [{ reason: 'Burned (sent to the TAP burn address)', holder: TAP_BURN, amount: 5882.11, src: `${TAP_R1}/getBalance/${TAP_BURN}/tap` }]);
  assert.equal(s.src, `${TAP_R1}/getDeployment/tap`);
  assert.match(s.note, /21,000,000 TAP minted \(fixed 21,000,000 max, fully minted\) minus 5,882 TAP held by the TAP burn address/);
  assert.match(s.note, /3 TAP marketplace HTLC escrows \(302 TAP\) are trade listings/);
  assert.ok(calls.some(c => c.endsWith('getTickerLocks/tap?offset=0&max=500')));
  assert.equal(s.checked, true);
});

test('TAP: TAP in any other lock kind is subtracted from circulating and listed', async () => {
  const locks = tapLocks();
  locks.result[2] = { ...locks.result[2], kind: 'time', remaining: '250000000000000000000000' }; // 250,000 TAP
  fakeTap({ [TAP_R1]: { 'getTickerLocks/tap?offset=0&max=500': locks } });
  const s = await readSupply({ method: 'tap' });
  assert.equal(s.total, 21000000 - 5882.11);
  assert.equal(s.circulating, s.total - 250000);
  assert.deepEqual(s.excluded[1], { reason: 'Locked in 1 TAP Protocol "time" lock', amount: 250000, src: `${TAP_R1}/getTickerLocksByKind/tap/time` });
  assert.match(s.note, /subtracted from circulating/);
  assert.match(s.note, /2 TAP marketplace HTLC escrows/);
});

test('TAP: reader down, NaN or a wrong deployment fail the read', async () => {
  fakeTap({ [TAP_R1]: { 'getMintTokensLeft/tap': { status: 502 } } });
  await assert.rejects(readSupply({ method: 'tap' }), /502/);
  for (const [p, body, re] of [
    ['getMintTokensLeft/tap', { result: 'NaN' }, /mint tokens left is not an amount/],
    [`getBalance/${TAP_BURN}/tap`, { result: '-5' }, /burned balance is not an amount/],
    ['getDeployment/tap', { result: { ...TAP_FX['getDeployment/tap'].result, dec: 8 } }, /unexpected deployment/],
    ['getDeployment/tap', { result: { ...TAP_FX['getDeployment/tap'].result, tick: 'tapx' } }, /unexpected deployment/],
    ['getDeployment/tap', { result: { ...TAP_FX['getDeployment/tap'].result, max: '21000001000000000000000000' } }, /not 21,000,000 TAP/],
    ['getDeployment/tap', {}, /unexpected deployment/],
  ]) {
    fakeTap({ [TAP_R1]: { [p]: body } });
    await assert.rejects(readSupply({ method: 'tap' }), re, p);
  }
});

test('TAP: burn balance and the burn address token list must agree', async () => {
  fakeTap({ [TAP_R1]: { [`getBalance/${TAP_BURN}/tap`]: { result: '5882110000000000000001' } } });
  await assert.rejects(readSupply({ method: 'tap' }), /burn address balance .* != its token list/);
});

test('TAP: an incomplete or malformed lock list fails the read; circulating can never come out above total', async () => {
  fakeTap({ [TAP_R1]: { 'getTickerLocksLength/tap': { result: 4 } } });
  await assert.rejects(readSupply({ method: 'tap' }), /lock list has 3 of 4/);
  const bad = tapLocks(); bad.result[0].tick = 'trac';
  fakeTap({ [TAP_R1]: { 'getTickerLocks/tap?offset=0&max=500': bad } });
  await assert.rejects(readSupply({ method: 'tap' }), /bad lock entry/);
  const neg = tapLocks(); neg.result[1].remaining = '-1';
  fakeTap({ [TAP_R1]: { 'getTickerLocks/tap?offset=0&max=500': neg } });
  await assert.rejects(readSupply({ method: 'tap' }), /lock remaining is not an amount/);
  const huge = tapLocks(); huge.result[0] = { ...huge.result[0], kind: 'time', remaining: '30000000000000000000000000' };
  fakeTap({ [TAP_R1]: { 'getTickerLocks/tap?offset=0&max=500': huge } });
  await assert.rejects(readSupply({ method: 'tap' }), /outside 0\.\.total/);
});

test('TAP: a second reader (TMC_TAP_READER2) must agree on minted and burned', async () => {
  process.env.TMC_TAP_READER2 = TAP_R2 + '/';
  try {
    fakeTap({ [TAP_R1]: {}, [TAP_R2]: { [`getBalance/${TAP_BURN}/tap`]: { result: '5900000000000000000000' }, [`getAccountTokensBalance/${TAP_BURN}?offset=0&max=100`]: { data: { total: 1, list: [{ ticker: 'tap', overallBalance: '5900000000000000000000', transferableBalance: '' }] } } } });
    const s = await readSupply({ method: 'tap' });
    assert.equal(s.total, 21000000 - 5882.11, 'within tolerance: the first reader is published');
    assert.match(s.note, /Cross-checked against https:\/\/tap-reader\.example\.org\./);
    fakeTap({ [TAP_R1]: {}, [TAP_R2]: { 'getMintTokensLeft/tap': { result: '1000000000000000000' } } });
    await assert.rejects(readSupply({ method: 'tap' }), /minted .* !=/);
    fakeTap({ [TAP_R1]: {}, [TAP_R2]: { [`getBalance/${TAP_BURN}/tap`]: { result: '9000000000000000000000' }, [`getAccountTokensBalance/${TAP_BURN}?offset=0&max=100`]: { data: { total: 1, list: [{ ticker: 'tap', overallBalance: '9000000000000000000000', transferableBalance: '' }] } } } });
    await assert.rejects(readSupply({ method: 'tap' }), /burned .* !=/);
  } finally {
    delete process.env.TMC_TAP_READER2;
  }
});

// TNK, from Trac's Main Settlement Bus API. Real response shapes in test/fixtures/tnk-msb.json.
const TNK_FX = JSON.parse(readFileSync(new URL('./fixtures/tnk-msb.json', import.meta.url), 'utf8'));
const TNK_API_URL = 'https://tracapi.trac.network/v1';
const T = n => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // TNK -> atomic string
const TNK_A = 'trac1mvu5ar22mej7el995tugyynxfthdwh95puklq00rrjrhj9hxq2asz4dx93'; // sender in the real payloads
const TNK_B = 'trac1376drmts39jksahm3plf634tpt8nkpg8ejatqanfdyvflzl0qcwqxx32ps';
const TNK_V = 'trac1hyg3mv57fph35qev4xsa74n7rey2lkg9puq9yzq6aq84r023ldcqyk889z'; // a validator, initialized in the type 3 payload
const TNK_NEW = TNK_FX.payloads[13].payload.tro.to; // first seen in the scanned transfer
function tnkSeed(over = {}) {
  const f = path.join(os.tmpdir(), `tnk-seed-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ confirmedLength: 1368999, initialized: T(1000), initRecords: 10, htlc: [], accounts: [TNK_A, TNK_B, TNK_V], ...over }));
  process.env.TMC_TNK_SEED = f;
}
// world: { length, payloads: [results], balances: {addr: [balance, staked]}, fail: {pathPrefix: status}, htlc: {id: escrow} }
function fakeTnk(world) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    assert.ok(u.startsWith(TNK_API_URL + '/'), 'unexpected url ' + u);
    const p = u.slice(TNK_API_URL.length + 1);
    calls.push(p.split('/')[0]);
    const fail = Object.entries(world.fail || {}).find(([k]) => p.startsWith(k));
    const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
    if (fail) return reply({ error: 'x' }, fail[1]);
    if (p === 'confirmed-length') return reply({ confirmed_length: world.length });
    if (p.startsWith('tx-hashes/')) {
      const [s, e] = p.split('/').slice(1).map(Number);
      return reply({ hashes: world.payloads.map(r => ({ hash: r.hash, confirmed_length: r.at })).filter(h => h.confirmed_length >= s && h.confirmed_length <= e) });
    }
    if (p === 'tx-payloads-bulk') {
      const want = JSON.parse(opts.body).hashes;
      const results = world.payloads.filter(r => want.includes(r.hash)).map(({ hash, payload }) => ({ hash, payload }));
      return reply({ results, missing: world.missing || want.filter(h => !results.some(r => r.hash === h)) });
    }
    if (p.startsWith('account/')) {
      const a = p.slice(8), [b, s] = world.balances[a] || ['0', '0'];
      return reply({ ...TNK_FX.account, address: a, balance: b, stakedBalance: s });
    }
    if (p.startsWith('htlc/')) {
      const e = world.htlc?.[p.slice(5)];
      return e ? reply(e) : reply({ error: 'not found' }, 404);
    }
    throw new Error('unhandled ' + p);
  };
  return calls;
}
const tnkLedger = () => [
  { ...TNK_FX.payloads[13], at: 1369000 },
  { ...TNK_FX.payloads[12], at: 1369003 },
  { ...TNK_FX.payloads[3], at: 1369006 }, // initializes 1 TNK
];
const tnkBalances = () => ({ [TNK_A]: [T(600), '0'], [TNK_B]: [T(390), '0'], [TNK_V]: ['0', T(5)], [TNK_NEW]: [T(5.5), '0'] });

test('TNK: total is every MSB account summed, the ledger scan finds new accounts, circulating = total (Trac method)', async () => {
  tnkReset(); tnkSeed();
  const rule = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'))['trac-network'];
  assert.deepEqual(rule.supply, { method: 'tnk' });
  const w = { length: 1369006, payloads: tnkLedger(), balances: tnkBalances() };
  let calls = fakeTnk(w);
  const s = await readSupply(rule.supply);
  assert.equal(s.total, 1000.5, '600 + 390 + 5 staked + 5.5 at the new address');
  assert.equal(s.circulating, s.total);
  assert.equal(s.max, null);
  assert.equal(s.excluded.length, 1);
  assert.equal(s.excluded[0].amount, 0.5, '1,001 initialized (1,000 + 1 in the scan) minus 1,000.5 held');
  assert.match(s.note, /at ledger length 1,369,006: the sum of all 4 accounts holding TNK \(996 TNK in balances, 5 TNK staked by validators\)/);
  assert.match(s.note, /1,001 TNK were initialized by the TRAC BRC-20 upgrade \(11 balance initializations/);
  assert.match(s.note, /Staked TNK counts as circulating/);
  assert.ok(calls.filter(c => c === 'account').length >= 4 && calls.includes('tx-hashes'));
  // Next read: nothing new on the ledger, so no scan; accounts are read again.
  w.balances[TNK_A] = [T(599.9), '0'];
  calls = fakeTnk(w);
  const s2 = await readSupply(rule.supply);
  assert.ok(!calls.includes('tx-hashes'), 'no rescan');
  assert.equal(Math.round(s2.total * 10) / 10, 1000.4);
});

test('TNK: circulating = total when the rule does not withhold it', async () => {
  tnkReset(); tnkSeed();
  fakeTnk({ length: 1369006, payloads: tnkLedger(), balances: tnkBalances() });
  const s = await readSupply({ method: 'tnk' });
  assert.equal(s.circulating, s.total);
  assert.match(s.note, /Staked TNK counts as circulating/);
});

test('TNK: more TNK than ever initialized, or more than 1% unaccounted for, fails the read', async () => {
  tnkReset(); tnkSeed();
  fakeTnk({ length: 1369006, payloads: tnkLedger(), balances: { ...tnkBalances(), [TNK_A]: [T(700), '0'] } });
  await assert.rejects(readSupply({ method: 'tnk' }), /more than the .* ever initialized/);
  tnkReset();
  fakeTnk({ length: 1369006, payloads: tnkLedger(), balances: { ...tnkBalances(), [TNK_A]: [T(500), '0'] } });
  await assert.rejects(readSupply({ method: 'tnk' }), /more than 1% of the initialized supply/);
});

test('TNK: API errors, NaN and incomplete ledger reads fail, and the next read scans again', async () => {
  tnkReset(); tnkSeed();
  const w = { length: 1369006, payloads: tnkLedger(), balances: tnkBalances(), fail: { [`account/${TNK_B}`]: 503 } };
  fakeTnk(w);
  await assert.rejects(readSupply({ method: 'tnk' }), /503/);
  delete w.fail;
  w.balances[TNK_B] = ['NaN', '0'];
  fakeTnk(w);
  await assert.rejects(readSupply({ method: 'tnk' }), /balance is not an amount/);
  w.balances[TNK_B] = [T(390), '0'];
  w.missing = [TNK_FX.payloads[12].hash];
  fakeTnk(w);
  await assert.rejects(readSupply({ method: 'tnk' }), /incomplete tx payloads/);
  delete w.missing;
  const calls = fakeTnk(w);
  const s = await readSupply({ method: 'tnk' });
  assert.ok(calls.includes('tx-hashes'), 'failed reads did not move the scan position');
  assert.equal(s.total, 1000.5);
  fakeTnk({ ...w, length: 'x' });
  await assert.rejects(readSupply({ method: 'tnk' }), /bad confirmed length/);
});

test('TNK: TNK in an open HTLC escrow counts until it is claimed', async () => {
  tnkReset(); tnkSeed();
  const id = 'ab'.repeat(32);
  // HTLC_LOCK payload, fields as in the MSB proto (htlc_lock_operation.proto) and OpenAPI HtlcEscrow schema.
  const lock = { hash: 'cd'.repeat(32), at: 1369005, payload: { type: 17, address: TNK_B, hlo: { tx: id, ca: TNK_A, ra: TNK_B, am: T(0.4), fa: T(0.05), va: TNK_V } } };
  const w = { length: 1369006, payloads: [...tnkLedger(), lock], balances: { ...tnkBalances(), [TNK_B]: [T(389.55), '0'] },
    htlc: { [id]: { lockId: id, status: 'PENDING', amount: T(0.4), additionalFeeAmount: T(0.05) } } };
  fakeTnk(w);
  const s = await readSupply({ method: 'tnk' });
  assert.equal(s.total, 1000.5, '0.45 TNK left B for the escrow and is still counted');
  assert.match(s.note, /0 TNK in 1 open HTLC escrow/);
  w.htlc[id].status = 'CLAIMED';
  w.balances[TNK_A] = [T(600.4), '0'];
  const calls = fakeTnk(w);
  const s2 = await readSupply({ method: 'tnk' });
  assert.equal(Math.round(s2.total * 100) / 100, 1000.45, 'claimed: 0.4 to A, the 0.05 surcharge to a recipient with no balance in this test');
  assert.ok(calls.includes('htlc'));
});

test('TNK: a seed checkpoint too far behind the ledger asks for a rebuild', async () => {
  tnkReset(); tnkSeed({ confirmedLength: 100 });
  fakeTnk({ length: 1369006, payloads: [], balances: {} });
  await assert.rejects(readSupply({ method: 'tnk' }), /rebuild it with tools\/tnk-accounts\.mjs/);
  delete process.env.TMC_TNK_SEED;
  tnkReset();
});

// ---------- bounty #113 — Blur ----------
// The BLUR ERC-20 is the Etherscan token page
// https://etherscan.io/token/0x5283D291DBCF85356A21bA090E6db59121208b44 (title Blur (BLUR),
// Max Total Supply 3,000,000,000 BLUR) and the verified source
// https://etherscan.io/address/0x5283D291DBCF85356A21bA090E6db59121208b44#code
// (contract BlurToken, INITIAL_SUPPLY = 3_000_000_000, minted once in the constructor, no later mint).
// Blur publishes no addresses for the contracts holding the core-contributor, launch-partner,
// advisor and community-treasury allocations, so circulating cannot be assembled from primary
// sources: the rule publishes the chain-read total, records the only provable non-circulating
// balance (the burn address) and withholds circulating — the same treatment SEI got in merged
// bounty #3. max is that verified INITIAL_SUPPLY. Response shapes captured from eth.drpc.org
// on 2026-11-26; live eth_call verification of totalSupply 3e9 and the burn balance done 2026-11-26.
const BLUR_CONTRACT = '0x5283D291DBCF85356A21bA090E6db59121208b44';
const BLUR_DEAD = '0x000000000000000000000000000000000000dead';
const BLUR_BURN_RAW = '11447778490921122248702'; // balanceOf(0x…dEaD) at the BLUR contract, read 2026-11-26

test('blur: total is the contract totalSupply, the burn is recorded, circulating stays withheld', async () => {
  const { blur } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  const restore = fakeEth({ total: (3000000000n * 10n ** 18n).toString(), holders: { [BLUR_DEAD]: BLUR_BURN_RAW } });
  try {
    const s = await readSupply(blur.supply);
    assert.equal(s.total, 3000000000, 'total is the ERC-20 totalSupply() read from the chain');
    assert.equal(s.circulating, null, 'circulating is withheld, never overstated');
    assert.equal(s.max, 3000000000, 'max is the verified INITIAL_SUPPLY of 3_000_000_000');
    assert.equal(s.method, 'tokens');
    assert.equal(s.checked, true);
    assert.equal(s.parts.length, 1, 'BLUR is a single-chain Ethereum ERC-20: exactly one part');
    assert.equal(s.parts[0].chain, 'eth');
    assert.match(s.parts[0].src, /etherscan\.io\/token\/0x5283d291dbcf85356a21ba090e6db59121208b44/i);
    assert.equal(s.excluded.length, 1, 'only the burn balance is provably non-circulating');
    assert.equal(s.excluded[0].reason, 'Burn address');
    assert.ok(Math.abs(s.excluded[0].amount - 11447.778490921122248702) < 1e-9);
  } finally { restore(); }
});

test('blur: the shipped rule cites resolvable primary sources, names one ERC-20 part and withholds circulating', () => {
  const { blur } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  assert.equal(blur.symbol, 'BLUR');
  assert.equal(blur.supply.method, 'tokens');
  assert.deepEqual(blur.supply.parts, [{ chain: 'eth', address: BLUR_CONTRACT }]);
  assert.equal(blur.supply.circulating, false, 'circulating withheld until locks are provable');
  assert.equal(blur.supply.max, 3000000000, 'max is the verified INITIAL_SUPPLY');
  assert.match(blur.supply.note, /https:\/\/etherscan\.io\/token\/0x5283D291DBCF85356A21bA090E6db59121208b44/);
  assert.match(blur.supply.note, /https:\/\/etherscan\.io\/address\/0x5283D291DBCF85356A21bA090E6db59121208b44#code/);
  assert.match(blur.supply.note, /INITIAL_SUPPLY = 3_000_000_000/);
  assert.doesNotMatch(blur.supply.note, /blur\.foundation/, 'the dead blur.foundation domains are gone');
  assert.doesNotMatch(blur.supply.note, /blur\.io/, 'blur.io does not name the token contract');
});

// Venice (VVV, Base). Real responses captured 2026-11-26 (test/fixtures/venice.json).
const VVV_FX = JSON.parse(readFileSync(new URL('./fixtures/venice.json', import.meta.url), 'utf8'));
function fakeVenice({ stats = VVV_FX.vvv_stats, burn = VVV_FX.vvv_burn_stats, rpc = VVV_FX.rpc, apiStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
    if (u === 'https://api.venice.ai/api/app/vvv/vvv_stats') { calls.push('stats'); return reply(stats, apiStatus); }
    if (u === 'https://api.venice.ai/api/app/vvv/vvv_burn_stats') { calls.push('burn'); return reply(burn); }
    assert.ok(u.includes('base'), 'only the Base RPC and the Venice API are called: ' + u);
    const req = JSON.parse(opts.body);
    assert.equal(req.method, 'eth_call');
    assert.equal(req.params[0].to.toLowerCase(), '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf');
    const data = req.params[0].data;
    let result;
    if (data === '0x18160ddd') result = rpc.totalSupply;
    else if (data === '0x313ce567') result = rpc.decimals;
    else if (data === '0x70a08231' + '0'.repeat(64)) result = rpc.balanceOfZero;
    else if (data.toLowerCase() === '0x70a08231' + '0'.repeat(24) + '000000000000000000000000000000000000dead') result = rpc.balanceOfDead;
    else throw new Error('unexpected call data ' + data);
    calls.push(data.slice(0, 10));
    return reply({ jsonrpc: '2.0', id: req.id, result });
  };
  return calls;
}

test('VVV: total is the Base totalSupply minus the zero-address and dead burns, circulating is Venice\'s figure', async () => {
  const rule = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'))['venice-token'];
  assert.deepEqual(rule, { symbol: 'VVV', name: 'Venice Token', supply: { method: 'venice' } });
  const calls = fakeVenice();
  const s = await readSupply(rule.supply);
  assert.ok(calls.includes('stats') && calls.includes('burn') && calls.includes('0x18160ddd'));
  assert.equal(Math.round(s.total), 81295786, '115,271,004 totalSupply - 33,975,214 at 0x0 - 3.85 at 0xdEaD');
  assert.equal(Math.round(s.circulating), 49537806);
  assert.equal(s.max, null);
  assert.deepEqual(s.excluded.map(e => e.holder ?? 'venice'), ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD', 'venice']);
  assert.equal(Math.round(s.excluded[2].amount), Math.round(s.total - s.circulating));
  assert.equal(s.excluded[2].src, 'https://api.venice.ai/api/app/vvv/vvv_stats');
  assert.equal(s.src, 'https://basescan.org/token/0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf');
  assert.match(s.note, /does not subtract the 32,549,786 VVV staked as a whole/);
  assert.match(s.note, /8,507,286 VVV locked to mint DIEM/);
  assert.equal(s.checked, true);
});

test('VVV: Venice figures that disagree with the chain, or circulating outside 0..total, fail the read', async () => {
  fakeVenice({ stats: { ...VVV_FX.vvv_stats, totalSupplyCryptoBaseUnit: '90000000000000000000000000' } });
  await assert.rejects(readSupply({ method: 'venice' }), /disagrees with chain total/);
  fakeVenice({ burn: { totalBurnedCryptoBaseUnit: '30000000000000000000000000' } });
  await assert.rejects(readSupply({ method: 'venice' }), /burned .* disagrees with the chain/);
  fakeVenice({ stats: { ...VVV_FX.vvv_stats, circulatingSupplyCryptoBaseUnit: '82000000000000000000000000' } });
  await assert.rejects(readSupply({ method: 'venice' }), /circulating .* not inside/);
  fakeVenice({ stats: { ...VVV_FX.vvv_stats, totalStakedCryptoBaseUnit: '90000000000000000000000000' } });
  await assert.rejects(readSupply({ method: 'venice' }), /staked .* not below total/);
});

test('VVV: API errors and NaN fail the read', async () => {
  fakeVenice({ apiStatus: 503 });
  await assert.rejects(readSupply({ method: 'venice' }), /503/);
  for (const [field, value] of [['circulatingSupplyCryptoBaseUnit', 'NaN'], ['totalSupplyCryptoBaseUnit', undefined], ['totalStakedCryptoBaseUnit', '-1'], ['totalLockedCryptoBaseUnit', 12]]) {
    fakeVenice({ stats: { ...VVV_FX.vvv_stats, [field]: value } });
    await assert.rejects(readSupply({ method: 'venice' }), /is not an amount/, field);
  }
  fakeVenice({ burn: {} });
  await assert.rejects(readSupply({ method: 'venice' }), /totalBurned is not an amount/);
});

// Worldcoin (WLD): Ethereum total, Optimism checked against the OP bridge. eth_call results captured 2026-11-26.
const WLD_RPC = {
  eth: {
    '0x18160ddd': '0x0000000000000000000000000000000000000000204fce5e3e25026110000000', // 10,000,000,000
    '0x313ce567': '0x0000000000000000000000000000000000000000000000000000000000000012',
    dead: '0x00000000000000000000000000000000000000000000000005c8ed583541926f', // 0.417
    '99c9fc46f92e8a1c0dec1b1747d010903e884be1': '0x000000000000000000000000000000000000000001a3a4538426c643cd02be2f', // OP L1 bridge 507,315,927
    '470458c91978d2d929704489ad730dc3e3001113': '0x000000000000000000000000000000000000000002a5344500bca24488ce8bb0', // World Chain L1 bridge
    aee0360b73b5d01dad134f234d3a93adc1680e57: '0x' + (1750000001n * 10n ** 18n).toString(16).padStart(64, '0'), // unlock contract 2
    '59a0f98345f54bab245a043488ece7fcecd7b596': '0x' + (1183211975n * 10n ** 18n).toString(16).padStart(64, '0'), // World Assets cold
  },
  optimism: {
    '0x18160ddd': '0x000000000000000000000000000000000000000001a1dda1420fbdb34263a590', // 505,168,684
    '0x313ce567': '0x0000000000000000000000000000000000000000000000000000000000000012',
    '0xd6c0b2c4': '0x000000000000000000000000163f8c2467924be0ae7b5347228cabf260318753', // remoteToken()
    '0xe78cea92': '0x0000000000000000000000004200000000000000000000000000000000000010', // bridge()
  },
};
function fakeWld(over = {}) {
  const rpc = { eth: { ...WLD_RPC.eth, ...over.eth }, optimism: { ...WLD_RPC.optimism, ...over.optimism } };
  globalThis.fetch = async (url, opts = {}) => {
    const chain = String(url).includes('optimism') ? 'optimism' : 'eth';
    const req = JSON.parse(opts.body);
    assert.equal(req.method, 'eth_call');
    const data = req.params[0].data.toLowerCase();
    let result = data.startsWith('0x70a08231') ? rpc[chain][data.slice(-40) === '000000000000000000000000000000000000dead' ? 'dead' : data.slice(-40)] ?? '0x' + '0'.repeat(64) : rpc[chain][data];
    if (result === undefined) throw new Error(`unexpected ${chain} call ${data}`);
    if (result instanceof Error) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
}

test('WLD: total from Ethereum, Optimism checked against the OP bridge, circulating withheld', async () => {
  const rule = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8')).worldcoin;
  assert.deepEqual(rule, { symbol: 'WLD', name: 'Worldcoin', supply: { method: 'worldcoin' } });
  fakeWld();
  const s = await readSupply(rule.supply);
  assert.ok(Math.abs(s.total - (1e10 - 0.41738)) < 0.01);
  assert.equal(s.circulating, null);
  assert.match(s.note, /less 0\.42 at the burn address\. The 505,168,684 WLD on Optimism/);
  assert.deepEqual(s.excluded.map(e => e.holder), ['0x000000000000000000000000000000000000dEaD', '0xaEE0360b73B5D01dad134f234d3a93adc1680e57', '0x59a0f98345f54bAB245A043488ECE7FCecD7B596'], 'zero-balance World wallets are not listed');
  assert.equal(s.excluded[1].src, 'https://whitepaper.world.org/designing-for-scale/2025-08-04');
  assert.match(s.note, /The listed World wallets hold 2,933,211,976 WLD on Ethereum/);
  assert.match(s.note, /backed by 507,315,927 WLD locked in OP Mainnet's L1StandardBridge/);
  assert.match(s.note, /Circulating is withheld/);
});

test('WLD: a non-standard Optimism token, more WLD on Optimism than locked, or a failed read fails', async () => {
  fakeWld({ optimism: { '0xd6c0b2c4': '0x000000000000000000000000' + '11'.repeat(20) } });
  await assert.rejects(readSupply({ method: 'worldcoin' }), /not the standard-bridged Ethereum WLD/);
  fakeWld({ optimism: { '0xe78cea92': '0x000000000000000000000000' + '22'.repeat(20) } });
  await assert.rejects(readSupply({ method: 'worldcoin' }), /not the standard-bridged Ethereum WLD/);
  fakeWld({ optimism: { '0x18160ddd': '0x' + (600000000n * 10n ** 18n).toString(16).padStart(64, '0') } });
  await assert.rejects(readSupply({ method: 'worldcoin' }), /above the .* locked in the OP bridge/);
  fakeWld({ eth: { '0x18160ddd': new Error('down') } });
  await assert.rejects(readSupply({ method: 'worldcoin' }), /503/);
});

// Pump.fun: the official mint is fixed, but team/investor/ecosystem/foundation wallets are not
// published, so the rule publishes the live chain total and withholds circulating.
const PUMP_MINT = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';

test('pump-fun: seed rule reads the Solana mint total and withholds circulating', async () => {
  const coins = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  const pump = coins['pump-fun'];
  assert.equal(pump.symbol, 'PUMP');
  assert.equal(pump.name, 'Pump.fun');
  assert.equal(pump.supply.method, 'tokens');
  assert.equal(pump.supply.circulating, false);
  assert.equal(pump.supply.max, 1000000000000);
  assert.equal(pump.supply.parts.length, 1);
  assert.equal(pump.supply.parts[0].chain, 'sol');
  assert.equal(pump.supply.parts[0].address, PUMP_MINT);

  const restore = fakeSol({ total: '820375385290371930', holders: {} });
  try {
    const s = await readSupply(pump.supply);
    assert.equal(s.circulating, null, 'circulating is withheld, never overstated');
    assert.ok(Math.abs(s.total - 820375385290.37193) < 0.01);
    assert.equal(s.max, 1000000000000);
    assert.equal(s.parts.length, 1);
    assert.equal(s.parts[0].src, `https://solscan.io/token/${PUMP_MINT}`);
    assert.equal(s.excluded.length, 0, 'no guessed lock wallets are listed');
    assert.match(s.note, /Circulating is withheld/);
    assert.equal(s.checked, true);
    assert.equal(s.method, 'tokens');
  } finally { restore(); }
});

test('pump-fun: Solana RPC errors and NaN fail the read instead of guessing a supply', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'rpc fail' }) });
  await assert.rejects(readSupply({
    method: 'tokens',
    parts: [{ chain: 'sol', address: PUMP_MINT }],
    circulating: false,
  }), /500/);
  const restore = fakeSol({ total: 'NaN' });
  try {
    await assert.rejects(readSupply({
      method: 'tokens',
      parts: [{ chain: 'sol', address: PUMP_MINT }],
      circulating: false,
    }));
  } finally { restore(); }
});

// Plasma (XPL): mainnet RPC + BSC OFT responses captured 2026-11-26.
const PLASMA_MOCK = {
  genesis: {
    hash: '0x0d0ccca452bdb244100115e37de64ca640a255585d5a94df5610052a6dada558',
    stateRoot: '0x51a81695b0907da0433793778e86d0cb7429fe171e09e0ff2ee21743eb298355',
  },
  head: { number: '0x24ebe7c', withdrawals: [] },
  balances: {
    '0x0000000000000000000000000000000000000000': '0x' + 22537648049000000000000n.toString(16),
    '0x000000000000000000000000000000000000dead': '0x' + 8869016000000000000n.toString(16),
    '0x6c50b8ca8eeaa1c75dee5b5ea79772acabc92f48': '0x0',
    '0x405fbc9004d857903bfd6b3357792d71a50726b0': '0x' + 262112458642873000000000000n.toString(16),
    '0x000000000000000000000000000000000a11b004': '0x' + 10020606550679000000000000n.toString(16),
    '0x000000000000000000000000000000000a11b005': '0x' + 1206708416786000000000000n.toString(16),
  },
  bscTotalSupply: '0x' + (261286719091448000000000000n).toString(16).padStart(64, '0'),
  bscDecimals: '0x' + (18).toString(16).padStart(64, '0'),
};

function fakePlasma(over = {}) {
  const genesis = { ...PLASMA_MOCK.genesis, ...over.genesis };
  const head = { ...PLASMA_MOCK.head, ...over.head };
  const balances = { ...PLASMA_MOCK.balances, ...over.balances };
  const bscTotal = over.bscTotalSupply ?? PLASMA_MOCK.bscTotalSupply;
  globalThis.fetch = async (url, opts = {}) => {
    if (over.httpStatus && over.httpStatus !== 200) {
      return { ok: false, status: over.httpStatus, json: async () => ({}) };
    }
    const u = String(url);
    const req = JSON.parse(opts.body);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    if (u.includes('bsc')) {
      assert.equal(req.method, 'eth_call');
      const d = req.params[0].data;
      if (d === '0x18160ddd') return reply(bscTotal);
      if (d === '0x313ce567') return reply(PLASMA_MOCK.bscDecimals);
      throw new Error('unexpected BSC call ' + d);
    }
    assert.ok(u.includes('plasma'), 'unexpected RPC URL ' + u);
    if (req.method === 'eth_getBlockByNumber') {
      return reply(req.params[0] === '0x0' ? genesis : head);
    }
    if (req.method === 'eth_getBalance') {
      const addr = req.params[0].toLowerCase();
      const val = addr in balances ? balances[addr] : '0x0';
      if (val instanceof Error) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { message: val.message } }) };
      return reply(val);
    }
    throw new Error('unexpected Plasma RPC method ' + req.method);
  };
}

test('XPL: seed rule verifies Plasma genesis, subtracts zero/dead burns, checks BSC OFT backing, and withholds circulating', async () => {
  const rule = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8')).plasma;
  assert.deepEqual(rule, { symbol: 'XPL', name: 'Plasma', supply: { method: 'plasma' } });
  fakePlasma();
  const s = await readSupply(rule.supply);
  assert.ok(Math.abs(s.total - (10_000_000_000 - 22537.648049 - 8.869016)) < 1e-5);
  assert.equal(s.circulating, null, 'circulating is withheld when vesting custody wallets are unpublished');
  assert.equal(s.max, null);
  assert.equal(s.checked, true);
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].chain, 'plasma');
  assert.deepEqual(
    s.excluded.map(e => e.holder),
    [
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000a11b004',
      '0x000000000000000000000000000000000a11b005',
    ],
    'emptied genesis Safes 0a11b001..3 are omitted while non-zero burns and Safes are listed',
  );
  assert.match(s.note, /less 22,546\.52 XPL burned at the zero and dead addresses/);
  assert.match(s.note, /261,286,719 bridged XPL on BNB Smart Chain .* backed by 262,112,459 XPL locked/);
  assert.match(s.note, /Circulating is withheld/);

  // Optional circulating:true mode subtracts non-burn Safes + configured exclude list cleanly.
  const customHolder = '0xcf54cb695a70f466fd5a271f85a7e268c2c97b25';
  fakePlasma({ balances: { [customHolder]: '0x' + (1000000000n * 10n ** 18n).toString(16) } });
  const s2 = await readSupply({ method: 'plasma', circulating: true, exclude: [{ holder: customHolder, reason: 'Custody lock' }] });
  assert.ok(Math.abs(s2.circulating - (s.total - 10020606.550679 - 1206708.416786 - 1_000_000_000)) < 1e-4);
});

test('XPL: wrong genesis, active withdrawals, staked validator-set, unbacked BSC OFT, or bad RPC data fail closed', async () => {
  fakePlasma({ genesis: { stateRoot: '0x' + '11'.repeat(32) } });
  await assert.rejects(readSupply({ method: 'plasma' }), /unexpected genesis/);

  fakePlasma({ head: { withdrawals: [{ index: '0x0', amount: '0x1' }] } });
  await assert.rejects(readSupply({ method: 'plasma' }), /active consensus withdrawals/);

  fakePlasma({ balances: { '0x6c50b8ca8eeaa1c75dee5b5ea79772acabc92f48': '0xde0b6b3a7640000' } });
  await assert.rejects(readSupply({ method: 'plasma' }), /validator-set contract holds/);

  fakePlasma({ bscTotalSupply: '0x' + (300000000n * 10n ** 18n).toString(16).padStart(64, '0') });
  await assert.rejects(readSupply({ method: 'plasma' }), /above the .* locked in Plasma OFT adapter/);

  fakePlasma({ balances: { '0x0000000000000000000000000000000000000000': 'NaN' } });
  await assert.rejects(readSupply({ method: 'plasma' }), /bad balance/);

  fakePlasma({ balances: { '0x000000000000000000000000000000000a11b004': new Error('rpc reverted') } });
  await assert.rejects(readSupply({ method: 'plasma' }), /plasma rpc/);

  fakePlasma({ httpStatus: 503 });
  await assert.rejects(readSupply({ method: 'plasma' }), /503/);
});

// Aster (ASTER): BEP-20 on BNB Chain. Captured 2026-11-26 from bsc-dataseed.bnbchain.org.
const ASTER = '0x000ae314e2a2172a039b26378814c252734f556a';
const ASTER_RPC = {
  totalSupply: '0x000000000000000000000000000000000000000019d971e4fe8401e740000000', // 8,000,000,000
  decimals: '0x0000000000000000000000000000000000000000000000000000000000000012',
  balanceOfDead: '0x000000000000000000000000000000000000000000b2d13130c732b3d3e8e158', // 216,176,677.891617142837141848
  balanceOfZero: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

function fakeAster({ rpc = ASTER_RPC, rpcError, httpStatus } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (httpStatus) return { ok: false, status: httpStatus, json: async () => ({}) };
    const u = String(url);
    assert.ok(u.includes('bsc'), 'only the BSC RPC is called: ' + u);
    const req = JSON.parse(opts.body);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    if (rpcError) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { message: rpcError } }) };
    assert.equal(req.method, 'eth_call');
    assert.equal(req.params[0].to.toLowerCase(), ASTER);
    const data = String(req.params[0].data).toLowerCase();
    let result;
    if (data === '0x18160ddd') result = rpc.totalSupply;
    else if (data === '0x313ce567') result = rpc.decimals;
    else if (data === '0x70a08231' + '0'.repeat(24) + '000000000000000000000000000000000000dead') result = rpc.balanceOfDead;
    else if (data === '0x70a08231' + '0'.repeat(64)) result = rpc.balanceOfZero;
    else throw new Error('unexpected call data ' + data);
    calls.push(data.slice(0, 10));
    return reply(result);
  };
  return calls;
}

test('aster: seed rule publishes totalSupply minus the dead-address burn and withholds circulating', async () => {
  const prev = globalThis.fetch;
  try {
    const { aster } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    assert.equal(aster.symbol, 'ASTER');
    assert.equal(aster.supply.method, 'aster');
    assert.equal(aster.supply.max, 8000000000);
    const calls = fakeAster();
    const s = await readSupply(aster.supply);
    assert.ok(calls.includes('0x18160ddd'));
    assert.equal(Math.round(s.total), 7783823322, '8,000,000,000 totalSupply - 216,176,677.89 at 0xdEaD');
    assert.equal(s.circulating, null, 'circulating is withheld: treasury and team locks have no published addresses');
    assert.equal(s.max, 8000000000);
    assert.equal(s.excluded.length, 1);
    assert.equal(s.excluded[0].holder.toLowerCase(), '0x000000000000000000000000000000000000dead');
    assert.equal(Math.round(s.excluded[0].amount), 216176678);
    assert.equal(s.src, 'https://bscscan.com/token/0x000Ae314E2A2172a039B26378814C252734f556A');
    assert.match(s.note, /docs\.asterdex\.com\/usdaster-token\/tokenomics\.md/);
    assert.match(s.note, /Treasury \(560M, 7%\) is fully locked/);
    assert.match(s.note, /Team \(400M, 5%\) stays locked until 17 Sep 2027/);
    assert.match(s.note, /Ecosystem vesting was replaced by staking emissions after January 2026/);
    assert.doesNotMatch(s.note, /unvested ecosystem allocations/);
    assert.equal(s.checked, true);
    assert.equal(s.method, 'aster');
  } finally { globalThis.fetch = prev; }
});

test('aster: missing burn, supply above max, or a broken RPC fail closed', async () => {
  const prev = globalThis.fetch;
  try {
    fakeAster({ rpc: { ...ASTER_RPC, balanceOfDead: '0x0' } });
    await assert.rejects(readSupply({ method: 'aster', max: 8000000000 }), /no dead-address burn/);
    fakeAster({ rpc: { ...ASTER_RPC, totalSupply: '0x' + (9000000000n * 10n ** 18n).toString(16) } });
    await assert.rejects(readSupply({ method: 'aster', max: 8000000000 }), /above max/);
    fakeAster({ rpcError: 'rate limited' });
    await assert.rejects(readSupply({ method: 'aster' }), /rate limited/);
    fakeAster({ httpStatus: 403 });
    await assert.rejects(readSupply({ method: 'aster' }), /403/);
  } finally { globalThis.fetch = prev; }
});

// ---------- MANTRA (mantra-1) ----------
// Response shapes captured from https://api.mantrachain.io on 2026-11-26.
const MANTRA_BURN = 'mantra1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcg2my8';
const MANTRA_UPGRADE = 'mantra14g459vwkat3r7xjerz4fkvcpyxdkuyezm0s2p8';
const MANTRA_CONTRIB = 'mantra1yejpacug78zuqkzwwuc94c0a2al4mz4yfqquam';
const MANTRA_PRESEED = 'mantra1kklp9gd2rk8zg8tuahnqzw28tjdvqwe5uskazy';
const MANTRA_SEED = 'mantra133pw28metkmxtnt4jye68rcn2v88utd79tvxgk';
const MANTRA_AIRDROP = 'mantra1c3fsupagvw40ex03hp7e4ezcdq9st4lcvy0r02';
const MANTRA_ECO = 'mantra1w0q87xm6jfjgn3u3vn4d3fj34g5tcz6v0xwnux';

function fakeMantra({
  totalAmantra = '8416790992466420335898115879',
  supplyDenom = 'amantra',
  mintParams = { mint_denom: 'amantra', max_supply: '10000000000000000000000000000' },
  pool = [{ denom: 'amantra', amount: '18034679219351389431044726.187556642725905656' }],
  accounts = {},
  failMatch = null,
} = {}) {
  const defaultAccounts = {
    [MANTRA_BURN]: { liquid: '0', staked: [], unbonding: [] },
    [MANTRA_UPGRADE]: {
      liquid: '98000577549999999998',
      staked: ['553577409871812598366611134'],
      unbonding: [],
    },
    [MANTRA_CONTRIB]: {
      liquid: '40000000000000000',
      staked: ['348650818603940254642191274'],
      unbonding: [],
    },
    [MANTRA_PRESEED]: {
      liquid: '688161253147003397438343',
      staked: ['87238594510000000000000000', '83645365290260000000000000'],
      unbonding: [],
    },
    [MANTRA_SEED]: {
      liquid: '351136288025070494314446',
      staked: ['5280908133332000000000000', '4879333950000000000000000', '3265745000000000000000000'],
      unbonding: [],
    },
    [MANTRA_AIRDROP]: { liquid: '4216205825162200000000000', staked: [], unbonding: [] },
    [MANTRA_ECO]: { liquid: '88899822220000000000000', staked: ['352000000000000000000000'], unbonding: [] },
    ...accounts,
  };

  globalThis.fetch = async url => {
    const u = String(url);
    if (failMatch && u.includes(failMatch)) {
      return { ok: false, status: 502, json: async () => ({ code: 2, message: 'lcd down' }) };
    }
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    if (u.endsWith('/cosmos/bank/v1beta1/supply/by_denom?denom=amantra')) {
      return reply({ amount: { denom: supplyDenom, amount: totalAmantra } });
    }
    if (u.endsWith('/cosmos/mint/v1beta1/params')) {
      return reply({ params: mintParams });
    }
    if (u.endsWith('/cosmos/distribution/v1beta1/community_pool')) {
      return reply({ pool });
    }
    let m = u.match(/\/cosmos\/bank\/v1beta1\/balances\/([^/?]+)\/by_denom\?denom=amantra$/);
    if (m) {
      const acc = defaultAccounts[m[1]] || { liquid: '0' };
      return reply({ balance: { denom: 'amantra', amount: acc.liquid } });
    }
    m = u.match(/\/cosmos\/staking\/v1beta1\/delegations\/([^/?]+)\?pagination\.limit=200(?:&pagination\.key=([^&]+))?$/);
    if (m) {
      const acc = defaultAccounts[m[1]] || { staked: [] };
      if (acc.stakedPages) {
        const idx = m[2] ? Number(decodeURIComponent(m[2])) : 0;
        const nextKey = idx + 1 < acc.stakedPages.length ? String(idx + 1) : null;
        return reply({
          delegation_responses: acc.stakedPages[idx].map(amount => ({ balance: { denom: 'amantra', amount } })),
          pagination: { next_key: nextKey },
        });
      }
      return reply({
        delegation_responses: (acc.staked || []).map(amount => ({ balance: { denom: 'amantra', amount } })),
        pagination: { next_key: null },
      });
    }
    m = u.match(/\/cosmos\/staking\/v1beta1\/delegators\/([^/?]+)\/unbonding_delegations\?pagination\.limit=200(?:&pagination\.key=([^&]+))?$/);
    if (m) {
      const acc = defaultAccounts[m[1]] || { unbonding: [] };
      return reply({
        unbonding_responses: (acc.unbonding || []).length ? [{ entries: acc.unbonding.map(balance => ({ balance })) }] : [],
        pagination: { next_key: null },
      });
    }
    throw new Error('unexpected mantra url ' + u);
  };
}

test('mantra: seed rule reads bank total, mint max_supply, community pool and genesis/custodian reserves while withholding circulating', async () => {
  const prev = globalThis.fetch;
  try {
    const { mantra } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    assert.equal(mantra.symbol, 'MANTRA');
    assert.equal(mantra.name, 'MANTRA');
    assert.equal(mantra.supply.circulating, false, 'shipped rule withholds circulating rather than overstating');
    assert.match(mantra.supply.note, /genesis\.json/);
    assert.match(mantra.supply.note, /10 Apr 2027/);
    assert.doesNotMatch(mantra.supply.note, /~\d/, 'no stale approximate live figures in note');
    fakeMantra();
    const s = await readSupply(mantra.supply);
    assert.ok(Math.abs(s.total - 8416790992.46642) < 1e-4);
    assert.equal(s.circulating, null, 'circulating is withheld, never overstated');
    assert.equal(s.max, 10000000000);
    assert.equal(s.checked, true);
    assert.equal(s.src, 'https://www.mintscan.io/mantra');
    // 1 community pool + 6 genesis/first-hop reserve accounts (burn wallet is 0 so omitted) = 7
    assert.equal(s.excluded.length, 7);
    const contrib = s.excluded.find(e => e.holder === MANTRA_CONTRIB);
    const upgrade = s.excluded.find(e => e.holder === MANTRA_UPGRADE);
    assert.ok(Math.abs(contrib.amount - 348650818.64394) < 1e-3, 'staked + liquid MANTRA in Core Contributors custodian');
    assert.ok(Math.abs(upgrade.amount - 553577507.87239) < 1e-3, 'staked + liquid MANTRA in OM Upgrade Incentives genesis reserve');
    assert.equal(contrib.src, `https://www.mintscan.io/mantra/address/${MANTRA_CONTRIB}`);
  } finally { globalThis.fetch = prev; }
});

test('mantra: subtracts any burned amantra at the zero-address burn wallet from total without double-counting in circulating', async () => {
  const prev = globalThis.fetch;
  try {
    const { mantra } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    fakeMantra({
      accounts: {
        [MANTRA_BURN]: { liquid: (100_000_000n * 10n ** 18n).toString(), staked: [], unbonding: [] },
      },
    });
    const s = await readSupply({ ...mantra.supply, circulating: true });
    assert.ok(Math.abs(s.total - 8316790992.46642) < 1e-4, '100M burned amantra subtracted from bank total');
    const burnEntry = s.excluded.find(e => e.holder === MANTRA_BURN);
    assert.equal(burnEntry.amount, 100000000);
    const nonBurnOut = s.excluded.filter(e => e.holder !== MANTRA_BURN).reduce((sum, e) => sum + e.amount, 0);
    assert.ok(Math.abs(s.total - nonBurnOut - s.circulating) < 1e-4, 'burn is not subtracted a second time from circulating');
  } finally { globalThis.fetch = prev; }
});

test('mantra: sums paginated delegations and unbonding delegations on excluded accounts', async () => {
  const prev = globalThis.fetch;
  try {
    const e18 = n => (BigInt(n) * 10n ** 18n).toString();
    fakeMantra({
      accounts: {
        M1: {
          liquid: e18(5),
          stakedPages: [[e18(10)], [e18(25)]],
          unbonding: [e18(60)],
        },
      },
    });
    const s = await readSupply({
      method: 'mantra',
      lcd: 'https://mantra.test',
      exclude: [{ holder: 'M1', reason: 'Paginated test wallet' }],
    });
    assert.equal(s.excluded.find(e => e.holder === 'M1').amount, 100);
  } finally { globalThis.fetch = prev; }
});

test('mantra: fails closed on HTTP errors, NaN/malformed strings, mint param mismatch, or out-of-range supply', async () => {
  const prev = globalThis.fetch;
  try {
    const { mantra } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    fakeMantra({ totalAmantra: 'NaN' });
    await assert.rejects(readSupply(mantra.supply), /bad bank supply/);

    fakeMantra({ totalAmantra: (1000n * 10n ** 18n).toString() });
    await assert.rejects(readSupply(mantra.supply), /bad total supply/);

    fakeMantra({ mintParams: { mint_denom: 'amantra', max_supply: (9_000_000_000n * 10n ** 18n).toString() } });
    await assert.rejects(readSupply(mantra.supply), /mint max_supply/);

    fakeMantra({ pool: [] });
    await assert.rejects(readSupply(mantra.supply), /missing amantra community pool/);

    fakeMantra({ pool: [{ denom: 'amantra', amount: 'NaN' }] });
    await assert.rejects(readSupply(mantra.supply), /bad decimal amount/);

    for (const failMatch of [
      '/cosmos/bank/v1beta1/supply/by_denom?denom=amantra',
      '/cosmos/mint/v1beta1/params',
      '/cosmos/distribution/v1beta1/community_pool',
      `/cosmos/bank/v1beta1/balances/${MANTRA_BURN}`,
      `/cosmos/staking/v1beta1/delegations/${MANTRA_CONTRIB}`,
      `/cosmos/staking/v1beta1/delegators/${MANTRA_SEED}/unbonding_delegations`,
    ]) {
      fakeMantra({ failMatch });
      await assert.rejects(readSupply(mantra.supply));
    }
  } finally { globalThis.fetch = prev; }
});

// LayerZero (ZRO): 7 public EVM OFT deployments + Ethereum peers(33002) check + labeled/Foundation exclusions.
// Real eth_call responses captured 2026-11-26 across all 7 EVM RPCs.
const ZRO_ADDR = '0x6985884c4392d348587b19cb9eaaf157f13271cd';
const ZRO_DEC_HEX = '0x0000000000000000000000000000000000000000000000000000000000000012';
const ZRO_ZERO_HEX = '0x' + '0'.repeat(64);
const ZRO_CAPTURED = {
  eth: {
    totalSupply: '0x000000000000000000000000000000000000000002b979293f07721c867b7000', // 843,193,463.474055
    dead: '0x00000000000000000000000000000000000000000000000004584187f5e86f4b', // 0.3130722263042906
    self: '0x000000000000000000000000000000000000000000000079053c087cc0377950', // 2,232.433218719542
    holders: {
      '0x1f903473376fbe98cc763f1bc459c8fdb6ac3909': '0x00000000000000000000000000000000000000000017fcfca986ca9a5a7c0000', // 28,999,991
      '0x6ac55e733dff03a54251670df0667774e8f7d28f': '0x00000000000000000000000000000000000000000002405c047e9cf1da0301dc', // 2,721,780.518456483
    },
    peer33002: '0x0000000000000000000000001ced7d571059a30db0fc9adc40346d2a1ce55b31',
  },
  arbitrum: {
    totalSupply: '0x00000000000000000000000000000000000000000015cd4b1e454da8c8960000', // 26,356,913.027936
    dead: '0x0000000000000000000000000000000000000000000000000000005017ff6c18', // 3.44e-7
    self: '0x0000000000000000000000000000000000000000000003e3c1805a2fff8850bd', // 18,368.4536
  },
  bsc: {
    totalSupply: '0x00000000000000000000000000000000000000000006723922971d1279348000', // 7,792,958.653640
    dead: '0x0000000000000000000000000000000000000000000000000008e2bf5e98cb03', // 0.00250111
    self: '0x000000000000000000000000000000000000000000000059c7f7e26130941000', // 1,656.1695
  },
  base: {
    totalSupply: '0x00000000000000000000000000000000000000000004ca2cc0dbeceb95473000', // 5,790,446.861699
    dead: '0x00000000000000000000000000000000000000000000000001ab6cf38db4da28', // 0.12030961
    self: '0x0000000000000000000000000000000000000000000000afc4cf6599541b7000', // 3,242.3619
  },
  optimism: {
    totalSupply: '0x00000000000000000000000000000000000000000003f2ad6d215e1dd4bbd000', // 4,772,789.298093
    dead: ZRO_ZERO_HEX,
    self: '0x00000000000000000000000000000000000000000000008878b90b4647db15f5', // 2,517.4562
  },
  polygon: {
    totalSupply: '0x000000000000000000000000000000000000000000020ddf9e798caba659c000', // 2,483,367.446748
    dead: '0x0000000000000000000000000000000000000000000000000006c8eaa45db954', // 0.00190976
    self: '0x000000000000000000000000000000000000000000000005bebc38171b2d7a60', // 105.9776
  },
  avax: {
    totalSupply: '0x00000000000000000000000000000000000000000000e36445260b144eccd000', // 1,073,826.848701
    dead: ZRO_ZERO_HEX,
    self: '0x0000000000000000000000000000000000000000000000058a770765605a4000', // 102.2112
  },
};

function fakeLayerZero(over = {}) {
  const chains = structuredClone(ZRO_CAPTURED);
  for (const [k, v] of Object.entries(over.chains || {})) Object.assign(chains[k], v);
  if (over.ethHolders) Object.assign(chains.eth.holders, over.ethHolders);
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const chain = Object.entries(EVM_RPC).find(([, rpcUrl]) => rpcUrl === u)?.[0];
    assert.ok(chain && chain in chains, 'unexpected ZRO RPC URL: ' + u);
    if (over.failChain === chain && over.httpStatus) {
      return { ok: false, status: over.httpStatus, json: async () => ({}) };
    }
    const req = JSON.parse(opts.body);
    assert.equal(req.method, 'eth_call');
    assert.equal(req.params[0].to.toLowerCase(), ZRO_ADDR);
    if (over.failChain === chain && over.rpcError) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { message: over.rpcError } }) };
    }
    const data = String(req.params[0].data).toLowerCase();
    calls.push(`${chain}:${data.slice(0, 10)}`);
    const c = chains[chain];
    let result;
    if (data === '0x18160ddd') result = c.totalSupply;
    else if (data === '0x313ce567') result = ZRO_DEC_HEX;
    else if (data === '0xbb0b6a5300000000000000000000000000000000000000000000000000000000000080ea') {
      assert.equal(chain, 'eth');
      result = over.peer33002 ?? c.peer33002;
    } else if (data.startsWith('0x70a08231')) {
      const holder = '0x' + data.slice(-40);
      if (holder === '0x0000000000000000000000000000000000000000') result = c.zero ?? ZRO_ZERO_HEX;
      else if (holder === '0x000000000000000000000000000000000000dead') result = c.dead;
      else if (holder === ZRO_ADDR) result = c.self;
      else result = c.holders?.[holder] ?? ZRO_ZERO_HEX;
    } else {
      throw new Error(`unexpected ${chain} ZRO call ${data}`);
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
  return calls;
}

test('ZRO: seed rule reads 7 EVM OFTs, verifies EID 33002 peer, records labeled/Foundation exclusions, and withholds circulating', async () => {
  const prev = globalThis.fetch;
  try {
    const { layerzero } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    assert.equal(layerzero.symbol, 'ZRO');
    assert.equal(layerzero.name, 'LayerZero');
    assert.deepEqual(layerzero.supply, { method: 'layerzero', max: 1000000000 });
    const calls = fakeLayerZero();
    const s = await readSupply(layerzero.supply);
    assert.ok(calls.includes('eth:0xbb0b6a53'), 'Ethereum peers(33002) is checked live');
    assert.equal(s.parts.length, 7, 'all 7 public EVM OFT chains are read');
    assert.deepEqual(s.parts.map(p => p.chain), ['eth', 'arbitrum', 'bsc', 'base', 'optimism', 'polygon', 'avax']);
    assert.ok(Math.abs(s.total - (891463765.610872 - 0.43779305)) < 1e-4);
    assert.equal(s.circulating, null, 'circulating is withheld while 57.7% partner/team vesting sits in unlabelled custody');
    assert.equal(s.max, 1000000000);
    assert.equal(s.checked, true);
    assert.equal(s.method, 'layerzero');
    assert.equal(s.src, 'https://etherscan.io/token/0x6985884C4392D348587B19cb9eAAf157F13271cd');
    // 5 non-zero dead burns + 7 parked-at-contract balances + LayerZero 1 + Foundation buyback multisig = 14
    assert.equal(s.excluded.length, 14);
    const lz1 = s.excluded.find(e => e.holder.toLowerCase() === '0x1f903473376fbe98cc763f1bc459c8fdb6ac3909');
    const buyback = s.excluded.find(e => e.holder.toLowerCase() === '0x6ac55e733dff03a54251670df0667774e8f7d28f');
    assert.equal(lz1.amount, 28999991);
    assert.ok(Math.abs(buyback.amount - 2721780.518456483) < 1e-6);
    assert.equal(buyback.src, 'https://layerzero.foundation/zro-buybacks');
    assert.match(s.note, /108,536,234 ZRO left the 7 EVM OFTs via OFT\._debit to the 8th active OFT peer EID 33002/);
    assert.match(s.note, /https:\/\/info\.layerzero\.foundation\/introducing-zro-d39df554a9b7/);
    assert.match(s.note, /Strategic Partners \(32\.2%, 322M ZRO\) and Core Contributors \(25\.5%, 255M ZRO\)/);
    assert.match(s.note, /0x744D\.\.\.DA24/);

    // Optional circulating:true mode subtracts non-burn exclusions + custom exclude entries without double-subtracting burns.
    const extraHolder = '0x744dbc48d11415ec5cb2f78609dea5e1e738da24';
    fakeLayerZero({ ethHolders: { [extraHolder]: '0x' + (10000000n * 10n ** 18n).toString(16) } });
    const s2 = await readSupply({ method: 'layerzero', max: 1000000000, circulating: true, exclude: [{ holder: extraHolder, reason: 'Verified lock' }] });
    const expectedNonBurn = 28225.06315580857 + 28999991 + 2721780.518456483 + 10_000_000;
    assert.ok(Math.abs(s2.circulating - (s.total - expectedNonBurn)) < 1e-3);
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(globalThis.fetch, prev, 'globalThis.fetch is restored after test');
});

test('ZRO: missing EID 33002 peer, 7-chain sum above 1B cap, NaN, or any chain RPC/HTTP error fails closed', async () => {
  const prev = globalThis.fetch;
  try {
    fakeLayerZero({ peer33002: ZRO_ZERO_HEX });
    await assert.rejects(readSupply({ method: 'layerzero' }), /unexpected Ethereum peers\(33002\)/);

    fakeLayerZero({ chains: { arbitrum: { totalSupply: '0x' + (300000000n * 10n ** 18n).toString(16).padStart(64, '0') } } });
    await assert.rejects(readSupply({ method: 'layerzero', max: 1000000000 }), /outside 1e8\.\.1000000000/);

    fakeLayerZero({ chains: { eth: { totalSupply: '0x0' } } });
    await assert.rejects(readSupply({ method: 'layerzero' }), /bad eth chain read/);

    fakeLayerZero({ chains: { bsc: { dead: 'NaN' } } });
    await assert.rejects(readSupply({ method: 'layerzero' }), /Cannot convert NaN/);

    fakeLayerZero({ failChain: 'polygon', rpcError: 'execution reverted' });
    await assert.rejects(readSupply({ method: 'layerzero' }), /polygon rpc: execution reverted/);

    fakeLayerZero({ failChain: 'avax', httpStatus: 503 });
    await assert.rejects(readSupply({ method: 'layerzero' }), /503/);
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(globalThis.fetch, prev, 'globalThis.fetch is restored after test');
});

// ---------- Official Trump (Solana) ----------
// Response shapes captured from api.mainnet-beta.solana.com on 2026-11-26.
const TRUMP_FX = JSON.parse(readFileSync(new URL('./fixtures/trump.json', import.meta.url), 'utf8'));
const TRUMP_MINT = '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
const TRUMP_MAGNA_OWNER = '2RH6rUTPBJ9rUDPpuV9b8z1YL56k1tYU6Uk5ZoaEFFSK';
const TRUMP_MAGNA_PROGRAM = 'magnaSHyv8zzKJJmr8NSz5JXmtdGDTTFPEADmvNAwbj';

function cloneTrumpFx() {
  return JSON.parse(JSON.stringify(TRUMP_FX));
}

function fakeTrump({ fx, rpcError, httpStatus } = {}) {
  const data = fx || cloneTrumpFx();
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (httpStatus) return { ok: false, status: httpStatus, json: async () => ({}) };
    assert.ok(String(url).includes('solana'), 'only the Solana RPC is called: ' + url);
    const req = JSON.parse(opts.body);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    if (rpcError) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { message: rpcError } }) };
    calls.push(req.method);
    if (req.method === 'getTokenSupply') {
      assert.equal(req.params[0], TRUMP_MINT);
      return reply(data.getTokenSupply);
    }
    assert.equal(req.method, 'getMultipleAccounts');
    return reply(data.getMultipleAccounts);
  };
  return calls;
}

test('trump: seed rule publishes mint total minus the Magna vesting vault', async () => {
  const prev = globalThis.fetch;
  try {
    const { 'official-trump': coin } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    assert.equal(coin.symbol, 'TRUMP');
    assert.equal(coin.supply.method, 'trump');
    assert.equal(coin.supply.max, 1000000000);
    const calls = fakeTrump();
    const s = await readSupply(coin.supply);
    assert.ok(calls.includes('getTokenSupply'));
    assert.ok(calls.includes('getMultipleAccounts'));
    assert.equal(s.total, 999998751.509708);
    assert.equal(s.excluded.length, 1);
    assert.equal(s.excluded[0].holder, TRUMP_MAGNA_OWNER);
    assert.equal(s.excluded[0].amount, 706131964.328498);
    assert.equal(s.circulating, 999998751.509708 - 706131964.328498);
    assert.ok(s.circulating < s.total);
    assert.equal(s.max, 1000000000);
    assert.equal(s.src, 'https://solscan.io/token/' + TRUMP_MINT);
    assert.match(s.note, /gettrumpmemes\.com\/#tokenomics/);
    assert.match(s.note, /Magna Token Vesting/);
    assert.match(s.note, /80% Creators & CIC Digital/);
    assert.match(s.note, /withdrawn from vesting sit in ordinary wallets/);
    assert.doesNotMatch(s.note, /2JEPvv/);
    assert.doesNotMatch(s.note, /5e2qRc/);
    assert.equal(s.checked, true);
    assert.equal(s.method, 'trump');
  } finally { globalThis.fetch = prev; }
});

test('trump: wrong program, mint mismatch, empty vault, missing accounts, or a broken RPC fail closed', async () => {
  const prev = globalThis.fetch;
  try {
    const badProgram = cloneTrumpFx();
    badProgram.getMultipleAccounts.value[1].owner = '11111111111111111111111111111111';
    fakeTrump({ fx: badProgram });
    await assert.rejects(readSupply({ method: 'trump', max: 1000000000 }), /not owned by Magna/);

    const badMint = cloneTrumpFx();
    badMint.getMultipleAccounts.value[0].data.parsed.info.mint = 'So11111111111111111111111111111111111111112';
    fakeTrump({ fx: badMint });
    await assert.rejects(readSupply({ method: 'trump' }), /vault mint/);

    const empty = cloneTrumpFx();
    empty.getMultipleAccounts.value[0].data.parsed.info.tokenAmount.amount = '0';
    fakeTrump({ fx: empty });
    await assert.rejects(readSupply({ method: 'trump' }), /Magna vault is empty/);

    const missing = cloneTrumpFx();
    missing.getMultipleAccounts.value[1] = null;
    fakeTrump({ fx: missing });
    await assert.rejects(readSupply({ method: 'trump' }), /Magna vault accounts missing/);

    const over = cloneTrumpFx();
    over.getTokenSupply.value.amount = '1';
    fakeTrump({ fx: over });
    await assert.rejects(readSupply({ method: 'trump' }), /not below total/);

    fakeTrump({ rpcError: 'rate limited' });
    await assert.rejects(readSupply({ method: 'trump' }), /rate limited/);

    fakeTrump({ httpStatus: 403 });
    await assert.rejects(readSupply({ method: 'trump' }), /403/);
  } finally { globalThis.fetch = prev; }
});


// ---------- Monad (MON, chain id 143) ----------
// Real live captured hex responses from https://rpc.monad.xyz at block 125,741,378 (0x77ea942).
const MONAD_TEST_CHAIN_ID = '0x8f';
const MONAD_TEST_BLOCK_HEX = '0x77ea942'; // 125,741,378
const MONAD_TEST_EPOCH = '0x00000000000000000000000000000000000000000000000000000000000009d30000000000000000000000000000000000000000000000000000000000000000';
const MONAD_TEST_ZERO = '0x1d3448ebccc54b296e52'; // 137,913.113213 MON
const MONAD_TEST_DEAD = '0x10f0024b15ddc975904'; // 4,999.046287 MON
const MONAD_TEST_STAKING = '0x49064324d5267dce00c2eed0'; // 22,605,741,115.654829 MON
const MONAD_TEST_STAKING_ADDR = '0x0000000000000000000000000000000000001000';
const MONAD_TEST_REWARD_TX = {
  to: MONAD_TEST_STAKING_ADDR,
  input: '0x791bdcf3000000000000000000000000bdc76c81d016a17fa853b7ad7e26548ad4de830f',
  value: '0xf9ccd8a1c5080000', // 18 MON (MIP-12)
};

function fakeMonad({
  chainId = MONAD_TEST_CHAIN_ID,
  blockNumber = MONAD_TEST_BLOCK_HEX,
  transactions = [MONAD_TEST_REWARD_TX],
  epoch = MONAD_TEST_EPOCH,
  zero = MONAD_TEST_ZERO,
  dead = MONAD_TEST_DEAD,
  staking = MONAD_TEST_STAKING,
  rpcError,
  httpStatus,
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (httpStatus) return { ok: false, status: httpStatus, json: async () => ({}) };
    const req = JSON.parse(opts.body);
    calls.push(req.method);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    if (rpcError) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, error: { message: rpcError } }) };
    if (req.method === 'eth_chainId') return reply(chainId);
    if (req.method === 'eth_getBlockByNumber') return reply({ number: blockNumber, transactions });
    if (req.method === 'eth_call') return reply(epoch);
    if (req.method === 'eth_getBalance') {
      const addr = String(req.params[0]).toLowerCase();
      if (addr === '0x0000000000000000000000000000000000000000') return reply(zero);
      if (addr === '0x000000000000000000000000000000000000dead') return reply(dead);
      if (addr === MONAD_TEST_STAKING_ADDR) return reply(staking);
      throw new Error('unexpected balance address ' + addr);
    }
    throw new Error('unexpected method ' + req.method);
  };
  return calls;
}

test('monad: seed rule publishes 100B genesis plus piecewise 25->18 MON/block schedule minus burns, notes base-fee burns, and withholds circulating', async () => {
  const prev = globalThis.fetch;
  try {
    const { monad } = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
    assert.equal(monad.symbol, 'MON');
    assert.equal(monad.supply.method, 'monad');
    assert.equal(monad.supply.genesis, 100000000000);
    assert.deepEqual(monad.supply.schedule, [
      { startBlock: 37304999, reward: 25 },
      { startBlock: 89656735, reward: 18 },
    ]);
    assert.equal(monad.supply.circulating, false);
    const calls = fakeMonad();
    const s = await readSupply(monad.supply);
    assert.ok(calls.includes('eth_chainId'));
    assert.ok(calls.includes('eth_getBlockByNumber'));
    assert.ok(calls.includes('eth_call'));
    assert.ok(calls.includes('eth_getBalance'));

    const block = 125741378;
    const emitted = (89656735 - 37304999) * 25 + (block - 89656735 + 1) * 18;
    const zeroAmount = Number(BigInt(MONAD_TEST_ZERO) / 10n ** 12n) / 1e6;
    const deadAmount = Number(BigInt(MONAD_TEST_DEAD) / 10n ** 12n) / 1e6;
    const burned = zeroAmount + deadAmount;
    const expectedTotal = 100000000000 + emitted - burned;

    assert.ok(Math.abs(s.total - expectedTotal) < 1e-6);
    assert.equal(s.circulating, null, 'circulating is withheld per tokenomics disclosure');
    assert.equal(s.excluded.length, 2);
    assert.equal(s.excluded[0].amount, zeroAmount);
    assert.equal(s.excluded[1].amount, deadAmount);
    assert.equal(s.src, 'https://docs.monad.xyz/monad-arch/consensus/staking');
    assert.match(s.note, /100 billion MON genesis/);
    assert.match(s.note, /37,304,999\.\.89,656,734/);
    assert.match(s.note, /base-fee burns are not exposed cumulatively .* and are not subtracted/);
    assert.match(s.note, /Circulating supply is withheld/);
    assert.equal(s.checked, true);
    assert.equal(s.method, 'monad');
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(globalThis.fetch, prev, 'globalThis.fetch is restored after test');
});

test('monad: wrong chain, block before reward start, changed syscallReward value, zero epoch, staking above total, or broken RPC fail closed', async () => {
  const prev = globalThis.fetch;
  try {
    const rule = {
      method: 'monad',
      genesis: 100000000000,
      schedule: [{ startBlock: 37304999, reward: 25 }, { startBlock: 89656735, reward: 18 }],
      circulating: false,
    };
    fakeMonad({ chainId: '0x1' });
    await assert.rejects(readSupply(rule), /not mainnet chain id 143/);
    fakeMonad({ blockNumber: '0x1' });
    await assert.rejects(readSupply(rule), /below reward start block/);
    fakeMonad({ transactions: [{ ...MONAD_TEST_REWARD_TX, value: '0xde0b6b3a7640000' }] }); // 1 MON instead of 18 MON
    await assert.rejects(readSupply(rule), /latest syscallReward value .* does not match 18 MON/);
    fakeMonad({ transactions: [] });
    await assert.rejects(readSupply(rule), /missing syscallReward transaction/);
    fakeMonad({ epoch: '0x' + '0'.repeat(128) });
    await assert.rejects(readSupply(rule), /getEpoch returned 0/);
    fakeMonad({ staking: '0x2863c1f5cdae42f9540000000' }); // 200B MON, above total
    await assert.rejects(readSupply(rule), /staking contract holds .* which is not below total/);
    fakeMonad({ rpcError: 'rate limited' });
    await assert.rejects(readSupply(rule), /rate limited/);
    fakeMonad({ httpStatus: 403 });
    await assert.rejects(readSupply(rule), /403/);
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(globalThis.fetch, prev, 'globalThis.fetch is restored after test');
});

test('monad: invalid configuration fails closed rather than guessing', async () => {
  const prev = globalThis.fetch;
  try {
    fakeMonad();
    await assert.rejects(readSupply({ method: 'monad', genesis: 0 }), /invalid configuration/);
    await assert.rejects(readSupply({ method: 'monad', schedule: [] }), /invalid configuration/);
    await assert.rejects(readSupply({ method: 'monad', schedule: [{ startBlock: 100, reward: 25 }, { startBlock: 50, reward: 18 }] }), /invalid configuration/);
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(globalThis.fetch, prev, 'globalThis.fetch is restored after test');
});

test('initia: seed rule reads the interwoven-1 bank total and withholds circulating', async () => {
  const coins = JSON.parse(readFileSync(new URL('../data-seed/coins.json', import.meta.url), 'utf8'));
  const initia = coins['initia'];
  assert.equal(initia.symbol, 'INIT');
  assert.equal(initia.name, 'Initia');
  assert.equal(initia.supply.method, 'initia');
  assert.equal(initia.supply.circulating, false);
  assert.equal(initia.supply.max, 1000000000);
  assert.equal(initia.supply.denom, 'uinit');

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/cosmos/bank/v1beta1/supply/by_denom?denom=uinit')) {
      return { ok: true, json: async () => ({ amount: { denom: 'uinit', amount: '1000000000000000' } }) };
    }
    if (u.includes('/cosmos/distribution/v1beta1/community_pool')) {
      return { ok: true, json: async () => ({ pool: [{ denom: 'uinit', amount: '483000000000' }] }) };
    }
    throw new Error('unexpected url: ' + u);
  };

  try {
    const s = await readSupply(initia.supply);
    assert.equal(s.circulating, null, 'circulating is withheld, never overstated');
    assert.equal(s.max, 1000000000);
    assert.equal(s.total, 1000000000);
    assert.equal(s.excluded.length, 1);
    assert.equal(s.excluded[0].amount, 483000);
    assert.ok(s.excluded[0].reason.includes('Community pool'));
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('initia: LCD errors and malformed supply fail closed instead of guessing', async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'internal error' }) });
    await assert.rejects(readSupply({ method: 'initia' }), /500|fetch/);

    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('/cosmos/bank/v1beta1/supply/by_denom')) {
        return { ok: true, json: async () => ({ amount: { denom: 'wrong_denom', amount: '1000' } }) };
      }
      return { ok: true, json: async () => ({ pool: [] }) };
    };
    await assert.rejects(readSupply({ method: 'initia' }), /bad bank supply/);

    globalThis.fetch = async url => {
      const u = String(url);
      if (u.includes('/cosmos/bank/v1beta1/supply/by_denom')) {
        return { ok: true, json: async () => ({ amount: { denom: 'uinit', amount: 'NaN' } }) };
      }
      return { ok: true, json: async () => ({ pool: [] }) };
    };
    await assert.rejects(readSupply({ method: 'initia' }), /bad bank supply/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

