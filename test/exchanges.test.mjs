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

test('bitfinex: USD/UST spot pairs with volume, change and working links', async () => {
  const urls = fakeFetch(bitfinexFixture());
  const ms = await READERS.bitfinex();
  assert.deepEqual(urls, ['https://api-pub.bitfinex.com/v2/tickers?symbols=ALL']);
  assert.ok(VENUES.bitfinex);
  // BTCUSD, BTCUST, ETHUSD, LINK:USD, LINK:UST. TEST, F0 (perp) and funding rows are all dropped.
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USD', 'BTC/USDT', 'ETH/USD', 'LINK/USD', 'LINK/USDT']);
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
});

test('bitfinex: an empty answer fails the read instead of reporting no markets', async () => {
  fakeFetch([]);
  await assert.rejects(READERS.bitfinex(), /bad response/);
});

test('bitfinex: an error string fails the read', async () => {
  fakeFetch('ERR_UNKNOWN');
  await assert.rejects(READERS.bitfinex(), /bad response/);
});

