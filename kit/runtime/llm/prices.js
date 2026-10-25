'use strict';

// Per-model prices for the spend breaker (AD-11, Story 9.1), in US dollars per
// million tokens. A model the profile names (llm.model, llm.extraction_model)
// must have a row here: boot refuses an unpriced one, and a test checks that
// the defaults in kit/lib/profile are priced.
//
// Source: Anthropic's API pricing page, https://www.anthropic.com/pricing
// Checked: NOT YET. The values below are PLACEHOLDERS written on 2026-10-25 by
// a build agent with no web access (the previous Sonnet and Opus generations'
// list prices). Check each against the pricing page and set `checked` to that
// date (YYYY-MM-DD) before this ships. `checked: null` marks a row unverified.

const PRICES = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ inputPerMTok: 3, outputPerMTok: 15, checked: null }),
  'claude-opus-5-5': Object.freeze({ inputPerMTok: 5, outputPerMTok: 25, checked: null }),
});

// The service never asks for prompt caching, but if a reply reports cache
// tokens they are charged at this multiple of the input price (at least the
// highest cache-write rate), never at less.
const CACHE_MULTIPLIER = 2;

function priceOf(model) {
  return typeof model === 'string' && Object.hasOwn(PRICES, model) ? PRICES[model] : null;
}

// Cost in USD of token counts at a model's price. Nothing is rounded down.
function costUsd(price, { input = 0, output = 0 }) {
  return (input * price.inputPerMTok + output * price.outputPerMTok) / 1e6;
}

module.exports = { PRICES, CACHE_MULTIPLIER, priceOf, costUsd };
