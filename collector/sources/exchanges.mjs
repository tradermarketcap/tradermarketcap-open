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
  cryptocom: { name: 'Crypto.com Exchange', type: 'Exchange', site: 'https://crypto.com/exchange' },
  upbit: { name: 'Upbit', type: 'Exchange', site: 'https://upbit.com' },
  htx: { name: 'HTX', type: 'Exchange', site: 'https://www.htx.com' },
};

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
  // HTX answers {"status":"ok","data":[...]} with lowercase symbols; amount is base
  // volume, vol is quote volume. change24h derived from open -> close.
  async htx() {
    const d = await getJSON('https://api.htx.com/market/tickers', { timeout: 25000 });
    if (d.status !== 'ok') throw new Error(`htx status ${d.status}`);
    const out = [];
    for (const v of d.data || []) {
      const [b, q] = splitJoined(String(v.symbol).toUpperCase().replace(/[-_:]/g, ''));
      if (!keep(b, q)) continue;
      const price = n(v.close), open = n(v.open);
      out.push({
        venue: 'htx', base: b, quote: q, price, volBase: n(v.amount), volQuote: n(v.vol),
        change24h: price && open ? (price / open - 1) * 100 : null,
        api: `https://api.htx.com/market/detail/merged?symbol=${v.symbol}`,
        trade: `https://www.htx.com/trade/${b.toLowerCase()}_${q.toLowerCase()}`,
      });
    }
    return out;
  },
};
