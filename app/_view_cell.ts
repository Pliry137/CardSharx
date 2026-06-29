import { readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { rasterizeFirstPdfPage } from './api/lib/pdfToImage.ts'

async function main() {
  const pdf = await readFile('/sessions/hopeful-cool-brown/mnt/uploads/Scan06292026.pdf')
  const png = await rasterizeFirstPdfPage(pdf)
  const meta = await sharp(png).metadata()
  const width = meta.width!, height = meta.height!
  const X0_FRAC = 190/2512, CW_FRAC = 65.4/2512, Y0_FRAC = 662/3277, RH_FRAC = 82.24/3277
  const x0 = X0_FRAC*width, cw = CW_FRAC*width, y0 = Y0_FRAC*height, rh = RH_FRAC*height
  const row = 21, col = 1 // 1-indexed row=21st row(0-indexed 20), col1
  const top = y0 + (row-1)*rh, bottom = y0 + row*rh
  const left = x0 + (col-1)*cw, right = x0 + col*cw
  const pad = 30
  const crop = await sharp(png).extract({
    left: Math.max(0, Math.round(left-pad)),
    top: Math.max(0, Math.round(top-pad)),
    width: Math.round(right-left+2*pad),
    height: Math.round(bottom-top+2*pad),
  }).resize({ width: (Math.round(right-left+2*pad))*4 }).png().toBuffer()
  await writeFile('/sessions/hopeful-cool-brown/mnt/outputs/cell_641.png', crop)
  console.log('saved', left, top, right, bottom)
}
main()
