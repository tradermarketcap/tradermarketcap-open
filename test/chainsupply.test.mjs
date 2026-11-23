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
