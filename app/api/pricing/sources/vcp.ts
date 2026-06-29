// VCP (Vintage Card Prices) — aggregates eBay historical sold data. Primary source for
// non-sport sets (Desert Storm, etc.) per CardCollector.md — start here since it's the
// most accessible of the non-sport sources.

import type { PriceLookupInput, PriceLookupResult, PricingSource } from './types'

async function lookup(input: PriceLookupInput): Promise<PriceLookupResult | null> {
  // TODO: scrape vintagecardprices.com for a matching card/set and return its aggregated price.
  console.warn('[vcp] lookup() not yet implemented', input.cardNumber)
  return null
}

export const vcpSource: PricingSource = {
  name: 'vcp',
  lookup,
}
