// Generates a full checklist (card_number -> player/subject name) for a sport/year/
// manufacturer Claude doesn't already have bundled, using Claude's own trained knowledge
// of widely-documented card sets — not live scraping. Scraping checklist sites (TCDB,
// Beckett, etc.) was ruled out: their Terms of Use explicitly forbid automated data
// extraction (see CardCollector.md Backlog for the investigation). Vintage set checklists
// are extremely well-documented, repeated-everywhere public information, which is a much
// lower-risk profile than scraping a proprietary price guide.
//
// Called by api/checklist-lookup.ts on the first scan of a never-seen set; the result gets
// cached in Supabase (generated_checklists / generated_checklist_entries, via
// generatedChecklistStore.ts) so this — relatively slow and not free — call only ever runs
// once per set.
//
// Caveat: this is knowledge-based, not verified against a source. Claude can be wrong
// about obscure inserts/variations/numbering quirks, so results are always cached with
// verified = false and surfaced to Joe as "please double-check" in Capture.tsx.
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-6'

const SYSTEM_PROMPT = `You are an expert trading card hobby historian. You will be given a sport, year, and manufacturer for a specific base card set. Provide its full official checklist: card number mapped to the player or subject's name, exactly as it would appear printed on the card.

Rules:
- Cover every card number from 1 up to the base set's known total card count.
- Use your trained knowledge only. Do not fabricate plausible-sounding names — if you are not confident of a specific card number's name, omit that number from "names" entirely rather than guessing.
- Card numbers are strings exactly as printed (e.g. "1", "42B" for a lettered variation) — stick to the base set's standard numbering, not separate insert/parallel subsets, unless the year/manufacturer given IS that insert set.
- "total_card_count" should be the actual known size of the base set, not just the count of names you're confident about.

Write the line FINAL JSON: followed by ONLY valid JSON (no markdown fences, no commentary) matching this shape:
{
  "total_card_count": number,
  "names": { "<card_number>": "<player or subject name>", ... }
}`

function extractJson(raw: string): unknown {
  const markerIndex = raw.search(/FINAL JSON:?/i)
  let cleaned = (markerIndex !== -1 ? raw.slice(markerIndex).replace(/FINAL JSON:?/i, '') : raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  const firstBrace = cleaned.indexOf('{')
  const lastBrace = cleaned.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1)
  }

  try {
    return JSON.parse(cleaned)
  } catch (err) {
    const snippet = cleaned.length > 1500 ? `${cleaned.slice(0, 700)} ...[${cleaned.length} chars total]... ${cleaned.slice(-700)}` : cleaned
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse Claude's checklist response as JSON (${reason}). Raw response: ${snippet}`)
  }
}

export interface GeneratedChecklist {
  total_card_count: number
  names: Record<string, string>
}

function isGeneratedChecklistShape(value: unknown): value is { total_card_count?: number; names?: Record<string, string> } {
  return !!value && typeof value === 'object' && 'names' in value
}

export async function generateChecklist(input: {
  sport: string
  year: number
  manufacturer: string
}): Promise<GeneratedChecklist> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to the Vercel project env vars')
  }

  const client = new Anthropic({ apiKey })

  // Large base sets (700+ cards) need generous output room — a low cap would silently
  // truncate the JSON mid-object and fail to parse.
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Set: ${input.year} ${input.manufacturer} ${input.sport}. Give the full base-set checklist, following the schema in your system instructions exactly.`,
      },
    ],
  })

  const textBlock = message.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude did not return a text response')
  }

  const parsed = extractJson(textBlock.text)
  if (!isGeneratedChecklistShape(parsed)) {
    throw new Error("Claude's response was missing the expected checklist fields")
  }

  const names = parsed.names ?? {}
  return {
    total_card_count: typeof parsed.total_card_count === 'number' ? parsed.total_card_count : Object.keys(names).length,
    names,
  }
}
