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
const geminiFeedFixture = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-pricefeed.json', import.meta.url), 'utf8'));
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
