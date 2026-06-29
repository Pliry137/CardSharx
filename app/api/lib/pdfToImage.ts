// Rasterizes pages of an uploaded PDF (e.g. a flatbed scanner's default export
// format) into PNG buffers, so the rest of the pipeline can treat scanner PDFs
// the same as a photo/PNG/JPEG upload.
//
// Uses pdfjs-dist (pure JS PDF parsing) + @napi-rs/canvas (prebuilt-binary canvas,
// same deployment profile as `sharp` — no native build step, works on Vercel)
// rather than shelling out to poppler/pdftoppm, which isn't available in Vercel's
// serverless runtime.
import { createCanvas } from '@napi-rs/canvas'
// @ts-expect-error -- pdfjs-dist's legacy build ships .mjs without its own types entry for this subpath
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// Render scale relative to the PDF's default 72-DPI point size. 300/72 ≈ 4.17 gives
// ~300 DPI output, matching the resolution the OMR calibration in checklistOmr.ts
// was measured against (though that calibration is stored as fractions of image
// size, so it isn't actually DPI-sensitive — this is just for clean readability).
const RENDER_SCALE = 300 / 72

/**
 * Number of pages in a PDF — used by the scan-batch flow to know up front how
 * many checklist sheets a single upload contains, before rasterizing any of them.
 */
export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  const data = new Uint8Array(pdfBuffer)
  const doc = await pdfjsLib.getDocument({ data }).promise
  return doc.numPages
}

/**
 * Rasterizes a single 1-indexed page of a PDF to a PNG buffer.
 */
export async function rasterizePdfPage(pdfBuffer: Buffer, pageNumber: number): Promise<Buffer> {
  const data = new Uint8Array(pdfBuffer)
  const doc = await pdfjsLib.getDocument({ data }).promise
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new Error(`Page ${pageNumber} is out of range (document has ${doc.numPages} pages)`)
  }
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: RENDER_SCALE })

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx as never, viewport }).promise

  return canvas.toBuffer('image/png')
}

/**
 * Convenience wrapper for the original single-shot capture flow (api/vision-capture.ts),
 * which only ever deals with page 1 of a PDF upload.
 */
export async function rasterizeFirstPdfPage(pdfBuffer: Buffer): Promise<Buffer> {
  return rasterizePdfPage(pdfBuffer, 1)
}
