// Vercel serverless function: POST /api/scan-batch-create
//
// Accepts a multipart form upload with a `file` field — a PDF that may contain
// several "Sports Card Inventory Checklist" sheets (e.g. a whole binder scanned in
// one pass). Stores the original PDF in Supabase Storage (private bucket, service
// role only — see api/lib/supabaseAdmin.ts) and creates a `scan_batches` row plus
// one `scan_batch_pages` row per page, all starting 'pending'.
//
// The client then calls /api/scan-batch-page once per page to review/save sheets
// one at a time, and updates each page's row directly via the anon Supabase client
// (open RLS, like every other table in this app) as it goes — see Capture.tsx.
// Because progress lives in the database rather than only in browser memory, a
// batch can be closed and resumed later, from any device.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { IncomingForm, type File as FormidableFile } from 'formidable'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { getPdfPageCount } from './_lib/pdfToImage.js'
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js'

export const config = {
  api: {
    bodyParser: false,
  },
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

async function readBody(req: VercelRequest): Promise<{ buffer: Buffer; filename: string | null }> {
  const form = new IncomingForm({ maxFileSize: MAX_UPLOAD_BYTES })

  const { files } = await new Promise<{ fields: Record<string, unknown>; files: Record<string, unknown> }>(
    (resolve, reject) => {
      form.parse(req as unknown as Parameters<typeof form.parse>[0], (err, fields, files) => {
        if (err) reject(err)
        else resolve({ fields, files })
      })
    },
  )

  const fileField = files.file as FormidableFile | FormidableFile[] | undefined
  const file = Array.isArray(fileField) ? fileField[0] : fileField
  if (!file) {
    throw new Error('No "file" field found in the upload')
  }
  if (file.mimetype !== 'application/pdf') {
    throw new Error('scan-batch-create only accepts PDF uploads — use /api/vision-capture for a single photo/image')
  }

  const buffer = await readFile(file.filepath)
  return { buffer, filename: file.originalFilename ?? null }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { buffer, filename } = await readBody(req)
    const totalPages = await getPdfPageCount(buffer)

    const admin = getSupabaseAdmin()
    const batchId = randomUUID()
    const storagePath = `batches/${batchId}.pdf`

    const { error: uploadError } = await admin.storage
      .from('scan-uploads')
      .upload(storagePath, buffer, { contentType: 'application/pdf' })
    if (uploadError) throw new Error(`Could not store upload: ${uploadError.message}`)

    const { error: batchError } = await admin.from('scan_batches').insert({
      id: batchId,
      original_filename: filename,
      total_pages: totalPages,
      storage_path: storagePath,
      status: 'in_progress',
    })
    if (batchError) throw new Error(`Could not create scan batch: ${batchError.message}`)

    const pageRows = Array.from({ length: totalPages }, (_, i) => ({
      batch_id: batchId,
      page_number: i + 1,
      status: 'pending' as const,
    }))
    const { error: pagesError } = await admin.from('scan_batch_pages').insert(pageRows)
    if (pagesError) throw new Error(`Could not create scan batch pages: ${pagesError.message}`)

    res.status(200).json({ batch_id: batchId, total_pages: totalPages, original_filename: filename })
  } catch (err) {
    console.error('scan-batch-create error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Could not create scan batch',
    })
  }
}
