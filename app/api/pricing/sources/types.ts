// Shared contract every pricing source module implements. Keeping this small and uniform
// is what lets data_source_config drive source selection without code changes per set —
// adding a new source means adding one file here and one row in data_source_config.

export interface PriceLookupInput {
  cardNumber: string
  playerOrSubjectName: string
  setName: string
  manufacturer: string | null
  year: number | null
  configDetails: Record<string, unknown>
}

export interface PriceLookupResult {
  price: number
  source: 'beckett' | 'psa' | 'vcp' | 'ebay'
  /** Raw detail kept for debugging/audit (e.g. matched listing title, URL). Not persisted. */
  matchedOn?: string
}

export interface PricingSource {
  name: PriceLookupResult['source']
  lookup(input: PriceLookupInput): Promise<PriceLookupResult | null>
}
