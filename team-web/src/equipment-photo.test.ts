import { afterEach, describe, expect, it, vi } from 'vitest'
import { compressEquipmentPhoto, photoDimensions, PHOTO_MAX_BYTES } from './equipment-photo'

function png(width: number, height: number) {
  const bytes = new Uint8Array(24), data = new DataView(bytes.buffer)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); data.setUint32(8, 13); data.setUint32(12, 0x49484452); data.setUint32(16, width); data.setUint32(20, height)
  return bytes
}
function file(width = 4000, height = 3000) {
  const bytes = png(width, height), value = new File([bytes], 'photo.png', { type: 'image/png' })
  Object.defineProperty(value, 'arrayBuffer', { value: async () => bytes.buffer })
  return value
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('device photo compression', () => {
  it('validates dimensions before decoding and rejects oversized and unsupported sources', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    expect(photoDimensions(png(4000, 3000))).toEqual({ width: 4000, height: 3000 })
    await expect(compressEquipmentPhoto(file(10000, 10000))).rejects.toThrow('2400 万像素')
    await expect(compressEquipmentPhoto(new File(['heic'], 'photo.heic', { type: 'image/heic' }))).rejects.toThrow('HEIC')
    const oversized = file(); Object.defineProperty(oversized, 'size', { value: 21 * 1024 * 1024 })
    await expect(compressEquipmentPhoto(oversized)).rejects.toThrow('20 MB')
    expect(decode).not.toHaveBeenCalled()
  })
  it('reads JPEG and WebP dimensions and rejects malformed headers', () => {
    const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0x03, 0x20, 0x04, 0xb0, 1])
    expect(photoDimensions(jpeg)).toEqual({ width: 1200, height: 800 })
    const webp = new Uint8Array(30), view = new DataView(webp.buffer)
    view.setUint32(0, 0x52494646); view.setUint32(8, 0x57454250); view.setUint32(12, 0x56503858)
    webp[24] = 99; webp[27] = 49
    expect(photoDimensions(webp)).toEqual({ width: 100, height: 50 })
    expect(() => photoDimensions(new Uint8Array([255, 216, 255]))).toThrow()
    expect(() => photoDimensions(png(0, 100))).toThrow()
  })
  it('normalizes orientation and exports an opaque JPEG within 1600 pixels and 512 KiB', async () => {
    const close = vi.fn(), decode = vi.fn().mockResolvedValue({ width: 4000, height: 3000, close })
    vi.stubGlobal('createImageBitmap', decode)
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    let attempts = 0
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => { callback(new Blob([new Uint8Array(++attempts === 1 ? PHOTO_MAX_BYTES + 1 : 200_000)], { type })) })
    const source = file(), result = await compressEquipmentPhoto(source)
    expect(decode).toHaveBeenCalledWith(source, { imageOrientation: 'from-image' })
    expect(result).toMatchObject({ width: 1600, height: 1200, bytes: 200_000 })
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(context.fillStyle).toBe('#fff')
    expect(encode).toHaveBeenNthCalledWith(1, expect.any(Function), 'image/jpeg', 0.86)
    expect(encode).toHaveBeenNthCalledWith(2, expect.any(Function), 'image/jpeg', 0.74)
    expect(close).toHaveBeenCalledOnce()
  })
  it('reduces dimensions when lowering quality alone cannot meet the byte limit', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    let attempts = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob([new Uint8Array(++attempts <= 4 ? PHOTO_MAX_BYTES + 1 : 120_000)], { type })))
    await expect(compressEquipmentPhoto(file())).resolves.toMatchObject({ width: 1200, height: 900, bytes: 120_000 })
  })
})
