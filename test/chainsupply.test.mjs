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
