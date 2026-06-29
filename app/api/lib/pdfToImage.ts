// Rasterizes page 1 of an uploaded PDF (e.g. a flatbed scanner's default export
// format) into a PNG buffer, so the rest of the pipeline can treat scanner PDFs
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

export async function rasterizeFirstPdfPage(pdfBuffer: Buffer): Promise<Buffer> {
  const data = new Uint8Array(pdfBuffer)
  const doc = await pdfjsLib.getDocument({ data }).promise
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: RENDER_SCALE })

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx as never, viewport }).promise

  return canvas.toBuffer('image/png')
}
