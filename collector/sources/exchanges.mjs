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
  gemini: { name: 'Gemini', type: 'Exchange', site: 'https://www.gemini.com' },
};

// Gemini lists stablecoin-quoted pairs too (btcgusd, ethrlusd). Those pair names end in "USD",
// so splitJoined() would keep the stablecoin ticker glued to the base (SOLRLUSD -> base "SOLRL",
// BTCGUSD -> "BTCG") and publish a ticker that does not exist. Match the longest quote first and
// let keep() drop them, so no fabricated base ever reaches the site.
const GEMINI_QUOTES = ['USDT', 'USDC', 'GUSD', 'RLUSD', 'USD'];

function geminiPair(name) {
  const s = String(name || '').toUpperCase();
  for (const q of GEMINI_QUOTES) {
    if (s.endsWith(q) && s.length > q.length) return { base: s.slice(0, -q.length), quote: q };
  }
  return null;
}

let krakenPairs = null, krakenPairsAt = 0;

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
      if (!keep(b, q)) continue;
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
  // Gemini has no bulk ticker that carries volume: one v1/pricefeed call gives every pair with its
  // price and 24h change (already a percent), then each kept pair needs one v1/pubticker call for
  // volume. Fan out in bounded batches. A pair whose pubticker fails keeps a null volume rather
  // than failing the whole read; an answer that is not a list of pairs fails loudly.
  async gemini() {
    const feed = await getJSON('https://api.gemini.com/v1/pricefeed', { timeout: 25000 });
    if (!Array.isArray(feed) || feed.length === 0) throw new Error('gemini bad response');
    const rows = [];
    for (const p of feed) {
      const pair = geminiPair(p?.pair);
      if (!pair) continue;
      const base = sym(pair.base), quote = pair.quote;
      if (!keep(base, quote)) continue; // GUSD/RLUSD and fiat crosses are dropped here
      rows.push({ symbol: String(p.pair).toLowerCase(), base, quote, price: n(p.price), change24h: n(p.percentChange24h) });
    }
    if (!rows.length) throw new Error('gemini no markets');

    const volumes = new Map();
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const r = rows[cursor++];
        try {
          const t = await getJSON(`https://api.gemini.com/v1/pubticker/${r.symbol}`, { timeout: 15000 });
          volumes.set(r.symbol, t && typeof t === 'object' && t.volume ? t.volume : null);
        } catch { volumes.set(r.symbol, null); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, rows.length) }, worker));

    return rows.map(r => {
      const vol = volumes.get(r.symbol) || {};
      return {
        venue: 'gemini', base: r.base, quote: r.quote, price: r.price,
        volBase: n(vol[r.base]), volQuote: n(vol[r.quote]), change24h: r.change24h,
        api: `https://api.gemini.com/v1/pubticker/${r.symbol}`,
        trade: `https://exchange.gemini.com/trade/${r.symbol.toUpperCase()}`,
      };
    });
  },
};
