import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainSupply } from '../collector/sources/chainsupply.mjs';

// Import the chains module – we will use its mock setter instead of reassigning the read‑only export.
import * as chains from '../collector/chains.mjs';

const originalSuiImpl = chains.sui; // keep reference to the real implementation

test('sui supply method calculates circulating supply correctly', async () => {
  // Mock the sui RPC call via the exported setter
  chains.setSuiMock(async (method, params) => {
    if (method === 'sui_getTotalSupply') {
      // totalSupply is expressed in the smallest unit (1e9 per SUI)
      return { data: { totalSupply: '1000000000000000000' } }; // 1,000,000,000 SUI (1e9 * 1e9)
    }
    throw new Error('unexpected method ' + method);
  });

  const rule = {
    method: 'sui',
    chain: 'sui',
    address: '0x2::sui::SUI',
  };

  const result = await chainSupply(rule);

  // Total supply is 1,000,000,000 SUI
  // Locked is 100,000,000 SUI (hard‑coded in the supply method)
  // Circulating should be 900,000,000 SUI
  assert.equal(result.total, 1000000000);
  assert.equal(result.circulating, 900000000);
  assert.ok(result.src);
  assert.ok(result.note);

  // Restore the original implementation
  chains.setSuiMock(originalSuiImpl);
});

test('sui supply method throws on bad circulating supply', async () => {
  chains.setSuiMock(async (method, params) => {
    if (method === 'sui_getTotalSupply') {
      // 50,000,000 SUI – less than the hard‑coded locked amount (100,000,000)
      return { data: { totalSupply: '50000000000000000' } };
    }
    throw new Error('unexpected method ' + method);
  });

  const rule = {
    method: 'sui',
    chain: 'sui',
    address: '0x2::sui::SUI',
  };

  await assert.rejects(() => chainSupply(rule), /bad circulating supply/);

  // Restore the original implementation
  chains.setSuiMock(originalSuiImpl);
});
