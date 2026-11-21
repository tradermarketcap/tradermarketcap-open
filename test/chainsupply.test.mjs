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
