// Vercel serverless function: POST /api/scan-batch-page
// Body: { batch_id: string, page_number: number }
//
// Downloads the original PDF for a batch created by /api/scan-batch-create from
// Supabase Storage, rasterizes just the requested page, and runs it through the
// same header-OCR + grid-OMR pipeline as the single-shot /api/vision-capture
// endpoint (via api/lib/visionPipeline.ts), so multi-page and single-page scans
// are read identically. Returns the same VisionCaptureResult shape as
// /api/vision-capture, plus batch/page context for the UI.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { rasterizePdfPage } from './_lib/pdfToImage.js'
import { runVisionPipeline } from './_lib/visionPipeline.js'
import { getSupabaseAdmin } from './_lib/supabaseAdmin.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const { batch_id, page_number } = req.body ?? {}
    if (!batch_id || typeof page_number !== 'number') {
      res.status(400).json({ error: 'batch_id and page_number are required' })
      return
    }

    const admin = getSupabaseAdmin()

    const { data: batch, error: batchError } = await admin
      .from('scan_batches')
      .select('storage_path, total_pages')
      .eq('id', batch_id)
      .single()
    if (batchError || !batch) {
      throw new Error(batchError?.message ?? `Scan batch ${batch_id} not found`)
    }
    if (page_number < 1 || page_number > batch.total_pages) {
      res.status(400).json({ error: `page_number must be between 1 and ${batch.total_pages}` })
      return
    }

    const { data: pdfBlob, error: downloadError } = await admin.storage.from('scan-uploads').download(batch.storage_path)
    if (downloadError || !pdfBlob) {
      throw new Error(downloadError?.message ?? 'Could not download the original scan PDF')
    }
    const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer())

    const pageImage = await rasterizePdfPage(pdfBuffer, page_number)
    const result = await runVisionPipeline(pageImage, 'image/png')

    res.status(200).json({ ...result, batch_id, page_number, total_pages: batch.total_pages })
  } catch (err) {
    console.error('scan-batch-page error:', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Could not process scan batch page',
    })
  }
}
