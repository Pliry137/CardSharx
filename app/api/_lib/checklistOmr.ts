// Deterministic optical-mark-recognition (OMR) for the "Sports Card Inventory
// Checklist" template — reads the red X marks directly from pixel data instead of
// asking an LLM vision model to "read" the grid.
//
// Why this exists: Claude's vision model doesn't scan an image pixel-by-pixel — it
// breaks it into patches and interprets them holistically. On a dense, repetitive
// 660+-cell grid, that causes it to lose its place and miss scattered single cells
// no matter how the image is cropped or resized (row-band cropping in
// vision-capture.ts helped but didn't fully fix it). A flatbed scan removes the
// hard part of a fixed-coordinate approach — skew and perspective — so a simple
// "is there red ink in this cell's box" check is both cheaper and more reliable
// than vision for the grid itself. Claude vision is still used (in vision-capture.ts)
// for the handwritten/typed header fields, which aren't fixed-position.
//
// Calibration: measured against Scan06292026.pdf (a real flatbed scan of the
// template at 300 DPI, rasterized to 2512x3277 px) using manual pixel-ruler
// inspection — see PR description / commit message for how these numbers were
// derived. Stored as fractions of image width/height (not raw pixels) so the same
// constants work regardless of scan DPI, as long as the source is an unskewed,
// full-page flatbed scan of the same physical template.
import sharp from 'sharp'
import { COLUMNS_PER_ROW } from './standardChecklistGrid.js'
import type { UncertainCell } from './standardChecklistGrid.js'

// Fraction of image width to the left edge of column 1.
const X0_FRAC = 190 / 2512
// Fraction of image width per column.
const COL_WIDTH_FRAC = 65.4 / 2512
// Fraction of image height to the top edge of row 1 (the header row, cards 1-32).
const Y0_FRAC = 662 / 3277
// Fraction of image height per row. Uniform — the header row is the same height
// as every data row (an earlier visual read suggested otherwise; a ruled pixel
// scan across the whole sheet disproved that — see commit message).
const ROW_HEIGHT_FRAC = 82.24 / 3277

// Shrink each cell's box by this fraction on every side before sampling, so we
// never sample the printed grid line itself or bleed from a neighboring cell.
const CELL_INSET_FRAC = 0.18

// A pixel counts as "red ink" when R notably exceeds the average of G and B.
// Calibrated against real marks/blanks in the sample scan — marked cells came in
// at 40+ on this scale, blanks at <1, even right next to printed black numbers.
const REDNESS_THRESHOLD = 40

// Fraction of red pixels within a cell's inset box, below which the cell reads as
// definitely blank and above which it reads as definitely marked. Anything between
// gets classified by the midpoint but flagged in uncertain_cells with reduced
// confidence, since it didn't land cleanly on either side of the gap observed in
// calibration (blanks ~0.0-0.01, marks ~0.12-0.50 — comfortably separated).
const BLANK_MAX_FRACTION = 0.03
const MARK_MIN_FRACTION = 0.08

export interface OmrResult {
  rows: string[]
  uncertain_cells: UncertainCell[]
}

/**
 * Reads the marked/blank grid directly from a flatbed-scanned image buffer using
 * fixed-coordinate color thresholding — no LLM vision call involved.
 *
 * @param imageBuffer Decoded raster image (PNG/JPEG) of the full scanned sheet.
 * @param totalCardCount Used only to cap how many rows are worth reading; pass
 *   null to read every row implied by the template's known geometry up to the
 *   image's own bottom edge.
 */
export async function readGridFromImage(
  imageBuffer: Buffer,
  totalCardCount: number | null,
): Promise<OmrResult> {
  // Force a 3-channel RGB raw buffer regardless of the source's color space
  // (grayscale PDFs/scans, RGBA PNGs, etc.) so the redness math below can assume
  // fixed channel offsets.
  const { data, info } = await sharp(imageBuffer)
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  if (!width || !height) {
    throw new Error('Could not read image dimensions for grid OMR')
  }

  const x0 = X0_FRAC * width
  const colWidth = COL_WIDTH_FRAC * width
  const y0 = Y0_FRAC * height
  const rowHeight = ROW_HEIGHT_FRAC * height

  const nrows = totalCardCount != null ? Math.ceil(totalCardCount / COLUMNS_PER_ROW) : Math.floor((height - y0) / rowHeight)

  function redFractionInBox(left: number, top: number, right: number, bottom: number): number {
    const w = right - left
    const h = bottom - top
    const insetLeft = Math.round(left + w * CELL_INSET_FRAC)
    const insetRight = Math.round(right - w * CELL_INSET_FRAC)
    const insetTop = Math.round(top + h * CELL_INSET_FRAC)
    const insetBottom = Math.round(bottom - h * CELL_INSET_FRAC)

    let redCount = 0
    let total = 0
    for (let y = insetTop; y < insetBottom; y++) {
      if (y < 0 || y >= height) continue
      const rowOffset = y * width * channels
      for (let x = insetLeft; x < insetRight; x++) {
        if (x < 0 || x >= width) continue
        const idx = rowOffset + x * channels
        const r = data[idx]
        const g = data[idx + 1]
        const b = data[idx + 2]
        const redness = r - (g + b) / 2
        if (redness > REDNESS_THRESHOLD) redCount++
        total++
      }
    }
    return total > 0 ? redCount / total : 0
  }

  const rows: string[] = []
  const uncertain_cells: UncertainCell[] = []

  for (let r = 0; r < nrows; r++) {
    const top = y0 + r * rowHeight
    const bottom = y0 + (r + 1) * rowHeight
    let rowStr = ''
    for (let c = 0; c < COLUMNS_PER_ROW; c++) {
      const left = x0 + c * colWidth
      const right = x0 + (c + 1) * colWidth
      const frac = redFractionInBox(left, top, right, bottom)
      const marked = frac >= (BLANK_MAX_FRACTION + MARK_MIN_FRACTION) / 2

      if (frac > BLANK_MAX_FRACTION && frac < MARK_MIN_FRACTION) {
        uncertain_cells.push({ row: r + 1, col: c + 1, confidence: 0.5 })
      }

      rowStr += marked ? '1' : '0'
    }
    rows.push(rowStr)
  }

  return { rows, uncertain_cells }
}
