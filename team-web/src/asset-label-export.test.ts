import { PDFDocument } from 'pdf-lib'
import { expect, it } from 'vitest'
import { labelPdf } from './asset-label-export'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7b8AAAAASUVORK5CYII='

function bytes(blob: Blob) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

it.each([52.89, 168.39, 310])('creates a single PDF page cropped exactly to a 140mm × %smm label', async heightMm => {
  const blob = await labelPdf(png, 140, heightMm)
  expect(blob.type).toBe('application/pdf')
  const pdf = await PDFDocument.load(await bytes(blob))
  expect(pdf.getPageCount()).toBe(1)
  const page = pdf.getPage(0)
  for (const box of [page.getMediaBox(), page.getCropBox()]) {
    expect(box.x).toBe(0); expect(box.y).toBe(0)
    expect(box.width).toBeCloseTo(140 * 72 / 25.4, 4)
    expect(box.height).toBeCloseTo(heightMm * 72 / 25.4, 4)
  }
})
