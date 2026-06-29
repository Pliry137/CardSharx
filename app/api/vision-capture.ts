// Vercel serverless function: POST /api/vision-capture
//
// Accepts a multipart form upload with an `image` field — a flatbed scan (PDF,
// PNG, or JPEG) of one "Sports Card Inventory Checklist" sheet, the single fixed
// template Joe uses for every set (confirmed: same physical form every time, see
// api/lib/standardChecklistGrid.ts).
//
// Two-part pipeline, split because the two halves need different tools:
//   1. Header fields (year, manufacturer, owner name, total card count) are
//      handwritten/typed free text in no fixed position — Claude vision reads
//      these, which is exactly what LLM vision is good at.
//   2. The 660+-cell marked/blank grid is read deterministically by
//      api/lib/checklistOmr.ts: fixed-coordinate color thresholding on the red
//      ink, no LLM involved. Claude vision was previously asked to read the grid
//      too (see git history), but a dense, repetitive cell grid is exactly the
//      case where general vision models lose their place and miss scattered
//      cells — true regardless of resolution or how the image gets cropped. A
//      flatbed scan (vs. a phone photo) removes skew/perspective, which is what
//      makes fixed-coordinate reading reliable here.
//
// Requires ANTHROPIC_API_KEY to be set in the Vercel project's environment variables
// (and in a local .env for `vercel dev`).

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { IncomingForm, type File as FormidableFile } from 'formidable'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { buildCardsFromGrid } from './lib/standardChecklistGrid.js'
import { readGridFromImage } from './lib/checklistOmr.js'
import { rasterizeFirstPdfPage } from './lib/pdfToImage.js'

export const config = {
  api: {
    bodyParser: false,
  },
}

// Vision-capable Claude model, used only for header-field OCR now — a much
// smaller/cheaper task than full-grid reading, so Haiku's accuracy is plenty.
const MODEL = 'claude-haiku-4-5-20251001'

// Vercel Serverless Functions cap request bodies (4.5MB on Hobby/Pro as of writing).
// A flatbed scan PDF at 300 DPI can exceed that — if uploads start failing with a
// 413, the fix is to downscale/compress client-side in Capture.tsx before the
// fetch, not here.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

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

type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

function normalizeMediaType(mimeType: string | null): AnthropicImageMediaType {
  if (mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp') {
    return mimeType
  }
  return 'image/jpeg'
}

interface ParsedUpload {
  buffer: Buffer
  mimeType: string | null
}

async function readBody(req: VercelRequest): Promise<ParsedUpload> {
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
  return { buffer, mimeType: file.mimetype }
}

// Normalizes the upload to a decoded raster image (PNG/JPEG) regardless of
// whether it arrived as a scanner PDF or an already-rasterized image, since both
// the OMR module and Claude's vision API need a raster image, not a PDF.
async function toRasterImage(upload: ParsedUpload): Promise<{ buffer: Buffer; mimeType: AnthropicImageMediaType }> {
  if (upload.mimeType === 'application/pdf') {
    const png = await rasterizeFirstPdfPage(upload.buffer)
    return { buffer: png, mimeType: 'image/png' }
  }
  return { buffer: upload.buffer, mimeType: normalizeMediaType(upload.mimeType) }
}

// Anthropic caps inline image uploads at 10MB and downsamples anything over ~1568px
// on the long edge anyway, so a full 300-DPI scan (often 2500x3300+, 10-15MB as PNG)
// is both rejected outright and wasted resolution. The grid OMR still reads the
// full-res buffer directly — only this copy, sent to Claude for header-field OCR,
// needs shrinking.
const VISION_MAX_DIMENSION = 1568

async function shrinkForVisionApi(buffer: Buffer): Promise<Buffer> {
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

async function readHeaderFields(image: { buffer: Buffer; mimeType: AnthropicImageMediaType }): Promise<HeaderExtraction> {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const upload = await readBody(req)
    const image = await toRasterImage(upload)
    const visionImage = { buffer: await shrinkForVisionApi(image.buffer), mimeType: 'image/png' as const }

    // Header OCR (Claude, shrunk copy) and grid OMR (deterministic, full-res buffer)
    // are independent — run them concurrently rather than paying for both round
    // trips in series.
    const [header, grid] = await Promise.all([
      readHeaderFields(visionImage),
      readGridFromImage(image.buffer, null),
    ])

    const cards = buildCardsFromGrid(grid.rows, header.total_card_count, grid.uncertain_cells)

    res.status(200).json({
      detected_set_name: null,
      detected_set_confidence: header.year && header.manufacturer ? 0.9 : 0,
      manufacturer: header.manufacturer,
      year: header.year,
      owner_name: header.owner_name,
      owner_confidence: header.owner_confidence,
      cards,
    })
  } catch (err) {
    console.error('vision-capture error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Vision capture failed',
    })
  }
}
