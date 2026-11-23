// Exchange readers, checked offline: fetch is swapped for a saved copy of the real response shape.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { READERS, VENUES } from '../collector/sources/exchanges.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Answer every request with this body, and remember which URLs were asked for.
function fakeFetch(body) {
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return new Response(JSON.stringify(body), { status: 200 }); };
  return urls;
}

const bybitFixture = () => JSON.parse(readFileSync(new URL('./fixtures/bybit-spot-tickers.json', import.meta.url), 'utf8'));
const bitgetFixture = () => JSON.parse(readFileSync(new URL('./fixtures/bitget-spot-tickers.json', import.meta.url), 'utf8'));
const bitfinexFixture = () => JSON.parse(readFileSync(new URL('./fixtures/bitfinex-tickers.json', import.meta.url), 'utf8'));
const bitfinexSym = () => JSON.parse(readFileSync(new URL('./fixtures/bitfinex-sym.json', import.meta.url), 'utf8'));
const bitfinexLabel = () => JSON.parse(readFileSync(new URL('./fixtures/bitfinex-label.json', import.meta.url), 'utf8'));
const bitfinexExplorer = () => JSON.parse(readFileSync(new URL('./fixtures/bitfinex-explorer.json', import.meta.url), 'utf8'));

// The Bitfinex reader reads three currency maps plus the tickers. Answer each by URL.
function fakeBitfinex({ tickers = bitfinexFixture(), sym = bitfinexSym(), label = bitfinexLabel(), explorer = bitfinexExplorer() } = {}) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url); urls.push(u);
    if (u.includes('pub:map:currency:sym')) return new Response(JSON.stringify(sym), { status: 200 });
    if (u.includes('pub:map:currency:label')) return new Response(JSON.stringify(label), { status: 200 });
    if (u.includes('pub:map:currency:explorer')) return new Response(JSON.stringify(explorer), { status: 200 });
    if (u.includes('symbols=ALL')) return new Response(JSON.stringify(tickers), { status: 200 });
    throw new Error('unexpected url ' + u);
  };
  return urls;
}

const geminiFeedFixture = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-pricefeed.json', import.meta.url), 'utf8'));
const cryptocomFixture = () => JSON.parse(readFileSync(new URL('./fixtures/cryptocom-tickers.json', import.meta.url), 'utf8'));
const bithumbFixture = () => JSON.parse(readFileSync(new URL('./fixtures/bithumb-tickers-krw.json', import.meta.url), 'utf8'));

test('bybit: USD-quoted spot pairs with volume, change and links', async () => {
  const urls = fakeFetch(bybitFixture());
  const ms = await READERS.bybit();
  assert.deepEqual(urls, ['https://api.bybit.com/v5/market/tickers?category=spot']);
  assert.ok(VENUES.bybit);
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC']);
  const btc = ms[0];
  assert.equal(btc.venue, 'bybit');
  assert.equal(btc.price, 97000.15);
  assert.equal(btc.volBase, 10000.5);
  assert.equal(btc.volQuote, 970001500.5);
  assert.ok(Math.abs(btc.change24h - 2.11) < 1e-9);
  assert.equal(btc.api, 'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT');
  assert.equal(btc.trade, 'https://www.bybit.com/en/trade/spot/BTC/USDT');
  assert.ok(ms[1].change24h < 0);
});

test('bybit: an error answer (retCode not 0) fails the read', async () => {
  fakeFetch({ retCode: 10001, retMsg: 'params error', result: {} });
  await assert.rejects(READERS.bybit(), /retCode 10001/);
});

test('bitget: USD-quoted spot pairs with volume, change and links', async () => {
  const urls = fakeFetch(bitgetFixture());
  const ms = await READERS.bitget();
  assert.deepEqual(urls, ['https://api.bitget.com/api/v2/spot/market/tickers']);
  assert.ok(VENUES.bitget);
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC']);
  const btc = ms[0];
  assert.equal(btc.venue, 'bitget');
  assert.equal(btc.price, 97000.15);
  assert.equal(btc.volBase, 10000.5);
  assert.equal(btc.volQuote, 970001500.5);
  assert.ok(Math.abs(btc.change24h - 2.11) < 1e-9);
  assert.equal(btc.api, 'https://api.bitget.com/api/v2/spot/market/tickers?symbol=BTCUSDT');
  assert.equal(btc.trade, 'https://www.bitget.com/spot/BTCUSDT');
  assert.ok(ms[1].change24h < 0);
});

test('bitget: an error answer (code not 00000) fails the read', async () => {
  fakeFetch({ code: '40017', msg: 'params error', data: [] });
  await assert.rejects(READERS.bitget(), /code 40017/);
});


test('cryptocom: USD-quoted spot pairs with volume, change and links', async () => {
  const urls = fakeFetch(cryptocomFixture());
  const ms = await READERS.cryptocom();
  assert.deepEqual(urls, ['https://api.crypto.com/exchange/v1/public/get-tickers']);
  assert.ok(VENUES.cryptocom);
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC']);
  const btc = ms[0];
  assert.equal(btc.venue, 'cryptocom');
  assert.equal(btc.price, 59969.17);
  assert.equal(btc.volBase, 6051.3088);
  assert.equal(btc.volQuote, 352287263.51);
  assert.ok(Math.abs(btc.change24h - 0.5) < 1e-9);
  assert.equal(btc.api, 'https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=BTC_USDT');
  assert.equal(btc.trade, 'https://crypto.com/exchange/trade/btc_usdt');
  assert.ok(ms[1].change24h < 0);
});

test('cryptocom: an error answer (code not 0) fails the read', async () => {
  fakeFetch({ id: 1, method: 'public/get-tickers', code: 40001, result: {} });
  await assert.rejects(READERS.cryptocom(), /code 40001/);
});

const upbitFixture = () => JSON.parse(readFileSync(new URL('./fixtures/upbit-tickers.json', import.meta.url), 'utf8'));
const upbitMarkets = () => JSON.parse(readFileSync(new URL('./fixtures/upbit-markets.json', import.meta.url), 'utf8'));

test('upbit: USDT-quoted pairs only, QUOTE-BASE market names', async () => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    const body = String(url).includes('/v1/market/all') ? upbitMarkets() : upbitFixture();
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const ms = await READERS.upbit();
  assert.deepEqual(urls, ['https://api.upbit.com/v1/market/all', 'https://api.upbit.com/v1/ticker?markets=USDT-BTC,USDT-ETH']);
  assert.ok(VENUES.upbit);
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDT']);
  const btc = ms[0];
  assert.equal(btc.venue, 'upbit');
  assert.equal(btc.price, 60060.93);
  assert.equal(btc.volBase, 25.39508369);
  assert.equal(btc.volQuote, 1480913.05354522);
  assert.ok(Math.abs(btc.change24h - 1.77572678) < 1e-9);
  assert.equal(btc.api, 'https://api.upbit.com/v1/ticker?markets=USDT-BTC');
  assert.equal(btc.trade, 'https://upbit.com/exchange?code=CRIX.UPBIT.USDT-BTC');
});

test('upbit: an empty market list fails the read', async () => {
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/v1/market/all') ? [] : []), { status: 200 });
  await assert.rejects(READERS.upbit(), /no USDT markets/);
});

test('bitfinex: USD/UST spot pairs with volume, change and working links', async () => {
  const urls = fakeBitfinex();
  const ms = await READERS.bitfinex();
  assert.ok(urls.some(u => u.includes('symbols=ALL')));
  assert.ok(VENUES.bitfinex);
  // BTCUSD, BTCUST, ETHUSD, LINK:USD, LINK:UST. TEST, F0 (perp) and funding rows are all dropped,
  // the non-crypto rows (CH100) and the fiat cross (EURUSD) are dropped, and Bitfinex's own codes
  // are translated: UDC -> USDC, WBT (their Wrapped Bitcoin) -> WBTC, WHBT (WhiteBIT) -> WBT.
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`),
    ['BTC/USD', 'BTC/USDT', 'ETH/USD', 'LINK/USD', 'LINK/USDT', 'USDC/USD', 'WBTC/USD', 'WBT/USDT']);
  const btc = ms[0];
  assert.equal(btc.venue, 'bitfinex');
  assert.equal(btc.price, 60239);
  assert.equal(btc.volBase, 4409.89249778);
  assert.ok(Math.abs(btc.volQuote - 4409.89249778 * 60239) < 1e-6);
  assert.ok(Math.abs(btc.change24h - 1.180798) < 1e-9);
  // Links must resolve: the single-pair ticker is a query, and trades live on trading.bitfinex.com.
  assert.equal(btc.api, 'https://api-pub.bitfinex.com/v2/tickers?symbols=tBTCUSD');
  assert.equal(btc.trade, 'https://trading.bitfinex.com/t/BTC:USD');
  assert.ok(ms[1].change24h > 0);
  assert.ok(ms[2].change24h < 0);
  // A colon symbol keeps its quote in the trade link, and UST is reported as USDT.
  assert.equal(ms[3].base, 'LINK');
  assert.equal(ms[3].trade, 'https://trading.bitfinex.com/t/LINK:USD');
  assert.equal(ms[4].quote, 'USDT');
  assert.equal(ms[4].trade, 'https://trading.bitfinex.com/t/LINK:UST');
  // The translated ticker must not change the trade link: Bitfinex still calls WBTC "WBT".
  const wbtc = ms.find(m => m.base === 'WBTC');
  assert.equal(wbtc.trade, 'https://trading.bitfinex.com/t/WBT:USD');
  // UST is Tether USDt, never TerraUSD, and WBT is WhiteBIT Token, never Wrapped Bitcoin.
  assert.ok(!ms.some(m => m.base === 'UST'), 'UST must be published as USDT');
  assert.equal(ms.find(m => m.base === 'WBT').base, 'WBT');
  // No non-crypto row may survive: these are tokenized notes/securities in Bitfinex's own label map.
  for (const bad of ['CH100', 'ALT2612', 'TITAN1', 'CMSTR', 'USTBL', 'ALKN', 'EUR']) {
    assert.ok(!ms.some(m => m.base === bad), `non-crypto row ${bad} leaked`);
  }
});

test('bitfinex: an empty answer fails the read instead of reporting no markets', async () => {
  fakeBitfinex({ tickers: [] });
  await assert.rejects(READERS.bitfinex(), /bad response/);
});

test('bitfinex: an error string fails the read', async () => {
  fakeBitfinex({ tickers: 'ERR_UNKNOWN' });
  await assert.rejects(READERS.bitfinex(), /bad response/);
});

test('bitfinex: a real coin with no label but a chain (XRP) is kept, not treated as a note', async () => {
  const tickers = [...bitfinexFixture(), ['tXRPUSD', 2.1, 1e6, 2.11, 1e6, 0.01, 0.0048, 2.105, 2078889.64, 2.2, 2.0, 1358182043000]];
  fakeBitfinex({ tickers });
  const ms = await READERS.bitfinex();
  const xrp = ms.find(m => m.base === 'XRP');
  assert.ok(xrp, 'XRP must survive the non-crypto filter');
  assert.equal(xrp.quote, 'USD');
  assert.ok(xrp.price > 0);
});


const htxSymbols = () => JSON.parse(readFileSync(new URL('./fixtures/htx-symbols.json', import.meta.url), 'utf8'));
const htxTickers = () => JSON.parse(readFileSync(new URL('./fixtures/htx-tickers.json', import.meta.url), 'utf8'));
const htxMerged = () => JSON.parse(readFileSync(new URL('./fixtures/htx-merged.json', import.meta.url), 'utf8'));

// HTX is asked three different things: the symbol list (which pair is base/quote), the
// bulk tickers (live price and volume) and one detail/merged call per pair (rolling 24h
// open). Route by URL so the reader is exercised against the real response shapes.
function htxFetch({ merged = htxMerged(), tickers = htxTickers() } = {}) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/v1/common/symbols')) return new Response(JSON.stringify(htxSymbols()), { status: 200 });
    if (u.includes('/market/tickers')) return new Response(JSON.stringify(tickers), { status: 200 });
    const symbol = u.split('symbol=')[1];
    const tick = merged[symbol];
    if (!tick) return new Response(JSON.stringify({ status: 'error', 'err-code': 'invalid-parameter', 'err-msg': 'invalid symbol' }), { status: 200 });
    return new Response(JSON.stringify({ ch: `market.${symbol}.detail.merged`, status: 'ok', ts: 1795337404798, tick }), { status: 200 });
  };
  return urls;
}

test('htx: pairs come from the symbol list, 24h change from the rolling window', async () => {
  const urls = htxFetch();
  const ms = await READERS.htx();
  assert.ok(VENUES.htx);
  // Kept: BTC/USDT, ETH/USDC, XRP/USDT. Dropped: ethbtc (not USD-quoted), adausdt (no
  // rolling open in the fixture), deadusdt (offline), zigusdt and trx3susdt (no volume),
  // and the Chinese-named pair (not printable ASCII, so it cannot render as a ticker).
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC', 'XRP/USDT']);
  assert.ok(!ms.some(m => m.base === 'ADA'), 'a pair with no rolling open must be dropped');
  for (const m of ms) assert.equal(m.venue, 'htx');

  // change24h must come from detail/merged (rolling 24h), never from the bulk `open`,
  // which is the natural-day candle in UTC+8 and gives the opposite sign for BTC here.
  const btc = ms[0];
  assert.equal(btc.price, 59704.11);
  assert.equal(btc.volBase, 4050.4393042501415);
  assert.equal(btc.volQuote, 241960691.34610906);
  assert.ok(Math.abs(btc.change24h - 2.9789571727) < 1e-9);
  assert.ok(btc.change24h > 0, 'bulk open would make this negative');
  assert.ok(Math.abs(((59704.11 / 59941.01) - 1) * 100 - btc.change24h) > 3, 'must not be the day-open value');

  // The api link is the per-pair rolling 24h source, and the trade link is in the pair's
  // own case, which is what HTX routes (btc_usdt, not BTC_USDT).
  assert.equal(btc.api, 'https://api.huobi.pro/market/detail/merged?symbol=btcusdt');
  assert.equal(btc.trade, 'https://www.htx.com/trade/btc_usdt');
  assert.equal(ms[1].trade, 'https://www.htx.com/trade/eth_usdc');

  // One symbol-list read, one bulk read, and one detail call per live pair (a pair whose
  // read fails is retried once, which is why the set is compared rather than the count).
  assert.equal(urls.filter(u => u.includes('/v1/common/symbols')).length, 1);
  assert.equal(urls.filter(u => u.includes('/market/tickers')).length, 1);
  const details = urls.filter(u => u.includes('/market/detail/merged')).map(u => u.split('symbol=')[1]);
  assert.deepEqual([...new Set(details)].sort(), ['adausdt', 'btcusdt', 'ethusdc', 'xrpusdt']);
});

test('htx: a tickers error answer fails the read instead of returning nothing', async () => {
  htxFetch({ tickers: { status: 'error', 'err-code': 'invalid-parameter', 'err-msg': 'bad request' } });
  await assert.rejects(READERS.htx(), /htx status error/);
});

test('htx: an unreadable rolling open drops the pair rather than guessing a change', async () => {
  // xrpusdt and adausdt have no detail/merged answer: neither may be published with a
  // made-up change, and the rest must still come through. Load a fresh module instance so
  // the previous test's rolling-open cache does not stand in for a live read.
  const fresh = await import(`../collector/sources/exchanges.mjs?unreadable=${Date.now()}`);
  const partial = htxMerged();
  delete partial.xrpusdt;
  htxFetch({ merged: partial });
  const ms = await fresh.READERS.htx();
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC']);
  for (const m of ms) assert.ok(Number.isFinite(m.change24h));
});


// Gemini answers v1/pricefeed with [{pair, price, percentChange24h}] and v1/pubticker per symbol
// with {last, volume: {BASE: .., QUOTE: ..}}. The stablecoin pairs are the trap: their names end in
// "USD", so a naive suffix match turns SOLRLUSD into base "SOLRL" and BTCGUSD into "BTCG".
test('gemini: stablecoin-quoted pairs are dropped, not given a fabricated base', async () => {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url); urls.push(u);
    if (u === 'https://api.gemini.com/v1/pricefeed') return new Response(JSON.stringify(geminiFeedFixture()), { status: 200 });
    const m = u.match(/\/v1\/pubticker\/([a-z0-9]+)$/);
    if (!m) throw new Error('unexpected url ' + u);
    const volume = { btc: '221.237407', usd: '13113017.65', eth: '940.5', usdt: '1590000', sol: '5210.9', usdc: '360100' };
    return new Response(JSON.stringify({ last: '1', volume }), { status: 200 });
  };
  const ms = await READERS.gemini();
  assert.equal(urls[0], 'https://api.gemini.com/v1/pricefeed');
  assert.ok(VENUES.gemini);
  // Only genuinely USD/USDT/USDC-quoted pairs survive; the GUSD/RLUSD pairs are dropped rather
  // than given a fabricated base, and fiat crosses (EUR/USD, AUD/USDC) are dropped because their
  // base is a currency, not a coin.
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USD', 'ETH/USDT', 'SOL/USDC']);
  // No live pair may carry a base that is another ticker glued to a stablecoin name.
  for (const m of ms) assert.ok(!/^(SOLRL|ETHRL|BTCG|MONG|DRIFTRL)$/.test(m.base), `fabricated base ${m.base}`);
});

test('gemini: percentChange24h is a fraction in the feed and is published as a percent', async () => {
  // v1/pricefeed said 0.0160 for BTCUSD while v2/ticker showed open 58300 close 59222.81 = +1.58%.
  globalThis.fetch = async url => {
    const u = String(url);
    if (u === 'https://api.gemini.com/v1/pricefeed') return new Response(JSON.stringify(geminiFeedFixture()), { status: 200 });
    return new Response(JSON.stringify({ last: '1', volume: { btc: '1', usd: '1' } }), { status: 200 });
  };
  const ms = await READERS.gemini();
  const btc = ms.find(m => m.base === 'BTC' && m.quote === 'USD');
  assert.equal(btc.change24h, 1.6); // 0.0160 * 100, not 0.0160
  assert.equal(btc.price, 59222.81);
});

test('gemini: a non-list answer fails the read instead of reporting no markets', async () => {
  fakeFetch({ result: 'error', reason: 'RateLimit' });
  await assert.rejects(READERS.gemini(), /bad response/);
});

test('htx: leveraged tokens are dropped even when they trade', async () => {
  const fresh = await import(`../collector/sources/exchanges.mjs?leveraged=${Date.now()}`);
  const tick = { open: 1, close: 1.1 };
  const pair = b => ({ symbol: b + 'usdt', 'base-currency': b, 'quote-currency': 'usdt', state: 'online' });
  globalThis.fetch = async url => {
    const u = String(url);
    const body = u.includes('/v1/common/symbols') ? { status: 'ok', data: ['btc', 'trx3l', 'trx3s'].map(pair) }
      : u.includes('/market/tickers') ? { status: 'ok', data: ['btc', 'trx3l', 'trx3s'].map(b => ({ symbol: b + 'usdt', close: 1.1, open: 1, amount: 5, vol: 5.5 })) }
      : { status: 'ok', tick };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  assert.deepEqual((await fresh.READERS.htx()).map(m => m.base), ['BTC']);
});

test('gemini: volume calls stay under the limit and a shared book is counted once', async () => {
  const fresh = await import(`../collector/sources/exchanges.mjs?volumes=${Date.now()}`);
  const feed = ['BTCUSD', 'BTCUSDC'].map(pair => ({ pair, price: '100', percentChange24h: '0.01' }));
  for (let i = 0; i < 40; i++) feed.push({ pair: `AA${i}USD`, price: '1', percentChange24h: '0' });
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify(String(url).endsWith('/pricefeed') ? feed : { last: '100', volume: { BTC: '7', USD: '700', USDC: '700' } }), { status: 200 });
  };
  const ms = await fresh.READERS.gemini();
  const tickers = () => urls.filter(u => u.includes('/pubticker/'));
  assert.equal(tickers().length, 15);
  assert.equal(ms.find(m => m.base === 'BTC' && m.quote === 'USD').volBase, 7);
  assert.equal(ms.find(m => m.base === 'BTC' && m.quote === 'USDC').volBase, null);
  assert.ok(!tickers().some(u => u.endsWith('/btcusdc')));
  await fresh.READERS.gemini();
  assert.equal(tickers().length, 15); // straight after, the cache answers
});

test('binance.us: pairs with frozen 24h figures (delisted or halted) are not markets', async () => {
  const row = (symbol, closeTime) => ({ symbol, lastPrice: '2', volume: '5', quoteVolume: '10', priceChangePercent: '1', closeTime });
  fakeFetch([row('BTCUSDT', Date.now()), row('BUSDUSDT', Date.now() - 3 * 864e5)]);
  assert.deepEqual((await READERS.binanceus()).map(m => m.base), ['BTC']);
});


test('bithumb: KRW tickers converted to USD via USDT-KRW, with volume, change and links', async () => {
  const urls = fakeFetch(bithumbFixture());
  const ms = await READERS.bithumb();
  assert.deepEqual(urls, ['https://api.bithumb.com/public/ticker/ALL_KRW']);
  assert.ok(VENUES.bithumb);
  const btc = ms.find(m => m.base === 'BTC');
  assert.equal(btc.venue, 'bithumb');
  assert.equal(btc.quote, 'USD');
  assert.ok(Math.abs(btc.price - 82009000 / 1368) < 1e-6);
  assert.equal(btc.volBase, 1883.70602528);
  assert.ok(Math.abs(btc.volQuote - 150596349693.27003 / 1368) < 1e-3);
  assert.equal(btc.change24h, 0.31);
  assert.equal(btc.api, 'https://api.bithumb.com/public/ticker/BTC_KRW');
  assert.equal(btc.trade, 'https://www.bithumb.com/react/trade/order/BTC-KRW');
  // USDT is the conversion rate, not a market; it must not emit a USDT/USD row pinned at ~1.
  assert.ok(ms.every(m => m.base !== 'USDT'));
});

test('bithumb: a missing USDT-KRW price fails the read', async () => {
  const f = bithumbFixture();
  delete f.data.USDT;
  fakeFetch(f);
  await assert.rejects(READERS.bithumb(), /USDT-KRW/);
});

test('bithumb: an error answer (status not 0000) fails the read', async () => {
  fakeFetch({ status: '0001', data: {} });
  await assert.rejects(READERS.bithumb(), /status 0001/);
});
