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

const geminiPricefeed = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-pricefeed.json', import.meta.url), 'utf8'));
const geminiPubticker = s => JSON.parse(readFileSync(new URL(`./fixtures/gemini-pubticker-${s}.json`, import.meta.url), 'utf8'));

// Gemini: one bulk /v1/pricefeed call for price+change, then one /v1/pubticker per kept pair for
// volume. Stablecoin-quoted (GUSD/RLUSD), fiat-cross and PERP pairs must be dropped so no fake
// base reaches the site.
test('gemini: USD/USDT/USDC spot pairs with price, volume, change and links', async () => {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    let body;
    if (u.includes('/v1/pricefeed')) body = geminiPricefeed();
    else {
      const sym = u.split('/').pop();
      body = geminiPubticker(sym);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const ms = await READERS.gemini();
  assert.ok(VENUES.gemini);
  // pricefeed is the first call; the rest are per-pair pubticker calls.
  assert.equal(urls[0], 'https://api.gemini.com/v1/pricefeed');
  // Only USD/USDT/USDC-quoted coin pairs survive. GUSD/RLUSD quotes, fiat crosses (EURUSD,
  // USDCUSD) and PERP are dropped.
  const pairs = ms.map(m => `${m.base}/${m.quote}`);
  assert.ok(pairs.includes('BTC/USD'), 'btcusd kept');
  assert.ok(pairs.includes('ETH/USD'), 'ethusd kept');
  assert.ok(pairs.includes('ETH/USDC'), 'ethusdc kept');
  assert.ok(pairs.includes('SOL/USD'), 'solusd kept');
  assert.ok(pairs.includes('BTC/USDT'), 'btcusdt kept');
  assert.ok(!pairs.some(p => p.includes('RLUSD') || p.includes('GUSD')), 'no GUSD/RLUSD-quoted pairs');
  assert.ok(!pairs.includes('EUR/USD'), 'fiat cross dropped');
  assert.ok(!pairs.includes('USD/CUSD') && !pairs.includes('USDC/USD'), 'stablecoin-to-stablecoin dropped');
  assert.ok(!ms.some(m => m.quote === 'PERP'), 'perp dropped');

  const btc = ms.find(m => m.base === 'BTC' && m.quote === 'USD');
  assert.equal(btc.venue, 'gemini');
  assert.equal(btc.price, 58962.35);
  assert.equal(btc.volBase, 163.58034345);
  assert.equal(btc.volQuote, 9645081.4636191075);
  // percentChange24h "0.0211" is a fraction -> published as a percent.
  assert.ok(Math.abs(btc.change24h - 2.07) < 1e-9);
  assert.equal(btc.api, 'https://api.gemini.com/v1/pubticker/btcusd');
  assert.equal(btc.trade, 'https://exchange.gemini.com/trade/BTCUSD');

  const ethUsdc = ms.find(m => m.base === 'ETH' && m.quote === 'USDC');
  assert.equal(ethUsdc.volQuote, 1466301.9461752);
  assert.equal(ethUsdc.api, 'https://api.gemini.com/v1/pubticker/ethusdc');
});

test('gemini: a bad pricefeed answer (not a list) fails the read', async () => {
  fakeFetch({ error: 'unavailable' });
  await assert.rejects(READERS.gemini(), /bad response/);
});

test('gemini: an empty pricefeed fails the read', async () => {
  fakeFetch([]);
  await assert.rejects(READERS.gemini(), /bad response/);
});

test('gemini: a pair whose pubticker fails keeps a null volume, not a failed read', async () => {
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/v1/pricefeed')) return new Response(JSON.stringify(geminiPricefeed()), { status: 200 });
    // Every pubticker call errors; the read must still succeed with null volumes.
    return new Response('nope', { status: 500 });
  };
  const ms = await READERS.gemini();
  assert.ok(ms.length > 0);
  assert.ok(ms.every(m => m.volBase === null && m.volQuote === null));
  // price and change still come from the bulk feed.
  const btc = ms.find(m => m.base === 'BTC' && m.quote === 'USD');
  assert.equal(btc.price, 58962.35);
  assert.ok(Math.abs(btc.change24h - 2.07) < 1e-9);
});
