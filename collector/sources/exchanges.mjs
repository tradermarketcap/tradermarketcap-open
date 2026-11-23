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
// blockchain explorer OR an alias in Bitfinex's map, which is why real assets with a terse name
// (XRP, SOL, DOGE) survive.
const BITFINEX_QUOTES = new Set(['USD', 'USDT', 'USDC']);
const FIAT_BASES = new Set(['EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'CNH', 'SGD', 'NZD', 'HKD']);

let bfMaps = null, bfMapsAt = 0;

async function bitfinexCodeMaps() {
  if (bfMaps && Date.now() - bfMapsAt < 6 * 3600e3) return bfMaps;
  const [symRaw, labelRaw, explorerRaw] = await Promise.all([
    getJSON('https://api-pub.bitfinex.com/v2/conf/pub:map:currency:sym'),
    getJSON('https://api-pub.bitfinex.com/v2/conf/pub:map:currency:label'),
    getJSON('https://api-pub.bitfinex.com/v2/conf/pub:map:currency:explorer'),
  ]);
  const toMap = raw => {
    if (!Array.isArray(raw?.[0])) throw new Error('bitfinex bad code map');
    return new Map(raw[0]);
  };
  bfMaps = { sym: toMap(symRaw), label: toMap(labelRaw), explorer: toMap(explorerRaw) };
  bfMapsAt = Date.now();
  return bfMaps;
}

// Translate one of Bitfinex's currency codes to the ticker the rest of the world uses.
//
// This is a small explicit table on purpose. Bitfinex's sym map is not a rename map: it carries
// display forms ("USDt" for UST, "XAUt" for XAUT) and genuine renames (TON -> "GRAM"), and applying
// it verbatim would publish GRAM for the TON market, which is the same class of error this fix is
// about. Each entry below was read off
// https://api-pub.bitfinex.com/v2/conf/pub:map:currency:sym and cross-checked against the label map,
// so every one is the same asset under a different code. A code not listed here keeps Bitfinex's
// own ticker, which is never fabricated — it is the code the exchange itself uses.
//
// The two collisions the review named are the reason this exists: Bitfinex's UST is Tether USDt
// (not TerraUSD) and its WBT is Wrapped Bitcoin (not WhiteBIT Token, which it calls WHBT).
const BITFINEX_TICKER = {
  UST: 'USDT',   // Tether USDt  (label "Tether USDt")
  WBT: 'WBTC',   // Wrapped Bitcoin (label "Wrapped Bitcoin")
  WHBT: 'WBT',   // WhiteBIT Token (label "WhiteBIT Token")
  UDC: 'USDC',   // USDc
  DSH: 'DASH',   // Dash
  IOT: 'IOTA',   // Iota
  ALG: 'ALGO',   // Algorand
  OPX: 'OP',     // Optimism
  LIFIII: 'LIF3',
  BCHN: 'BCH',   // Bitcoin Cash
};

// Codes Bitfinex prices that are not tradable coins: ETH2X is a staked-ETH accounting unit.
const BITFINEX_NOT_COINS = new Set(['ETH2X']);

function bitfinexPair(symbol, maps) {
  if (!symbol.startsWith('t')) return null;
  const body = symbol.slice(1);
  let base, raw;
  if (body.includes(':')) {
    [base, raw] = body.split(':');
  } else {
    for (const s of ['USDT', 'USDC', 'UST', 'USD']) {
      if (body.endsWith(s) && body.length > s.length) { base = body.slice(0, -s.length); raw = s; break; }
    }
  }
  if (!base || !raw) return null;
  const quote = raw === 'UST' ? 'USDT' : raw;
  if (!BITFINEX_QUOTES.has(quote)) return null;
  if (base.includes('TEST') || raw.includes('TEST')) return null; // Bitfinex's play-money pairs
  if (FIAT_BASES.has(base)) return null; // EUR/USD, GBP/USD are currency crosses, not coins
  if (BITFINEX_NOT_COINS.has(base)) return null; // ETH2X is a staked-ETH accounting unit
  // Tokenized notes and securities carry no name beyond their own code and no chain. Real assets
  // with a terse name (XRP, SOL, DOGE) are in the explorer map, so they survive this.
  if (!maps.label.has(base) || maps.label.get(base) === base) {
    if (!maps.explorer.has(base) && !maps.sym.has(base)) return null;
  }
  return { base, quote, raw, ticker: BITFINEX_TICKER[base] || base };
}

// Gemini lists stablecoin-quoted pairs too (btcgusd, ethrlusd). Those pair names end in "USD",
// so splitJoined() would keep the stablecoin ticker glued to the base (SOLRLUSD -> base "SOLRL",
// BTCGUSD -> "BTCG") and publish a ticker that does not exist. Match the longest quote first and
// let keep() drop them, so no fabricated base ever reaches the site.
const GEMINI_QUOTES = ['USDT', 'USDC', 'GUSD', 'RLUSD', 'USD'];

// Gemini also quotes fiat crosses (EURUSD, EURUSDC, AUDUSD, AUDUSDC). Their bases are currencies,
// not coins, so a naive split would publish "EUR" and "AUD" as crypto assets. Drop them.
const GEMINI_FIAT = new Set(['AUD', 'EUR', 'GBP', 'SGD', 'HKD', 'CAD', 'CHF', 'JPY', 'NZD']);

// Gemini allows 120 public requests a minute and volume takes one request per pair, so volumes are cached and
// refreshed a few pairs at a time, oldest first (about a minute for a full round).
const GEMINI_VOL_BATCH = 15, GEMINI_VOL_GAP = 9e3, GEMINI_VOL_MAX_AGE = 10 * 60e3;
const geminiVol = new Map();
let geminiVolAt = 0;

function geminiPair(name) {
  const s = String(name || '').toUpperCase();
  for (const q of GEMINI_QUOTES) {
    if (s.endsWith(q) && s.length > q.length) return { base: s.slice(0, -q.length), quote: q };
  }
  return null;
}

let krakenPairs = null, krakenPairsAt = 0;
// HTX pair metadata rarely changes; the rolling 24h open moves every second, so it is
// cached briefly rather than refetched for every pair on every tick.
let htxPairs = null, htxPairsAt = 0;
const htxOpen = new Map();
const HTX_OPEN_TTL = 3 * 60e3;
const HTX_OPEN_BATCH = 120;

export const READERS = {
  async coinbase() {
    const d = await getJSON('https://api.exchange.coinbase.com/products/stats');
    const out = [];
    for (const [id, v] of Object.entries(d)) {
      const [b, q] = id.split('-'), s = v.stats_24hour || {};
      if (!keep(b, q)) continue;
      const price = n(s.last), open = n(s.open);
      out.push({
        venue: 'coinbase', base: sym(b), quote: q, price, volBase: n(s.volume), volQuote: null,
        change24h: price && open ? (price / open - 1) * 100 : null,
        api: `https://api.exchange.coinbase.com/products/${id}/stats`,
        trade: `https://www.coinbase.com/advanced-trade/spot/${id}`,
      });
    }
    return out;
  },

  async kraken() {
    if (!krakenPairs || Date.now() - krakenPairsAt > 6 * 3600e3) {
      krakenPairs = (await getJSON('https://api.kraken.com/0/public/AssetPairs')).result;
      krakenPairsAt = Date.now();
    }
    const d = (await getJSON('https://api.kraken.com/0/public/Ticker')).result;
    const out = [];
    for (const [k, v] of Object.entries(d)) {
      const p = krakenPairs[k];
      if (!p || !p.wsname) continue;
      const [b, q] = p.wsname.split('/');
      if (!keep(sym(b), q)) continue;
      out.push({
        venue: 'kraken', base: sym(b), quote: q, price: n(v.c[0]), volBase: n(v.v[1]), volQuote: null, change24h: null,
        api: `https://api.kraken.com/0/public/Ticker?pair=${p.altname}`,
        trade: `https://pro.kraken.com/app/trade/${b.toLowerCase()}-${q.toLowerCase()}`,
      });
    }
    return out;
  },

  async okx() {
    const d = (await getJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT')).data;
    const out = [];
    for (const v of d) {
      const [b, q] = v.instId.split('-');
      if (!keep(b, q)) continue;
      const price = n(v.last), open = n(v.open24h);
      out.push({
        venue: 'okx', base: b, quote: q, price, volBase: n(v.vol24h), volQuote: n(v.volCcy24h),
        change24h: price && open ? (price / open - 1) * 100 : null,
        api: `https://www.okx.com/api/v5/market/ticker?instId=${v.instId}`,
        trade: `https://www.okx.com/trade-spot/${v.instId.toLowerCase()}`,
      });
    }
    return out;
  },

  async kucoin() {
    const d = (await getJSON('https://api.kucoin.com/api/v1/market/allTickers')).data.ticker;
    const out = [];
    for (const v of d) {
      const [b, q] = v.symbol.split('-');
      if (!keep(b, q)) continue;
      out.push({
        venue: 'kucoin', base: b, quote: q, price: n(v.last), volBase: n(v.vol), volQuote: n(v.volValue),
        change24h: n(v.changeRate) != null ? n(v.changeRate) * 100 : null,
        api: `https://api.kucoin.com/api/v1/market/stats?symbol=${v.symbol}`,
        trade: `https://www.kucoin.com/trade/${v.symbol}`,
      });
    }
    return out;
  },

  async gate() {
    const d = await getJSON('https://api.gateio.ws/api/v4/spot/tickers', { timeout: 25000 });
    const out = [];
    for (const v of d) {
      const [b, q] = v.currency_pair.split('_');
      if (!keep(b, q)) continue;
      out.push({
        venue: 'gate', base: b, quote: q, price: n(v.last), volBase: n(v.base_volume), volQuote: n(v.quote_volume),
        change24h: n(v.change_percentage),
        api: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${v.currency_pair}`,
        trade: `https://www.gate.io/trade/${v.currency_pair}`,
      });
    }
    return out;
  },

  async mexc() {
    const d = await getJSON('https://api.mexc.com/api/v3/ticker/24hr', { timeout: 25000 });
    const out = [];
    for (const v of d) {
      const [b, q] = splitJoined(v.symbol);
      if (!keep(b, q)) continue;
      out.push({
        venue: 'mexc', base: b, quote: q, price: n(v.lastPrice), volBase: n(v.volume), volQuote: n(v.quoteVolume),
        change24h: n(v.priceChangePercent) != null ? n(v.priceChangePercent) * 100 : null,
        api: `https://api.mexc.com/api/v3/ticker/24hr?symbol=${v.symbol}`,
        trade: `https://www.mexc.com/exchange/${b}_${q}`,
      });
    }
    return out;
  },

  async binanceus() {
    const d = await getJSON('https://api.binance.us/api/v3/ticker/24hr');
    const out = [];
    for (const v of d) {
      const [b, q] = splitJoined(v.symbol);
      if (!keep(b, q) || frozen(v)) continue;
      out.push({
        venue: 'binanceus', base: b, quote: q, price: n(v.lastPrice), volBase: n(v.volume), volQuote: n(v.quoteVolume),
        change24h: n(v.priceChangePercent),
        api: `https://api.binance.us/api/v3/ticker/24hr?symbol=${v.symbol}`,
        trade: `https://www.binance.us/spot-trade/${b.toLowerCase()}_${q.toLowerCase()}`,
      });
    }
    return out;
  },
  // Bybit answers HTTP 200 even on errors, so check retCode. price24hPcnt is a fraction (0.0123 = 1.23%).
  async bybit() {
    const d = await getJSON('https://api.bybit.com/v5/market/tickers?category=spot', { timeout: 25000 });
    if (d.retCode !== 0) throw new Error(`bybit retCode ${d.retCode} ${d.retMsg || ''}`.trim());
    const out = [];
    for (const v of d.result.list) {
      const [b, q] = splitJoined(v.symbol);
      if (!keep(b, q)) continue;
      out.push({
        venue: 'bybit', base: b, quote: q, price: n(v.lastPrice), volBase: n(v.volume24h), volQuote: n(v.turnover24h),
        change24h: n(v.price24hPcnt) != null ? n(v.price24hPcnt) * 100 : null,
        api: `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${v.symbol}`,
        trade: `https://www.bybit.com/en/trade/spot/${b}/${q}`,
      });
    }
    return out;
  },
  // Bitget answers HTTP 200 even on errors, so check code. change24h is a fraction (-0.01865 = -1.865%).
  async bitget() {
    const d = await getJSON('https://api.bitget.com/api/v2/spot/market/tickers', { timeout: 25000 });
    if (d.code !== '00000') throw new Error(`bitget code ${d.code} ${d.msg || ''}`.trim());
    const out = [];
    for (const v of d.data || []) {
      const [b, q] = splitJoined(v.symbol);
      if (!keep(b, q)) continue;
      out.push({
        venue: 'bitget', base: b, quote: q, price: n(v.lastPr), volBase: n(v.baseVolume), volQuote: n(v.quoteVolume),
        change24h: n(v.change24h) != null ? n(v.change24h) * 100 : null,
        api: `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${v.symbol}`,
        trade: `https://www.bitget.com/spot/${b}${q}`,
      });
    }
    return out;
  },
  // Crypto.com answers HTTP 200 even on errors, so check code. Spot instruments are
  // BASE_QUOTE; derivatives (e.g. BTCUSD-PERP) have no "_" and are skipped by the split.
  // `c` is a fraction (0.005 = 0.5%).
  async cryptocom() {
    const d = await getJSON('https://api.crypto.com/exchange/v1/public/get-tickers', { timeout: 25000 });
    if (d.code !== 0) throw new Error(`cryptocom code ${d.code}`);
    const out = [];
    for (const v of d.result?.data || []) {
      const [b, q] = String(v.i).split('_');
      if (!keep(b, q)) continue;
      out.push({
        venue: 'cryptocom', base: b, quote: q, price: n(v.a), volBase: n(v.v), volQuote: n(v.vv),
        change24h: n(v.c) != null ? n(v.c) * 100 : null,
        api: `https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${v.i}`,
        trade: `https://crypto.com/exchange/trade/${String(v.i).toLowerCase()}`,
      });
    }
    return out;
  },
  // Upbit lists markets as QUOTE-BASE (USDT-BTC is BTC priced in USDT). Only the
  // USDT-quoted pairs are kept; signed_change_rate is a fraction.
  async upbit() {
    // /v1/ticker requires an explicit markets list; /v1/market/all gives them all.
    const all = await getJSON('https://api.upbit.com/v1/market/all', { timeout: 25000 });
    const markets = (Array.isArray(all) ? all : []).map(m => m.market).filter(m => typeof m === 'string' && m.startsWith('USDT-'));
    if (!markets.length) throw new Error('upbit no USDT markets');
    const d = await getJSON(`https://api.upbit.com/v1/ticker?markets=${markets.join(',')}`, { timeout: 25000 });
    if (!Array.isArray(d)) throw new Error('upbit bad response');
    const out = [];
    for (const v of d) {
      const [q, b] = String(v.market).split('-');
      if (q !== 'USDT' || !b) continue;
      out.push({
        venue: 'upbit', base: sym(b), quote: 'USDT', price: n(v.trade_price),
        volBase: n(v.acc_trade_volume_24h), volQuote: n(v.acc_trade_price_24h),
        change24h: n(v.signed_change_rate) != null ? n(v.signed_change_rate) * 100 : null,
        api: `https://api.upbit.com/v1/ticker?markets=${v.market}`,
        trade: `https://upbit.com/exchange?code=CRIX.UPBIT.${v.market}`,
      });
    }
    return out;
  },
  // Bitfinex rows are arrays, not objects: [sym, bid, bidSize, ask, askSize, dailyChange, dailyChangePerc,
  // last, volBase, high, low, ts]. Funding rows ('f' prefix) are not spot markets. An error answer is a
  // bare string (ERR_UNKNOWN) or an empty list, and both must fail loudly instead of returning no markets.
  async bitfinex() {
    const maps = await bitfinexCodeMaps();
    const d = await getJSON('https://api-pub.bitfinex.com/v2/tickers?symbols=ALL', { timeout: 25000 });
    if (!Array.isArray(d) || d.length === 0) throw new Error('bitfinex bad response');
    const out = [];
    for (const v of d) {
      if (!Array.isArray(v) || v.length < 10 || typeof v[0] !== 'string') continue;
      const p = bitfinexPair(v[0], maps);
      if (!p) continue;
      const price = n(v[7]), volBase = n(v[8]);
      out.push({
        venue: 'bitfinex', base: p.ticker, quote: p.quote, price, volBase,
        volQuote: volBase != null && price != null ? volBase * price : null,
        change24h: n(v[6]) != null ? n(v[6]) * 100 : null,
        api: `https://api-pub.bitfinex.com/v2/tickers?symbols=${v[0]}`,
        trade: `https://trading.bitfinex.com/t/${p.base}:${p.raw}`,
      });
    }
    return out;
  },
  // HTX (formerly Huobi) answers HTTP 200 even on errors, so check status. Symbols are
  // lowercase joined (btcusdt); taking the base/quote from the exchange's own symbol list
  // avoids guessing a split, which on other venues mints bases like SOLRL from SOLRLUSD.
  // The bulk `open`/`close`/`high`/`low` fields are a *natural day* (UTC+8) candle, not a
  // rolling 24 hours — deriving change from them flips the sign on 202 of 493 pairs.
  // The rolling 24h open is on market/detail/merged, which needs one call per pair, so the
  // open is cached for a few minutes; price and volume still refresh every cycle from bulk.
  async htx() {
    if (!htxPairs || Date.now() - htxPairsAt > 6 * 3600e3) {
      const s = await getJSON('https://api.huobi.pro/v1/common/symbols', { timeout: 25000 });
      if (s.status !== 'ok') throw new Error(`htx symbol list status ${s.status}`);
      htxPairs = new Map();
      for (const v of s.data || []) {
        const base = String(v['base-currency'] || '').toUpperCase();
        const quote = String(v['quote-currency'] || '').toUpperCase();
        if (v.state !== 'online' || !base || !USD_QUOTES.has(quote)) continue;
        // One pair is listed under a Chinese name. Its trade URL resolves, but a ticker
        // that is not printable ASCII does not belong next to the rest.
        if (!/^[\x20-\x7e]+$/.test(base)) continue;
        if (/[0-9]+[LS]$/.test(base)) continue; // leveraged tokens (TRX3L, TRX3S) are not spot coins
        htxPairs.set(v.symbol, { base: sym(base), quote });
      }
      htxPairsAt = Date.now();
    }
    if (!htxPairs.size) throw new Error('htx no USD markets');
    const d = await getJSON('https://api.huobi.pro/market/tickers', { timeout: 25000 });
    if (d.status !== 'ok') throw new Error(`htx status ${d.status} ${d['err-msg'] || ''}`.trim());
    // Bulk rows include delisted and reset pairs; a pair with no trades is not a market.
    const live = (d.data || []).filter(v => htxPairs.has(v.symbol) && n(v.close) > 0 && n(v.vol) > 0);
    if (!live.length) throw new Error('htx no live USD markets');
    const stale = live.filter(v => {
      const c = htxOpen.get(v.symbol);
      return !c || Date.now() - c.at > HTX_OPEN_TTL;
    });
    // A cold start reads every pair once; after that the oldest opens are refreshed in
    // bounded batches so one tick never fires 500 requests at the exchange.
    const batch = htxOpen.size
      ? stale.sort((a, b) => (htxOpen.get(a.symbol)?.at || 0) - (htxOpen.get(b.symbol)?.at || 0)).slice(0, HTX_OPEN_BATCH)
      : stale;
    let failed = 0;
    const queue = batch.map(v => v.symbol);
    const worker = async () => {
      while (queue.length) {
        const symbol = queue.pop();
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await getJSON(`https://api.huobi.pro/market/detail/merged?symbol=${symbol}`, { timeout: 20000 });
            if (r.status !== 'ok') throw new Error(`htx detail ${symbol} status ${r.status}`);
            htxOpen.set(symbol, { open: n(r.tick.open), at: Date.now() });
            break;
          } catch (e) {
            if (attempt) { htxOpen.delete(symbol); failed++; }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    const out = [];
    for (const v of live) {
      const p = htxPairs.get(v.symbol), c = htxOpen.get(v.symbol);
      if (!p || !c) continue;
      const price = n(v.close), open = n(c.open);
      out.push({
        venue: 'htx', base: p.base, quote: p.quote, price, volBase: n(v.amount), volQuote: n(v.vol),
        change24h: price && open ? (price / open - 1) * 100 : null,
        api: `https://api.huobi.pro/market/detail/merged?symbol=${v.symbol}`,
        trade: `https://www.htx.com/trade/${p.base.toLowerCase()}_${p.quote.toLowerCase()}`,
      });
    }
    // Never hand back a silently empty venue: if the rolling opens could not be read for
    // any pair at all, the read failed rather than the market being flat.
    if (!out.length) throw new Error(`htx no readable pairs (${failed} failed)`);
    return out;
  },
  // Gemini has no bulk ticker that carries volume: one v1/pricefeed call gives every pair with its
  // price and 24h change (a fraction, scaled to a percent below), and v1/pubticker gives one pair's
  // volume (cached, see above). A pair with no volume read yet has a null volume; an answer that is
  // not a list of pairs fails loudly. Gemini's USD and USDC books are one book and report the same
  // volume, so a USDC row carries no volume when the same coin has a USD row.
  async gemini() {
    const feed = await getJSON('https://api.gemini.com/v1/pricefeed', { timeout: 25000 });
    if (!Array.isArray(feed) || feed.length === 0) throw new Error('gemini bad response');
    const rows = [];
    for (const p of feed) {
      const pair = geminiPair(p?.pair);
      if (!pair) continue;
      const base = sym(pair.base), quote = pair.quote;
      if (GEMINI_FIAT.has(base)) continue; // fiat crosses (EUR/USD) are not coins
      if (!keep(base, quote)) continue; // GUSD/RLUSD-quoted pairs are dropped here
      // v1/pricefeed answers percentChange24h as a fraction ("0.0325" = +3.25%): v2/ticker for the
      // same moment shows open 57,119.99 close 58,975.2 = +3.25%. Publish it as a percent.
      const chg = n(p.percentChange24h);
      rows.push({ symbol: String(p.pair).toLowerCase(), base, quote, price: n(p.price), change24h: chg != null ? chg * 100 : null });
    }
    if (!rows.length) throw new Error('gemini no markets');

    const usdBases = new Set(rows.filter(r => r.quote === 'USD').map(r => r.base));
    const own = r => !(r.quote === 'USDC' && usdBases.has(r.base)); // false = volume is already on the USD row
    const now = Date.now();
    let due = [];
    if (now - geminiVolAt >= GEMINI_VOL_GAP) {
      geminiVolAt = now;
      const tried = r => geminiVol.get(r.symbol)?.tried || 0;
      due = rows.filter(own).sort((a, b) => tried(a) - tried(b)).slice(0, GEMINI_VOL_BATCH);
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < due.length) {
        const r = due[cursor++];
        const c = geminiVol.get(r.symbol) || { tried: 0, at: 0, volume: null };
        c.tried = Date.now();
        try {
          const t = await getJSON(`https://api.gemini.com/v1/pubticker/${r.symbol}`, { timeout: 8000 });
          if (t?.volume) { c.volume = t.volume; c.at = c.tried; }
        } catch { /* keep the last volume until it is too old */ }
        geminiVol.set(r.symbol, c);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, due.length) }, worker));

    return rows.map(r => {
      const c = geminiVol.get(r.symbol);
      const vol = own(r) && c?.volume && Date.now() - c.at < GEMINI_VOL_MAX_AGE ? c.volume : {};
      return {
        venue: 'gemini', base: r.base, quote: r.quote, price: r.price,
        volBase: n(vol[r.base]), volQuote: n(vol[r.quote]), change24h: r.change24h,
        api: `https://api.gemini.com/v1/pubticker/${r.symbol}`,
        trade: `https://exchange.gemini.com/trade/${r.symbol.toUpperCase()}`,
      };
    });
  },
  // Bithumb's ALL_KRW ticker is priced in KRW; the same answer carries the
  // USDT-KRW price, which converts everything to USD. Fail if it is missing.
  async bithumb() {
    const d = await getJSON('https://api.bithumb.com/public/ticker/ALL_KRW', { timeout: 25000 });
    if (d.status !== '0000' || !d.data || typeof d.data !== 'object') throw new Error(`bithumb status ${d.status}`);
    const krwPerUsd = n(d.data.USDT?.closing_price);
    if (!krwPerUsd) throw new Error('bithumb USDT-KRW price missing');
    const out = [];
    for (const [b, v] of Object.entries(d.data)) {
      if (b === 'USDT') continue; // conversion rate, not a market: USDT/USDT would pin price at 1
      const base = sym(b);
      if (!base || typeof v !== 'object' || v === null) continue;
      out.push({
        venue: 'bithumb', base, quote: 'USD', price: n(v.closing_price) != null ? n(v.closing_price) / krwPerUsd : null,
        volBase: n(v.units_traded_24H), volQuote: n(v.acc_trade_value_24H) != null ? n(v.acc_trade_value_24H) / krwPerUsd : null,
        change24h: n(v.fluctate_rate_24H),
        api: `https://api.bithumb.com/public/ticker/${b}_KRW`,
        trade: `https://www.bithumb.com/react/trade/order/${b}-KRW`,
      });
    }
    return out;
  },
};
