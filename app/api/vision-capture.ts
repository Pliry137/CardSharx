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
import { COLUMNS_PER_ROW, buildCardsFromGrid, type UncertainCell } from './lib/standardChecklistGrid.js'

export const config = {
  api: {
    bodyParser: false,
  },
}

// Vision-capable Claude model. Switched from claude-sonnet-4-6 to Haiku 4.5 to cut
// per-run cost roughly 3x (Sonnet was costing ~$0.04/run). Haiku is less reliable at
// fiddly visual judgment calls than Sonnet, so if scattered-blank misses (like the
// #121/#154/#215 cases that prompted the scratchpad-forcing prompt below) come back
// or get worse, that's the first thing to revert.
const MODEL = 'claude-haiku-4-5-20251001'

// Vercel Serverless Functions cap request bodies (4.5MB on Hobby/Pro as of writing).
// A typical phone photo of a checklist sheet can exceed that — if uploads start
// failing with a 413, the fix is to downscale/compress the image client-side
// (e.g. via a canvas resize) in Capture.tsx before the fetch, not here.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

const SYSTEM_PROMPT = `You are looking at a "Sports Card Inventory Checklist" — a single fixed template used for every sheet in this collection. The template has a printed grid: each row holds exactly ${COLUMNS_PER_ROW} numbered cells, read left to right, and rows are read top to bottom.

You do NOT need to read the small printed numbers inside each cell — the app computes every card's number automatically from its grid position. Your job is only:

1. Read the header fields near the top of the sheet: "Year", "Company" (manufacturer), any handwritten owner name (often initials or a first name in a corner), and any handwritten note giving the set's total card count (e.g. "660 total cards"). Any of these can be missing — use null rather than guessing.

2. On most sheets the large majority of cells are marked — unmarked (blank, not-owned) cells are the rare exception, scattered one at a time among long runs of marked cells. This means they are very easy to skim past if you judge a row "at a glance": a single blank cell in the middle of 31 marked ones does not visually stand out the way you'd expect, and it's a real, common mistake to round it up to "all marked." Do NOT classify a row holistically. Treat finding the rare blanks as the actual point of this task.

To avoid that mistake, work through the grid row by row, and for EACH row, before writing anything else, look at each of its ${COLUMNS_PER_ROW} cells one at a time, left to right, as if you were running your finger across them, and silently note whether each individual cell has a noticeable amount of red ink (marked) or is plain white/cardstock with only black printed text and no red (unmarked) — judged on that cell's own pixels, never assumed from its neighbors. Only after deliberately checking all ${COLUMNS_PER_ROW} cells in a row should you write that row's result.

Then report each row as a ${COLUMNS_PER_ROW}-character string of '1' (red present) and '0' (no red), left to right. Include every row that has any printed cells, even if entirely unmarked. If a row near the bottom of the sheet has fewer than ${COLUMNS_PER_ROW} printed cells, still return a ${COLUMNS_PER_ROW}-character string — pad the unused trailing positions with '0'.

3. Separately list specific cell positions (1-indexed row/col, where row 1 is the top printed row and col 1 is the leftmost cell in that row) where the red/no-red call is genuinely hard to make — e.g. a very faint pink tinge, a shadow that could look reddish, or red ink from an adjacent cell bleeding into this one — with your confidence for that one cell (0.0-1.0, low = uncertain). Only list cells you're actually unsure about; most cells are either clearly red or clearly plain white, and don't need to be listed. An empty list is expected and fine if every cell is clear.

First, write a brief plain-text scratchpad: for each row, in order, list the column numbers (1-${COLUMNS_PER_ROW}) of any cell you judged unmarked in that row (write "none" if every cell in that row is marked). This is your evidence that you actually checked every cell individually instead of skimming. Keep it terse — just row number and the list of unmarked columns, nothing else.

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
}`

type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

function normalizeMediaType(mimeType: string | null): AnthropicImageMediaType {
  if (mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp') {
    return mimeType
  }
  return 'image/jpeg'
}

interface ParsedImage {
  base64: string
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
    base64: buffer.toString('base64'),
    mimeType: normalizeMediaType(file.mimetype),
  }
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

async function callClaudeVision(base64Image: string, mimeType: AnthropicImageMediaType): Promise<GridExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to the Vercel project env vars')
  }

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    // The system prompt is identical on every call (it's not per-image), so mark it
    // cacheable — after the first call, repeat calls pay ~10% of the normal input-token
    // rate for this block instead of full price. Cache entries expire after 5 min of
    // disuse, so this mainly helps when scanning several sheets in one sitting.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64Image },
          },
          {
            type: 'text',
            text: 'Read the header fields and the marked/blank grid as JSON, following the schema in your system instructions exactly.',
          },
        ],
      },
    ],
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
    const { base64, mimeType } = await readBody(req)
    const extraction = await callClaudeVision(base64, mimeType)

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
