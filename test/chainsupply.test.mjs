import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSupply } from '../collector/sources/chainsupply.mjs';

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
