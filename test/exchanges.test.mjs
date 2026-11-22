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

const htxSymbols = () => JSON.parse(readFileSync(new URL('./fixtures/htx-symbols.json', import.meta.url), 'utf8'));
const htxTickers = () => JSON.parse(readFileSync(new URL('./fixtures/htx-tickers.json', import.meta.url), 'utf8'));
const htxMerged = () => JSON.parse(readFileSync(new URL('./fixtures/htx-merged.json', import.meta.url), 'utf8'));

// HTX is asked three different things: the symbol list (which pair is base/quote), the
// bulk tickers (live price and volume) and one detail/merged call per live pair (rolling
// 24h open). Route by URL so the reader is exercised against the real response shapes.
function htxFetch({ symbols = htxSymbols(), tickers = htxTickers(), merged = htxMerged() } = {}) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    if (u.includes('/v1/common/symbols')) return new Response(JSON.stringify(symbols), { status: 200 });
    if (u.includes('/market/tickers')) return new Response(JSON.stringify(tickers), { status: 200 });
    if (u.includes('/market/detail/merged')) {
      const symbol = u.split('symbol=')[1];
      const tick = merged[symbol];
      if (!tick) return new Response(JSON.stringify({ status: 'error', 'err-code': 'invalid-parameter', 'err-msg': 'invalid symbol' }), { status: 200 });
      return new Response(JSON.stringify({ ch: `market.${symbol}.detail.merged`, status: 'ok', ts: 1795344449677, tick }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'error' }), { status: 200 });
  };
  return urls;
}

test('htx: pairs come from the symbol list, 24h change from the rolling window', async () => {
  const urls = htxFetch();
  const ms = await READERS.htx();
  assert.ok(VENUES.htx);
  // Kept: BTC/USDT, ETH/USDC, XRP/USDT. Dropped: ethbtc (not USD-quoted), deadusdt
  // (offline), zigusdt (no volume), and adausdt (no rolling open in the fixture).
  assert.deepEqual(ms.map(m => `${m.base}/${m.quote}`), ['BTC/USDT', 'ETH/USDC', 'XRP/USDT']);
  for (const m of ms) assert.equal(m.venue, 'htx');

  const btc = ms[0];
  assert.equal(btc.price, 59704.11);
  assert.equal(btc.volBase, 4049.094462870142);
  assert.equal(btc.volQuote, 241882596.9383995);
  assert.ok(Math.abs(btc.change24h - (59704.11 / 57977 - 1) * 100) < 1e-9);
  assert.ok(btc.change24h > 0, 'bulk day-open would make this negative');
  assert.ok(Math.abs(((59704.11 / 59941.01) - 1) * 100 - btc.change24h) > 3, 'must not be the day-open value');
  assert.equal(btc.api, 'https://api.huobi.pro/market/detail/merged?symbol=btcusdt');
  assert.equal(btc.trade, 'https://www.htx.com/trade/btc_usdt');
  assert.equal(ms[1].trade, 'https://www.htx.com/trade/eth_usdc');

  assert.equal(urls.filter(u => u.includes('/v1/common/symbols')).length, 1);
  assert.equal(urls.filter(u => u.includes('/market/tickers')).length, 1);
  const details = urls.filter(u => u.includes('/market/detail/merged')).map(u => u.split('symbol=')[1]);
  assert.deepEqual([...new Set(details)].sort(), ['adausdt', 'btcusdt', 'ethusdc', 'xrpusdt']);
});

test('htx: a tickers error answer fails the read instead of returning nothing', async () => {
  htxFetch({ tickers: { status: 'error', 'err-code': 'invalid-parameter', 'err-msg': 'bad request' } });
  await assert.rejects(READERS.htx(), /htx status error/);
});
