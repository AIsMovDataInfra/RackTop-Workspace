export type LabelFormat = 'pdf' | 'png'

const PRINT_DPI = 300

/** Use the label itself as the page, with no printer margins or browser headers. */
export async function labelPdf(png: string, widthMm: number, heightMm: number): Promise<Blob> {
  const { PDFDocument, PrintScaling } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const width = widthMm * 72 / 25.4, height = heightMm * 72 / 25.4
  const page = pdf.addPage([width, height])
  page.setCropBox(0, 0, width, height)
  page.drawImage(await pdf.embedPng(png), { x: 0, y: 0, width, height })
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None)
  return new Blob([Uint8Array.from(await pdf.save()).buffer], { type: 'application/pdf' })
}

/** Rasterize the complete standalone label, including all rows and the QR code. */
export async function exportAssetLabel(svg: string, format: LabelFormat): Promise<Blob> {
  const source = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const bounds = source.documentElement.getAttribute('viewBox')?.split(/\s+/).map(Number)
  const widthMm = Number.parseFloat(source.documentElement.getAttribute('width') || '')
  if (source.querySelector('parsererror') || !bounds || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[2] <= 0 || bounds[3] <= 0 || !Number.isFinite(widthMm) || widthMm <= 0) throw new Error('Invalid label dimensions')
  const heightMm = widthMm * bounds[3] / bounds[2]
  await document.fonts?.ready
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  const canvas = document.createElement('canvas')
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Could not render the label'))
      image.src = url
    })
    canvas.width = Math.ceil(widthMm / 25.4 * PRINT_DPI)
    canvas.height = Math.ceil(heightMm / 25.4 * PRINT_DPI)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    if (format === 'pdf') return await labelPdf(canvas.toDataURL('image/png'), widthMm, heightMm)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the label')), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
    canvas.width = 0; canvas.height = 0
  }
}

export function downloadAssetLabel(blob: Blob, serialNumber: string, format: LabelFormat) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${serialNumber.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}-asset-label.${format}`
  link.hidden = true
  document.body.append(link)
  try { link.click() } finally {
    link.remove()
    // Give the browser time to consume the download before releasing its URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
