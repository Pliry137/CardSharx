// Vercel serverless function: POST /api/vision-capture
//
// Accepts a multipart form upload with an `image` field (photo of a paper checklist,
// or a card front/back) and returns structured card data parsed by the Claude Vision API.
// This follows the same photo -> Claude API call -> structured data pattern used by the
// Fuel Log project.
//
// NOT WIRED TO A LIVE ANTHROPIC KEY YET — this is a stub with the intended prompt/response
// contract filled in so the frontend (src/pages/Capture.tsx) has something concrete to call
// against. Wire up ANTHROPIC_API_KEY in .env and replace `mockVisionCall` with a real call.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Buffer } from 'node:buffer'

export const config = {
  api: {
    bodyParser: false,
  },
}

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

Extract structured data and return ONLY valid JSON matching this shape:
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
Capture.tsx, default 0.85) will be shown to the user to confirm by hand.`

async function readBody(req: VercelRequest): Promise<{ base64: string; mimeType: string }> {
  // In production: parse the multipart form (e.g. with `formidable` or `busboy`),
  // pull out the `image` file field, and base64-encode it for the Claude API's
  // image content block. Left unimplemented here since there's no live key to call yet.
  throw new Error('Multipart parsing not yet implemented — see TODO in api/vision-capture.ts')
}

async function callClaudeVision(_base64Image: string, _mimeType: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set')
  }

  // TODO: real implementation —
  // const client = new Anthropic({ apiKey })
  // const message = await client.messages.create({
  //   model: 'claude-sonnet-4-5',
  //   max_tokens: 2048,
  //   system: SYSTEM_PROMPT,
  //   messages: [{
  //     role: 'user',
  //     content: [
  //       { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
  //       { type: 'text', text: 'Extract the checklist/card data as JSON.' },
  //     ],
  //   }],
  // })
  // return JSON.parse(message.content[0].text)

  throw new Error('callClaudeVision not yet implemented')
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
    // Stubbed endpoint — surface a clear "not implemented" error rather than a vague 500
    // until the multipart parsing + live Anthropic call are filled in.
    res.status(501).json({
      error: err instanceof Error ? err.message : 'Vision capture not yet implemented',
    })
  }
}
