// Beckett scraper — primary pricing source for baseball/football/basketball per
// data_source_config. Beckett has no public API, so this is a point-in-time HTML scrape,
// same architecture as the DiveMeets scraper (Dive In project): fetch -> parse -> return.
//
// NOTE (see CardCollector.md "Open Considerations"): Beckett has pursued legal action over
// scraping/reuse of its data (e.g. vs. COMC). This scraper is intended for ad hoc, low
// frequency, personal-use lookups only — not scheduled, not bulk, not redistributed. Review
// Beckett's current Terms of Service before wiring this up for real use.

import type { PriceLookupInput, PriceLookupResult, PricingSource } from './types'

async function lookup(input: PriceLookupInput): Promise<PriceLookupResult | null> {
  // TODO: real implementation —
  // 1. Build the Beckett search/lookup URL from input.setName + input.cardNumber
  //    (config_details.base_url / config_details.selectors come from data_source_config).
  // 2. Fetch the page (respect robots.txt / rate-limit — this is ad hoc, not scheduled).
  // 3. Parse the price out of the HTML with the configured selector.
  // 4. Return { price, source: 'beckett', matchedOn: <matched listing/card text> }.
  console.warn('[beckett] lookup() not yet implemented', input.cardNumber)
  return null
}

export const beckettSource: PricingSource = {
  name: 'beckett',
  lookup,
}
