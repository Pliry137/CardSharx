// PSA (Auction Prices Realized / PSA Price Guide) — secondary source for non-sport sets
// per CardCollector.md (priority 3 behind VCP and eBay, added once those are working).

import type { PriceLookupInput, PriceLookupResult, PricingSource } from './types.js'

async function lookup(input: PriceLookupInput): Promise<PriceLookupResult | null> {
  // TODO: scrape PSA's Auction Prices Realized / Price Guide for a matching card.
  console.warn('[psa] lookup() not yet implemented', input.cardNumber)
  return null
}

export const psaSource: PricingSource = {
  name: 'psa',
  lookup,
}
