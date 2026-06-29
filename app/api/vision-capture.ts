// Vercel serverless function: POST /api/vision-capture
//
// Accepts a multipart form upload with an `image` field (photo of a paper checklist,
// or a card front/back), sends it to Claude (vision-capable model) with a structured
// extraction prompt, and returns the parsed checklist/card data to the frontend
// (src/pages/Capture.tsx).
//
// Requires ANTHROPIC_API_KEY to be set in the Vercel project's environment variables
// (and in a local .env for `vercel dev`). Without it, this returns a clear 500 rather
// than silently failing.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { IncomingForm, type File as FormidableFile } from 'formidable'
import { readFile } from 'node:fs/promises'

export const config = {
  api: {
    bodyParser: false,
  },
}

// Vision-capable Claude model. See system prompt note in ENV docs for current model strings.
const MODEL = 'claude-sonnet-4-6'

// Vercel Serverless Functions cap request bodies (4.5MB on Hobby/Pro as of writing).
// A typical phone photo of a checklist sheet can exceed that — if uploads start
// failing with a 413, the fix is to downscale/compress the image client-side
// (e.g. via a canvas resize) in Capture.tsx before the fetch, not here.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

const SYSTEM_PROMPT = `You are looking at either:
(a) a paper checklist for a trading card set, or
(b) the front or back of an individual trading card.

If this is a paper checklist, it may also have a handwritten name in a
corner of the page (e.g. "Joe", "Paul", "Tim", "Dan") identifying whose
collection this checklist belongs to. Read that name if present.

For each individual card slot on the checklist, determine whether it is
marked present (an X or checkmark drawn in/over the cell) or absent (blank
cell). Give your own confidence for EACH card's present/absent read — do not
just give one confidence for the whole set. Marks that are faint, smudged,
overlapping an adjacent cell, or ambiguous should get a low confidence score
so the app can ask a human to confirm them rather than silently guessing.

Extract structured data and return ONLY valid JSON (no markdown fences, no
commentary before or after) matching this shape:
{
  "detected_set_name": string | null,
  "detected_set_confidence": number,   // 0.0–1.0, how confident you are in the set match
  "manufacturer": string | null,        // e.g. "Topps", "Pro Set"
  "year": number | null,
  "owner_name": string | null,          // handwritten name in the corner, if present
  "owner_confidence": number,           // 0.0–1.0, confidence in the owner name read
  "cards": [
    {
      "card_number": string,
      "player_or_subject_name": string,
      "owned": boolean,                 // true if marked present (X/check), false if blank
      "presence_confidence": number     // 0.0–1.0, confidence in THIS card's owned read
    }
  ]
}

If you cannot confidently identify the set, set detected_set_name to null and
detected_set_confidence to a low value (< 0.5) rather than guessing — the app will
fall back to letting the user pick the set manually. The same rule applies to
owner_name and to each card's presence_confidence: when in doubt, score it low
rather than asserting a guess. Cards below the confirmation threshold (see
Capture.tsx, default 0.85) will be shown to the user to confirm by hand.

If a checklist's player/subject names aren't printed (common on blank numeric
checklist templates), use the card_number as a placeholder for
player_or_subject_name — the app fills in real names afterward from a separate
checklist lookup, so don't invent or guess names you can't actually read.`

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
  // Despite instructions, models sometimes wrap JSON in markdown fences — strip them
  // before parsing rather than failing the whole capture over formatting.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    throw new Error("Could not parse Claude's response as JSON")
  }
}

async function callClaudeVision(base64Image: string, mimeType: AnthropicImageMediaType) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to the Vercel project env vars')
  }

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
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
            text: 'Extract the checklist/card data as JSON, following the schema in your system instructions exactly.',
          },
        ],
      },
    ],
  })

  const textBlock = message.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude did not return a text response')
  }

  return extractJson(textBlock.text)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { base64, mimeType } = await readBody(req)
    const result = await callClaudeVision(base64, mimeType)
    res.status(200).json(result)
  } catch (err) {
    console.error('vision-capture error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Vision capture failed',
    })
  }
}
