export const PHOTO_MAX_BYTES = 512 * 1024
export const PHOTO_MAX_SIDE = 1600
const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_SOURCE_PIXELS = 24_000_000
const unsupported = () => new Error('请选择 JPEG、PNG 或 WebP 图片；HEIC 请先导出为 JPEG。 / Choose a JPEG, PNG or WebP image. Export HEIC as JPEG first.')
const tooLarge = () => new Error('图片过大，请选择不超过 20 MB、2400 万像素的照片。 / Choose a photo up to 20 MB and 24 megapixels.')

// Read dimensions before decoding so a compressed image cannot allocate an unbounded bitmap.
export function photoDimensions(bytes: Uint8Array): { width: number; height: number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    if (data.getUint32(8) !== 13 || data.getUint32(12) !== 0x49484452) throw unsupported()
    width = data.getUint32(16); height = data.getUint32(20)
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw unsupported()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = data.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) { height = data.getUint16(offset + 3); width = data.getUint16(offset + 5); break }
      offset += length
    }
  } else if (bytes.length >= 30 && data.getUint32(0) === 0x52494646 && data.getUint32(8) === 0x57454250) {
    const type = data.getUint32(12)
    if (type === 0x56503858) { width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16); height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) }
    else if (type === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { width = data.getUint16(26, true) & 0x3fff; height = data.getUint16(28, true) & 0x3fff }
    else if (type === 0x5650384c && bytes[20] === 0x2f) { const bits = data.getUint32(21, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (!width || !height) throw unsupported()
  if (width * height > MAX_SOURCE_PIXELS || width > 16384 || height > 16384) throw tooLarge()
  return { width, height }
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image(); image.src = url
    await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (error) { URL.revokeObjectURL(url); throw error }
}
const asDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取照片。 / Could not read the photo.')); reader.readAsDataURL(blob) })

export async function compressEquipmentPhoto(file: File): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw unsupported()
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw tooLarge()
  photoDimensions(new Uint8Array(await file.arrayBuffer()))
  let decoded: Awaited<ReturnType<typeof decode>>
  try { decoded = await decode(file) } catch { throw new Error('无法解码这张照片，请换一张 JPEG、PNG 或 WebP 图片。 / Could not decode this photo. Try another JPEG, PNG or WebP image.') }
  const canvas = document.createElement('canvas')
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_SOURCE_PIXELS) throw tooLarge()
    let scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(decoded.width, decoded.height))
    for (let resize = 0; resize < 5; resize++) {
      canvas.width = Math.max(1, Math.round(decoded.width * scale)); canvas.height = Math.max(1, Math.round(decoded.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('此浏览器无法处理照片，请使用其他浏览器。 / This browser cannot process photos. Try another browser.')
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.86, 0.74, 0.62, 0.5]) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
        if (blob && blob.type === 'image/jpeg' && blob.size <= PHOTO_MAX_BYTES) return { dataUrl: await asDataUrl(blob), width: canvas.width, height: canvas.height, bytes: blob.size }
      }
      scale *= 0.75
    }
    throw new Error('照片压缩后仍然过大，请选择其他照片。 / The photo is still too large after compression. Choose another photo.')
  } finally { decoded.close(); canvas.width = 0; canvas.height = 0 }
}
