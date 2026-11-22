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
const cryptocomFixture = () => JSON.parse(readFileSync(new URL('./fixtures/cryptocom-tickers.json', import.meta.url), 'utf8'));

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
