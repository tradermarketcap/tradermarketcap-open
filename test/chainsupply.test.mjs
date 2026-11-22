import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readSupply } from '../collector/sources/chainsupply.mjs';

// Real response shapes, captured from BNB Chain's public RPC and bnbburn.info on 2026-11-21. No network in tests.
const BALANCES = {
  '0x0000000000000000000000000000000000001004': '0x157a9cb53fd94060e95045', // TokenHub ~25,966,461.7
  '0x000000000000000000000000000000000000dead': '0xf02fa7f3c8ab4aed33f9e', // burn address ~18,147,952.9
  '0x0000000000000000000000000000000000000000': '0x150430259f7af74df946', // zero address ~99,246.95
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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

// TON. Response shapes captured from tonapi.io and toncenter.com on 2026-11-22. Config param 44 is the
// on-chain suspended_address_list: the accounts frozen until `suspended_until` (unix seconds).
const TON_LOCKER = 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2';
const TON_FROZEN = ['0:00ed1c8d25c4774e0ef3fc1c176fcd5e3c3beb2f2b506a73bad9303aea648313', '0:0769ffdea3d8261cb8844691f963979baffcf8a57e0dcac0263cc7076bd4976a'];
const TON_FROZEN_NANO = { [TON_FROZEN[0]]: '1000368958873', [TON_FROZEN[1]]: '2400000000000' };

// Fake chain: masterchain head + one shard, the Locker balance, config param 44 and the bulk balance read.
// `bulkFor(body)` can override the bulk answer to simulate a broken balance read.
function fakeTon({ seqno = 107059551, mcGrams = '2520961419649332862', shardGrams = '2767229266373100000',
  lockerNano = '1240902290670000000', accounts = TON_FROZEN, until = 1803189600, bulkFor = null } = {}) {
  const prevFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = body => ({ ok: true, status: 200, json: async () => body });
    seen.push(u);
    if (u.endsWith('/v2/blockchain/masterchain-head')) return reply({ seqno, value_flow: { to_next_blk: { grams: mcGrams } } });
    if (u.endsWith(`/v2/blockchain/masterchain/${seqno}/shards`)) return reply({ shards: [{ last_known_block: { value_flow: { to_next_blk: { grams: shardGrams } } } }] });
    if (u.endsWith('/v2/blockchain/config')) return reply({ '44': { accounts, suspended_until: until } });
    if (u.includes('toncenter.com/api/v2/getAddressBalance')) return reply({ ok: true, result: lockerNano });
    if (u.includes('tonapi.io/v2/accounts/_bulk')) {
      const { account_ids: ids } = JSON.parse(opts.body);
      if (bulkFor) return reply(bulkFor(ids));
      return reply({ accounts: ids.map(a => ({ address: a, balance: TON_FROZEN_NANO[a] })) });
    }
    throw new Error('unexpected url ' + u);
  };
  return () => { globalThis.fetch = prevFetch; };
}

const TON_TOTAL = (Number(2520961419649332862n) + Number(2767229266373100000n)) / 1e9;
const TON_LOCKER_TON = Number(1240902290670000000n) / 1e9;
const TON_FROZEN_TON = (1000368958873 + 2400000000000) / 1e9;

test('ton: frozen early-miner balances are read from config param 44, not hardcoded', async () => {
  const restore = fakeTon();
  try {
    const s = await readSupply({ method: 'ton' });
    assert.ok(Math.abs(s.total - TON_TOTAL) < 0.01, 'total is masterchain plus shard value_flow');
    const frozen = s.excluded.find(e => /frozen/i.test(e.reason));
    assert.ok(frozen, 'the frozen wallets are listed as excluded');
    assert.ok(Math.abs(frozen.amount - TON_FROZEN_TON) < 1e-6, 'frozen amount is the live sum of the listed accounts');
    assert.match(frozen.reason, /^2 early-miner wallets frozen until 2027-02-21/, 'the reason names the real account count and end date');
    const locker = s.excluded.find(e => /Believers/i.test(e.reason));
    assert.ok(Math.abs(locker.amount - TON_LOCKER_TON) < 1e-6);
    assert.ok(Math.abs(s.circulating - (TON_TOTAL - TON_LOCKER_TON - TON_FROZEN_TON)) < 1e-6);
    assert.equal(s.checked, true);
    assert.equal(s.method, 'ton');
  } finally { restore(); }
});

test('ton: the frozen total follows the chain, so a different balance read moves circulating', async () => {
  const restore = fakeTon({
    accounts: [TON_FROZEN[0]],
    bulkFor: ids => ({ accounts: ids.map(a => ({ address: a, balance: '5000000000000' })) }),
  });
  try {
    const s = await readSupply({ method: 'ton' });
    const frozen = s.excluded.find(e => /frozen/i.test(e.reason));
    assert.equal(frozen.amount, 5000);
    assert.match(frozen.reason, /^1 early-miner wallet frozen/);
    assert.ok(Math.abs(s.circulating - (TON_TOTAL - TON_LOCKER_TON - 5000)) < 1e-6);
  } finally { restore(); }
});

test('ton: a failed balance read fails the whole supply read', async () => {
  const restore = fakeTon({ bulkFor: ids => ({ accounts: ids.map(a => ({ address: a, balance: null })) }) });
  try { await assert.rejects(readSupply({ method: 'ton' }), /bad TON frozen balance/); }
  finally { restore(); }
});

test('ton: a short bulk answer (a dropped account) fails instead of summing a partial list', async () => {
  const restore = fakeTon({ bulkFor: ids => ({ accounts: ids.slice(0, 1).map(a => ({ address: a, balance: '1' })) }) });
  try { await assert.rejects(readSupply({ method: 'ton' }), /bad TON frozen balance read/); }
  finally { restore(); }
});

test('ton: after the freeze ends the wallets are not excluded', async () => {
  const restore = fakeTon({ until: 1000 }); // a date in the past
  try {
    const s = await readSupply({ method: 'ton' });
    assert.equal(s.excluded.find(e => /frozen/i.test(e.reason)), undefined);
    assert.ok(Math.abs(s.circulating - (TON_TOTAL - TON_LOCKER_TON)) < 1e-6);
  } finally { restore(); }
});

test('ton: a rule cannot type in a frozen-miner number', async () => {
  const restore = fakeTon();
  try {
    const s = await readSupply({ method: 'ton', frozenMiners: 1 });
    assert.ok(Math.abs(s.excluded.find(e => /frozen/i.test(e.reason)).amount - TON_FROZEN_TON) < 1e-6);
  } finally { restore(); }
});

test('ton: broken masterchain, shard or param 44 reads fail the read', async () => {
  let restore = fakeTon({ mcGrams: null });
  try { await assert.rejects(readSupply({ method: 'ton' }), /masterchain head/); }
  finally { restore(); }

  restore = fakeTon({ shardGrams: null });
  try { await assert.rejects(readSupply({ method: 'ton' }), /shard value_flow/); }
  finally { restore(); }

  restore = fakeTon({ accounts: [] });
  try { await assert.rejects(readSupply({ method: 'ton' }), /config param 44/); }
  finally { restore(); }
});
