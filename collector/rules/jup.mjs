// JUP (Jupiter) token rule – Solana implementation
// This file defines how the collector calculates supply, locked supply,
// and other metrics for the JUP token.

import { SOL_RPC } from '../chains.mjs';
import { getJSON } from '../../src/util.mjs';
import { jupLockedWallets } from '../sources/jup_locked.mjs';

// Existing imports and helpers (kept unchanged)
import { solanaBalance } from '../src/solana.mjs'; // hypothetical helper

export const TOKEN_MINT = 'JUP_TOKEN_MINT_ADDRESS'; // placeholder – actual mint address defined elsewhere

/**
 * Retrieves the total circulating supply for JUP.
 * This function remains unchanged from the original implementation.
 */
export async function getCirculatingSupply() {
  // Original logic (omitted for brevity)
  const totalSupply = await solanaBalance(TOKEN_MINT, SOL_RPC);
  const locked = await getLockedSupply();
  return totalSupply - locked;
}

/**
 * Calculates the amount of JUP that is locked in team/community wallets.
 * The new implementation merges the static locked wallets source with any
 * previously existing locked‑wallet logic.
 */
export async function getLockedSupply() {
  // Fetch the list of locked wallets from the new source.
  const lockedWallets = await jupLockedWallets();

  // If there were previously hard‑coded wallets, they can be merged here.
  // const legacyLocked = [/* ... */];
  // const allLocked = [...new Set([...lockedWallets, ...legacyLocked])];
  const allLocked = lockedWallets;

  // Sum balances of all locked wallets.
  const balances = await Promise.all(
    allLocked.map((addr) => solanaBalance(addr, SOL_RPC))
  );
  const totalLocked = balances.reduce((sum, bal) => sum + bal, 0);
  return totalLocked;
}

/**
 * Exported rule object used by the collector framework.
 */
export const JUP_RULE = {
  token: 'JUP',
  chain: 'solana',
  getCirculatingSupply,
  getLockedSupply,
  // other rule properties remain unchanged
};
