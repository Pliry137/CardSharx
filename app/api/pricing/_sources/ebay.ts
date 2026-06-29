// eBay sold listings — direct source for non-sport sets, used alongside VCP per
// CardCollector.md. Noisier than Beckett/VCP aggregates (condition, seller, timing
// variance) so this is a fallback rather than primary for anything with a better source.

import type { PriceLookupInput, PriceLookupResult, PricingSource } from './types.js'

async function lookup(input: PriceLookupInput): Promise<PriceLookupResult | null> {
  // TODO: query eBay sold listings (scrape or eBay's Finding/Browse API if available) and
  // average/median the matching sold prices for this card.
  console.warn('[ebay] lookup() not yet implemented', input.cardNumber)
  return null
}

export const ebaySource: PricingSource = {
  name: 'ebay',
  lookup,
}
