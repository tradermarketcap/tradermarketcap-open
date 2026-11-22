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

// AERO on Base. Values below are the live reads on 2026-11-22, block 60,754,622:
// totalSupply 2,149,167,194 and sAERO holding 1,080,292,319 AERO. Aero's own upgrade page
// publishes circulating as total less sAERO (~1.07B), which these two numbers reproduce.
const AERO = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';

function fakeBase({ total = '0x' + (2149167194n * 10n ** 18n).toString(16),
                    saero = '0x' + (1080292319n * 10n ** 18n).toString(16),
                    saeroFails = false } = {}) {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const req = JSON.parse(opts.body);
    const reply = result => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) });
    const { to, data } = req.params[0];
    seen.push({ to: to.toLowerCase(), selector: data.slice(0, 10) });
    if (data.startsWith('0x313ce567')) return reply('0x' + (18).toString(16).padStart(64, '0'));
    if (data.startsWith('0x18160ddd')) return reply(total);
    // balanceOf(holder): answer 0 for anything that is not the sAERO contract
    const holder = '0x' + data.slice(-40);
    if (holder === '0xbf7977e1521e9a3032bf7243ee4712f311f13915') {
      if (saeroFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return reply(saero);
    }
    return reply('0x' + (0n).toString(16));
  };
  return seen;
}

test('aero: circulating is total supply minus the sAERO staked balance, not the migration reserves', async () => {
  const seen = fakeBase();
  const s = await readSupply({
    method: 'tokens',
    parts: [{ chain: 'base', address: '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee' }],
    exclude: [{ chain: 'base', holder: '0xBF7977E1521e9a3032bf7243Ee4712f311f13915', reason: 'sAERO' }],
  });
  assert.equal(s.total, 2149167194);
  // the excluded balance is subtracted exactly once
  const sAero = s.excluded.find(e => e.holder.toLowerCase() === '0xbf7977e1521e9a3032bf7243ee4712f311f13915');
  assert.ok(sAero, 'sAERO appears in excluded');
  assert.equal(sAero.amount, 1080292319);
  assert.equal(s.circulating, 2149167194 - 1080292319);
  // the published figure is ~1.07B; refusing to also subtract the migration reserves keeps us there
  assert.ok(Math.abs(s.circulating - 1.07e9) / 1.07e9 < 0.01);
  // only the live contract is queried
  assert.ok(seen.every(c => c.to === AERO || c.to === '0xbf7977e1521e9a3032bf7243ee4712f311f13915'));
});

test('aero: a failed sAERO balance read throws instead of publishing an overstated circulating', async () => {
  fakeBase({ saeroFails: true });
  await assert.rejects(readSupply({
    method: 'tokens',
    parts: [{ chain: 'base', address: '0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee' }],
    exclude: [{ chain: 'base', holder: '0xBF7977E1521e9a3032bf7243Ee4712f311f13915', reason: 'sAERO' }],
  }));
});
