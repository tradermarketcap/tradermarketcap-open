import { n } from '../../src/util.mjs';

/**
 * Known non‑circulating wallets for Chainlink (LINK).
 * Sources:
 *   - https://blog.chain.link/chainlink-tokenomics/
 */
export const NON_CIRCULATING_WALLETS = [
  {
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    source: 'https://blog.chain.link/chainlink-tokenomics/'
  },
  {
    address: '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13',
    source: 'https://blog.chain.link/chainlink-tokenomics/'
  }
];

/**
 * Returns the list of LINK non‑circulating wallets.
 * The `balance` field is left as `null` to be populated by the generic supply
 * fetching logic elsewhere in the codebase.
 */
export async function getLinkNonCirculating() {
  return NON_CIRCULATING_WALLETS.map(w => ({ ...w, balance: null }));
}
