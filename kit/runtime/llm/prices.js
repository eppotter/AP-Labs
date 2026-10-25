'use strict';

// Per-model prices for the spend breaker (AD-11, Story 9.1), in US dollars per
// million tokens. A model the profile names (llm.model, llm.extraction_model)
// must have a row here: boot refuses an unpriced one, and a test checks that
// the defaults in kit/lib/profile are priced.
//
// Each row records its source and the date it was checked. Re-check a row
// against the source before changing it, and update `checked`.
//
// The service never asks for prompt caching, but if a reply reports cache
// tokens they are charged at the row's cache-write and cache-read rates.

const SOURCE = 'https://claude.com/pricing';

const PRICES = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({
    inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.1, source: SOURCE, checked: '2026-10-25',
  }),
  'claude-opus-5-5': Object.freeze({
    inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2, source: SOURCE, checked: '2026-10-25',
  }),
});

function priceOf(model) {
  return typeof model === 'string' && Object.hasOwn(PRICES, model) ? PRICES[model] : null;
}

// Cost in USD of token counts at a model's price. Nothing is rounded down.
function costUsd(price, { input = 0, output = 0, cacheWrite = 0, cacheRead = 0 }) {
  return (input * price.inputPerMTok + output * price.outputPerMTok
    + cacheWrite * price.cacheWritePerMTok + cacheRead * price.cacheReadPerMTok) / 1e6;
}

module.exports = { PRICES, SOURCE, priceOf, costUsd };
