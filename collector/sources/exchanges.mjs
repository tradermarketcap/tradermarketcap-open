// Public exchange tickers. One bulk call per exchange gives every pair.
// Each reader returns markets: { venue, base, quote, price, volBase, volQuote, change24h, api, trade }.
// `api` is the public URL for that one pair, so anyone can check the number we show.
import { getJSON, n } from '../../src/util.mjs';
import { USD_QUOTES } from '../../src/model.mjs';

const ALIAS = { XBT: 'BTC', XDG: 'DOGE' };
const sym = s => ALIAS[s] || s;
const keep = (base, quote) => base && USD_QUOTES.has(quote);

function splitJoined(s) {
  for (const q of ['USDT', 'USDC', 'USD']) if (s.endsWith(q) && s.length > q.length) return [s.slice(0, -q.length), q];
  return [null, null];
}

// Binance.US keeps serving the last 24h figures of delisted and halted pairs (closeTime stays at the last trade day:
// on 2026-11-22 that was 195 pairs worth $95M of "volume"). Those are not markets.
const frozen = v => n(v.closeTime) != null && Date.now() - n(v.closeTime) > 864e5;

export const VENUES = {
  coinbase: { name: 'Coinbase', type: 'Exchange', site: 'https://www.coinbase.com' },
  kraken: { name: 'Kraken', type: 'Exchange', site: 'https://www.kraken.com' },
  okx: { name: 'OKX', type: 'Exchange', site: 'https://www.okx.com' },
  kucoin: { name: 'KuCoin', type: 'Exchange', site: 'https://www.kucoin.com' },
  gate: { name: 'Gate', type: 'Exchange', site: 'https://www.gate.io' },
  mexc: { name: 'MEXC', type: 'Exchange', site: 'https://www.mexc.com' },
  binanceus: { name: 'Binance.US', type: 'Exchange', site: 'https://www.binance.us' },
  bybit: { name: 'Bybit', type: 'Exchange', site: 'https://www.bybit.com' },
  bitget: { name: 'Bitget', type: 'Exchange', site: 'https://www.bitget.com' },
  cryptocom: { name: 'Crypto.com Exchange', type: 'Exchange', site: 'https://crypto.com/exchange' },
  upbit: { name: 'Upbit', type: 'Exchange', site: 'https://upbit.com' },
  bitfinex: { name: 'Bitfinex', type: 'Exchange', site: 'https://www.bitfinex.com' },
  htx: { name: 'HTX', type: 'Exchange', site: 'https://www.htx.com' },
  gemini: { name: 'Gemini', type: 'Exchange', site: 'https://www.gemini.com' },
  bithumb: { name: 'Bithumb', type: 'Exchange', site: 'https://www.bithumb.com' },
};

// Bitfinex writes some symbols with a colon (tLINK:USD, tAVAX:USD) and others joined (tBTCUSD),
// so both forms have to be read. UST is Bitfinex's name for USDT. Anything still unclear is dropped.
//
// Bitfinex's own tickers are not the tickers everyone else uses, and two of them collide with real
// coins: their UST is Tether USDt (not TerraUSD) and their WBT is Wrapped Bitcoin (not WhiteBIT
// Token, which they call WHBT). Publishing the codes unchanged put both markets under the wrong
// coin, so bitfinexCodeMaps() below reads Bitfinex's own symbol/label/explorer maps and the reader
// translates each base before publishing.
//
// The same maps identify rows that are not crypto at all: tokenized notes and securities such as
// ALT2612, CH100, CMSTR, TITAN1-4, USTBL, ALKN have no label beyond their own code and no chain, so
// on the site they would appear as coins. Drop those. A base is kept when it has a real name OR a
// blockchain explorer OR an alias in Bitfinex's map, which is why real