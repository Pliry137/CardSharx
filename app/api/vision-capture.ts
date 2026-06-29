// Vercel serverless function: POST /api/vision-capture
//
// Accepts a multipart form upload with an `image` field — a photo of one
// "Sports Card Inventory Checklist" sheet, the single fixed template Joe uses for
// every set (confirmed: same physical form every time, see api/lib/standardChecklistGrid.ts).
// Sends it to Claude, which reads the header fields and reports the marked/blank grid
// as compact per-row bitstrings; the server then converts that into the full per-card
// list using the template's known fixed geometry (no need for Claude to read the tiny
// printed card numbers at all — far cheaper and more accurate than asking it to
// transcribe every card as its own JSON object).
//
// Requires ANTHROPIC_API_KEY to be set in the Vercel project's environment variables
// (and in a local .env for `vercel dev`).

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { IncomingForm, type File as FormidableFile } from 'formidable'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { COLUMNS_PER_ROW, buildCardsFromGrid, type UncertainCell } from './lib/standardChecklistGrid.js'

export const config = {
  api: {
    bodyParser: false,
  },
}

// Vision-capable Claude model. Switched from claude-sonnet-4-6 to Haiku 4.5 to cut
// per-run cost roughly 3x (Sonnet was costing ~$0.04/run). Haiku is less reliable at
// fiddly visual judgment calls than Sonnet — if scattered-blank misses keep happening
// even after the row-band cropping below, reverting MODEL to claude-sonnet-4-6 is the
// next thing to try, to isolate whether the model or the resolution was the bottleneck.
const MODEL = 'claude-haiku-4-5-20251001'

// Vercel Serverless Functions cap request bodies (4.5MB on Hobby/Pro as of writing).
// A typical phone photo of a checklist sheet can exceed that — if uploads start
// failing with a 413, the fix is to downscale/compress the image client-side
// (e.g. via a canvas resize) in Capture.tsx before the fetch, not here.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

// Row-band cropping: Claude's vision input gets downsampled to a fixed pixel budget
// regardless of how high-res the uploaded photo is. On a full-sheet image (~21 rows x
// 32 cols = ~670 cells), that budget works out to just a handful of pixels per cell —
// easy for a faint red mark to disappear, which is the most likely explanation for
// scattered single-cell misses surviving multiple rounds of prompt tweaks. Splitting the
// photo into a few overlapping horizontal strips and sending each as its own image gives
// every strip its own full pixel budget, so the same cells end up much bigger and clearer.
// Strips overlap so a row never falls exactly on a cut edge without being fully visible
// in at least one strip.
const BAND_COUNT = 4
const BAND_OVERLAP_FRACTION = 0.12

const SYSTEM_PROMPT = `You are looking at a "Sports Card Inventory Checklist" — a single fixed template used for every sheet in this collection. The template has a printed grid: each row holds exactly ${COLUMNS_PER_ROW} numbered cells, read left to right, and rows are read top to bottom.

You do NOT need to read the small printed numbers inside each cell — the app computes every card's number automatically from its grid position.

You will be given ${BAND_COUNT + 1} images of the SAME sheet:
- Image 1 is the full, uncropped sheet. Use Image 1 ONLY to read the header fields below (year, manufacturer, owner name, total card count). Image 1 is too low-resolution for judging individual marks reliably — do NOT use it to decide red vs. white for any cell.
- Images 2 through ${BAND_COUNT + 1} are sequential horizontal strips of the same grid, covering it top to bottom in order, each strip considerably more zoomed-in than Image 1. Adjacent strips deliberately overlap by roughly ${Math.round(BAND_OVERLAP_FRACTION * 200)}% so every row is fully, cleanly visible (not cut off top or bottom) in at least one strip. Use ONLY these zoomed-in strip images to judge marks — that's the entire reason they exist.

Your job:

1. From Image 1 only, read the header fields near the top of the sheet: "Year", "Company" (manufacturer), any handwritten owner name (often initials or a first name in a corner), and any handwritten note giving the set's total card count (e.g. "660 total cards"). Any of these can be missing — use null rather than guessing.

2. Working through Images 2 through ${BAND_COUNT + 1} in order, build ONE continuous top-to-bottom list of grid rows for the whole sheet:
   - For each strip, identify which rows are FULLY visible in it (you can see the complete top and bottom edge of every cell in that row — not sliced off by the strip's own crop edge).
   - Report each fully-visible row exactly ONCE, the first time it's fully visible, in true top-to-bottom sheet order. Because strips overlap, the same row may be fully visible in two consecutive strips — when that happens, you already reported it from the earlier strip, so skip it in the later one. Never report the same physical row twice, and never skip a real row.
   - On most sheets the large majority of cells are marked — unmarked (blank, not-owned) cells are the rare exception, scattered one at a time among long runs of marked cells, easy to skim past if you judge a row "at a glance." Do NOT classify a row holistically. For EACH row, before writing anything else, look at each of its ${COLUMNS_PER_ROW} cells one at a time, left to right, as if running your finger across them, and silently note whether each individual cell has a noticeable amount of red ink (marked) or is plain white/cardstock with only black printed text and no red (unmarked) — judged on that cell's own pixels in the zoomed-in strip, never assumed from its neighbors.
   - Report each row as a ${COLUMNS_PER_ROW}-character string of '1' (red present) and '0' (no red), left to right. Include every row that has any printed cells, even if entirely unmarked. If the sheet's last row has fewer than ${COLUMNS_PER_ROW} printed cells, still return a ${COLUMNS_PER_ROW}-character string — pad the unused trailing positions with '0'.

3. Separately list specific cell positions (1-indexed row/col within your final combined row list, where row 1 is the top printed row and col 1 is the leftmost cell) where the red/no-red call is genuinely hard to make — e.g. a very faint pink tinge, a shadow that could look reddish, or red ink bleeding in from an adjacent cell — with your confidence for that one cell (0.0-1.0, low = uncertain). Only list cells you're actually unsure about; an empty list is expected and fine if every cell is clear.

First, write a brief plain-text scratchpad: for each strip, note which rows you're taking from it (skipping any already covered by the previous strip's overlap), and for each of those rows list the column numbers of any cell you judged unmarked (write "none" if every cell in that row is marked). This is your evidence that you actually checked every cell individually instead of skimming, and that you didn't double-count or skip a row at the overlap boundaries. Keep it terse.

Then, after the scratchpad, write the line FINAL JSON: followed by ONLY valid JSON (no markdown fences, no commentary) matching this shape, which must be consistent with your scratchpad above:
{
  "year": number | null,
  "manufacturer": string | null,
  "owner_name": string | null,
  "owner_confidence": number,
  "total_card_count": number | null,
  "rows": string[],
  "uncertain_cells": [
    { "row": number, "col": number, "confidence": number }
  ]
}
"rows" must be the single combined top-to-bottom list for the whole sheet (one entry per real row, no duplicates from strip overlap) — exactly the same shape the app expects whether it came from one image or several.`

type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

function normalizeMediaType(mimeType: string | null): AnthropicImageMediaType {
  if (mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp') {
    return mimeType
  }
  return 'image/jpeg'
}

interface ParsedImage {
  buffer: Buffer
  mimeType: AnthropicImageMediaType
}

async function readBody(req: VercelRequest): Promise<ParsedImage> {
  const form = new IncomingForm({ maxFileSize: MAX_UPLOAD_BYTES })

  const { files } = await new Promise<{ fields: Record<string, unknown>; files: Record<string, unknown> }>(
    (resolve, reject) => {
      form.parse(req as unknown as Parameters<typeof form.parse>[0], (err, fields, files) => {
        if (err) reject(err)
        else resolve({ fields, files })
      })
    },
  )

  const fileField = files.image as FormidableFile | FormidableFile[] | undefined
  const file = Array.isArray(fileField) ? fileField[0] : fileField
  if (!file) {
    throw new Error('No "image" field found in the upload')
  }

  const buffer = await readFile(file.filepath)
  return {
    buffer,
    mimeType: normalizeMediaType(file.mimetype),
  }
}

// Crops the original photo into BAND_COUNT overlapping horizontal strips, full width,
// re-encoded as JPEG (re-encoding is necessary since we're producing new images, not
// just passing the original bytes through — quality 90 keeps file size reasonable
// without losing the detail the whole point of cropping is meant to preserve).
async function splitIntoBands(buffer: Buffer): Promise<string[]> {
  const metadata = await sharp(buffer).metadata()
  const width = metadata.width
  const height = metadata.height
  if (!width || !height) {
    throw new Error('Could not read image dimensions for cropping')
  }

  const nominalBandHeight = height / BAND_COUNT
  const overlapPx = Math.round(nominalBandHeight * BAND_OVERLAP_FRACTION)

  const bands: string[] = []
  for (let i = 0; i < BAND_COUNT; i++) {
    const idealStart = Math.round(i * nominalBandHeight)
    const idealEnd = Math.round((i + 1) * nominalBandHeight)
    const top = Math.max(0, idealStart - overlapPx)
    const bottom = Math.min(height, idealEnd + overlapPx)

    const cropped = await sharp(buffer)
      .extract({ left: 0, top, width, height: bottom - top })
      .jpeg({ quality: 90 })
      .toBuffer()
    bands.push(cropped.toString('base64'))
  }
  return bands
}

function extractJson(raw: string): unknown {
  // The prompt asks Claude to write a row-by-row scratchpad (to force it to actually
  // check every cell instead of skimming the image) before the line "FINAL JSON:" and
  // the real answer. Cut everything before that marker first, if present, so the
  // scratchpad's own prose (which may legitimately contain stray braces, e.g. "row 4:
  // none") never confuses the JSON parse below.
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
    // Surface a snippet of the actual response in the error so Vercel logs show *why*
    // parsing failed (truncation, stray commentary, etc.) instead of just that it did.
    const snippet = cleaned.length > 1500 ? `${cleaned.slice(0, 700)} ...[${cleaned.length} chars total]... ${cleaned.slice(-700)}` : cleaned
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse Claude's response as JSON (${reason}). Raw response: ${snippet}`)
  }
}

interface GridExtraction {
  year: number | null
  manufacturer: string | null
  owner_name: string | null
  owner_confidence: number
  total_card_count: number | null
  rows: string[]
  uncertain_cells: UncertainCell[]
}

function isGridExtraction(value: unknown): value is GridExtraction {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.rows) && Array.isArray(v.uncertain_cells)
}

async function callClaudeVision(image: ParsedImage): Promise<GridExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to the Vercel project env vars')
  }

  const client = new Anthropic({ apiKey })

  // Try to crop into bands for higher per-cell resolution. If cropping fails for any
  // reason (corrupt image, unexpected format, sharp error), fall back to sending just
  // the original full image rather than failing the whole capture — degraded accuracy
  // beats no result at all.
  let bandBase64: string[] = []
  try {
    bandBase64 = await splitIntoBands(image.buffer)
  } catch (err) {
    console.error('vision-capture: band cropping failed, falling back to single full image:', err)
  }

  const fullImageBase64 = image.buffer.toString('base64')

  const content: Anthropic.Messages.ContentBlockParam[] = [
    { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: fullImageBase64 } },
  ]

  if (bandBase64.length > 0) {
    content.push({
      type: 'text',
      text: `Image 1 above is the full sheet (header fields only). Images 2-${bandBase64.length + 1} below are the ${bandBase64.length} top-to-bottom overlapping strips for reading marks.`,
    })
    for (const band of bandBase64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: band } })
    }
  }

  content.push({
    type: 'text',
    text:
      bandBase64.length > 0
        ? 'Read the header fields from image 1 and the marked/blank grid from the strip images, combining them into one continuous top-to-bottom JSON result, following the schema in your system instructions exactly.'
        : 'Strip cropping was unavailable for this image, so only the single full image above is provided — read both the header fields and the marked/blank grid from it as best you can, following the schema in your system instructions exactly.',
  })

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    // The system prompt is identical on every call (it's not per-image), so mark it
    // cacheable — after the first call, repeat calls pay ~10% of the normal input-token
    // rate for this block instead of full price. Cache entries expire after 5 min of
    // disuse, so this mainly helps when scanning several sheets in one sitting.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  })

  const textBlock = message.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude did not return a text response')
  }

  const parsed = extractJson(textBlock.text)
  if (!isGridExtraction(parsed)) {
    throw new Error("Claude's response was missing the expected grid fields")
  }
  return parsed
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const image = await readBody(req)
    const extraction = await callClaudeVision(image)

    const cards = buildCardsFromGrid(extraction.rows, extraction.total_card_count, extraction.uncertain_cells)

    res.status(200).json({
      detected_set_name: null,
      detected_set_confidence: extraction.year && extraction.manufacturer ? 0.9 : 0,
      manufacturer: extraction.manufacturer,
      year: extraction.year,
      owner_name: extraction.owner_name,
      owner_confidence: extraction.owner_confidence,
      cards,
    })
  } catch (err) {
    console.error('vision-capture error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Vision capture failed',
    })
  }
}
