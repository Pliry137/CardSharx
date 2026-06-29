// Vercel serverless function: POST /api/vision-capture
//
// Accepts a multipart form upload with an `image` field — a flatbed scan (PDF,
// PNG, or JPEG) of one "Sports Card Inventory Checklist" sheet, the single fixed
// template Joe uses for every set (confirmed: same physical form every time, see
// api/lib/standardChecklistGrid.ts).
//
// This is the original single-shot path: one upload in, one set's worth of cards
// out. For a PDF containing several sheets (e.g. a whole binder scanned at once),
// only page 1 is read here — see api/scan-batch-create.ts + api/scan-batch-page.ts
// for the multi-page flow, which reuses the same header-OCR + grid-OMR logic via
// api/lib/visionPipeline.ts.
//
// Requires ANTHROPIC_API_KEY to be set in the Vercel project's environment variables
// (and in a local .env for `vercel dev`).

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { IncomingForm, type File as FormidableFile } from 'formidable'
import { readFile } from 'node:fs/promises'
import { rasterizeFirstPdfPage } from './lib/pdfToImage.js'
import { normalizeMediaType, runVisionPipeline, type AnthropicImageMediaType } from './lib/visionPipeline.js'

export const config = {
  api: {
    bodyParser: false,
  },
}

// Vercel Serverless Functions cap request bodies (4.5MB on Hobby/Pro as of writing).
// A flatbed scan PDF at 300 DPI can exceed that — if uploads start failing with a
// 413, the fix is to downscale/compress client-side in Capture.tsx before the
// fetch, not here.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const upload = await readBody(req)
    const image = await toRasterImage(upload)

    const result = await runVisionPipeline(image.buffer, image.mimeType)

    res.status(200).json(result)
  } catch (err) {
    console.error('vision-capture error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Vision capture failed',
    })
  }
}
