import { getJSON } from '../../src/util.mjs';

/**
 * URL of the JSON file that contains Jupiter's locked wallet addresses.
 * The file is maintained by the Jupiter team and lists all team/community
 * wallets that are considered locked for supply calculations.
 */
export const JUP_LOCKED_SOURCE = 'https://raw.githubusercontent.com/jup-ag/jup-token/main/locked_wallets.json';

/**
 * Fetches the list of locked wallet addresses for JUP.
 *
 * The JSON is expected to have the shape:
 * {
 *   "wallets": ["<address1>", "<address2>", ...]
 * }
 *
 * @returns {Promise<string[]>} Array of Solana wallet address strings.
 */
export async function jupLockedWallets() {
  try {
    const data = await getJSON(JUP_LOCKED_SOURCE);
    if (Array.isArray(data.wallets)) {
      return data.wallets;
    }
    // Fallback to empty array if the shape is unexpected.
    return [];
  } catch (err) {
    // If the source is unavailable we don't want the whole collector to fail.
    console.error('Failed to fetch JUP locked wallets:', err);
    return [];
  }
}
