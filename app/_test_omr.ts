import { readFile } from 'node:fs/promises'
import { rasterizeFirstPdfPage } from './api/lib/pdfToImage.ts'
import { readGridFromImage } from './api/lib/checklistOmr.ts'

async function main() {
  const pdf = await readFile('/sessions/hopeful-cool-brown/mnt/uploads/Scan06292026.pdf')
  const png = await rasterizeFirstPdfPage(pdf)
  console.log('rasterized bytes', png.length)
  const grid = await readGridFromImage(png, 660)
  console.log('rows', grid.rows.length)
  grid.rows.forEach((r, i) => {
    const blanks = [...r].map((c, j) => (c === '0' ? j + 1 + i * 32 : null)).filter((x) => x !== null)
    if (blanks.length) console.log('row', i, 'blank card#s ->', blanks)
  })
  console.log('uncertain', grid.uncertain_cells)
}
main()
