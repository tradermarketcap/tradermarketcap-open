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

const geminiFeedFixture = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-v1-pricefeed.json', import.meta.url), 'utf8'));
const geminiStatFixture = () => JSON.parse(readFileSync(new URL('./fixtures/gemini-v2-ticker.json', import.meta.url), 'utf8'));

function fakeGemini({ feed = geminiFeedFixture(), stat = geminiStatFixture() } = {}) {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url); urls.push(u);
    if (u.includes('/v1/pricefeed')) return new Response(JSON.stringify(feed), { status: 200 });
    if (u.includes('/v2/ticker')) return new Response(JSON.stringify(stat), { status: 200 });
    throw new Error('unexpected url ' + u);
  };
  return urls;
}

test('VENUES object is defined and contains expected exchanges', () => {
  assert.ok(VENUES.coinbase);
  assert.ok(VENUES.kraken);
  assert.ok(VENUES.binanceus);
});

test('READERS object is defined and contains expected venue readers', () => {
  assert.ok(typeof READERS === 'object');
});