// Shared core of the scan-reading pipeline: header-field OCR (Claude vision, for the
// handwritten/typed Year/Company/owner/total-count fields) + deterministic grid OMR
// (api/lib/checklistOmr.ts, for the 660+-cell marked/blank grid). Used by both:
//   - api/vision-capture.ts — the original single-shot endpoint (one image/PDF in,
//     one set's worth of cards out)
//   - api/scan-batch-page.ts — processes one page of a multi-page scan batch, reusing
//     this exact same logic per page
//
// Splitting this out means both endpoints stay behaviorally identical (no risk of the
// batch flow drifting from the single-shot flow) and any future change to the
// header-OCR prompt or grid-OMR call only has to happen in one place.
import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { buildCardsFromGrid } from './standardChecklistGrid.js'
import { readGridFromImage } from './checklistOmr.js'

// Vision-capable Claude model, used only for header-field OCR — a much smaller/
// cheaper task than full-grid reading, so Haiku's accuracy is plenty.
const MODEL = 'claude-haiku-4-5-20251001'

const HEADER_SYSTEM_PROMPT = `You are looking at a "Sports Card Inventory Checklist" sheet. Ignore the grid of numbered cells entirely — another part of the system reads that. Your only job is the handwritten/typed header fields near the top of the sheet:
- "Year"
- "Company" (manufacturer)
- Any handwritten owner name (often initials or a first name in a corner)
- Any handwritten note giving the set's total card count (e.g. "660 total cards")

Any of these can be missing — use null rather than guessing.

Write the line FINAL JSON: followed by ONLY valid JSON (no markdown fences, no commentary) matching this shape:
{
  "year": number | null,
  "manufacturer": string | null,
  "owner_name": string | null,
  "owner_confidence": number,
  "total_card_count": number | null
}`

export type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export function normalizeMediaType(mimeType: string | null): AnthropicImageMediaType {
  if (mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp') {
    return mimeType
  }
  return 'image/jpeg'
}

// Anthropic caps inline image uploads at 10MB and downsamples anything over ~1568px
// on the long edge anyway, so a full 300-DPI scan (often 2500x3300+, 10-15MB as PNG)
// is both rejected outright and wasted resolution. The grid OMR still reads the
// full-res buffer directly — only this copy, sent to Claude for header-field OCR,
// needs shrinking.
const VISION_MAX_DIMENSION = 1568

export async function shrinkForVisionApi(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: VISION_MAX_DIMENSION, height: VISION_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
}

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
    throw new Error(`Could not parse Claude's response as JSON (${reason}). Raw response: ${snippet}`)
  }
}

interface HeaderExtraction {
  year: number | null
  manufacturer: string | null
  owner_name: string | null
  owner_confidence: number
  total_card_count: number | null
}

function isHeaderExtraction(value: unknown): value is HeaderExtraction {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return 'year' in v && 'manufacturer' in v
}

export async function readHeaderFields(image: {
  buffer: Buffer
  mimeType: AnthropicImageMediaType
}): Promise<HeaderExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to the Vercel project env vars')
  }

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: HEADER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.buffer.toString('base64') } },
          { type: 'text', text: 'Read the header fields from this sheet, following the schema in your system instructions exactly.' },
        ],
      },
    ],
  })

  const textBlock = message.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude did not return a text response')
  }

  const parsed = extractJson(textBlock.text)
  if (!isHeaderExtraction(parsed)) {
    throw new Error("Claude's response was missing the expected header fields")
  }
  return parsed
}

export interface VisionPipelineResult {
  detected_set_name: string | null
  detected_set_confidence: number
  manufacturer: string | null
  year: number | null
  owner_name: string | null
  owner_confidence: number
  cards: Array<{
    card_number: string
    player_or_subject_name: string
    presence_confidence: number
    owned: boolean
  }>
}

/**
 * Runs header-field OCR (Claude vision) and grid OMR (deterministic, local) on a
 * single decoded raster image of one checklist sheet, concurrently since they're
 * independent, and assembles the same response shape the rest of the app expects.
 *
 * @param imageBuffer Full-resolution decoded raster image (PNG/JPEG) of one sheet.
 * @param mimeType Media type of imageBuffer, for the Claude vision call.
 */
export async function runVisionPipeline(
  imageBuffer: Buffer,
  mimeType: AnthropicImageMediaType,
): Promise<VisionPipelineResult> {
  const visionCopy = await shrinkForVisionApi(imageBuffer)

  const [header, grid] = await Promise.all([
    readHeaderFields({ buffer: visionCopy, mimeType: 'image/png' }),
    readGridFromImage(imageBuffer, null),
  ])

  const cards = buildCardsFromGrid(grid.rows, header.total_card_count, grid.uncertain_cells)

  return {
    detected_set_name: null,
    detected_set_confidence: header.year && header.manufacturer ? 0.9 : 0,
    manufacturer: header.manufacturer,
    year: header.year,
    owner_name: header.owner_name,
    owner_confidence: header.owner_confidence,
    cards,
  }
}
