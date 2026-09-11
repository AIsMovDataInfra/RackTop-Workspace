import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import { assetLabelSvg, EquipmentLabel, equipmentUrl } from './AssetLabel'
import { downloadAssetLabel, exportAssetLabel } from './asset-label-export'
import type { Equipment } from './types'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,cXI=') } }))
vi.mock('./asset-label-export', () => ({ exportAssetLabel: vi.fn(), downloadAssetLabel: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (zh: string) => zh
const equipment: Equipment = { id: '31b0d006-a451-424c-b7f1-e7c3aaee0f49', code: 'RT-INTERNAL', name: '机械臂', serialNumber: '00000015', company: '', category: '机械臂', model: '', location: '上海', responsiblePerson: '责任人甲', currentUser: '', notes: '', status: 'available', photo: null, version: 1, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.mocked(QRCode.toDataURL).mockReset().mockImplementation(() => Promise.resolve('data:image/png;base64,cXI='))
  vi.mocked(exportAssetLabel).mockReset().mockResolvedValue(new Blob(['label'], { type: 'application/pdf' }))
  vi.mocked(downloadAssetLabel).mockReset()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
const printSelect = () => container.querySelector<HTMLSelectElement>('select[aria-label="打印标签"]')!
async function chooseFormat(format: 'pdf' | 'png') {
  await act(async () => { const select = printSelect(); select.value = format; select.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('exports the full label as valid standalone SVG with escaped text, a local QR image, and all long content', () => {
  const name = '超长资产名称'.repeat(20) + '<script>&"'
  const svg = assetLabelSvg({ ...equipment, name, responsiblePerson: '<img onerror="alert(1)">' }, 'data:image/png;base64,cXI=', t)
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(parsed.querySelector('parsererror')).toBeNull()
  expect(parsed.querySelector('script')).toBeNull()
  expect(parsed.querySelector('img')).toBeNull()
  expect(parsed.querySelectorAll('image')).toHaveLength(1)
  expect(parsed.querySelector('image')?.getAttribute('href')).toBe('data:image/png;base64,cXI=')
  const texts = [...parsed.querySelectorAll('text')].map((node) => node.textContent)
  expect(texts).toContain(name)
  expect(texts).toContain('<img onerror="alert(1)">')
  expect(texts).toContain('待分配'); expect(texts).toContain('—')
  expect(parsed.documentElement.getAttribute('viewBox')?.split(' ').at(-1)).not.toBe('272')
  expect(svg).not.toContain(equipment.code)
  expect(svg).not.toContain(equipment.id)
  expect(() => encodeURIComponent(assetLabelSvg({ ...equipment, name: 'bad\ud800text' }, 'data:image/png;base64,cXI=', t))).not.toThrow()
  for (const malicious of ['https://example.com/qr.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,x" onload="alert(1)']) expect(() => assetLabelSvg(equipment, malicious, t)).toThrow('Invalid QR image')
})

it('renders long text in semantic table cells without injecting markup and leaves old companies unassigned', async () => {
  const name = '带特殊符号的长设备名'.repeat(12) + '<b>安全文本</b>'
  await act(async () => root.render(<EquipmentLabel equipment={{ ...equipment, name }} t={t} onClose={vi.fn()} />))
  expect(container.querySelector('table')?.textContent).toContain(name)
  expect(container.querySelector('table b')).toBeNull()
  expect(container.querySelector('table')?.textContent).toContain('待分配')
  expect(container.querySelector('table')?.textContent).not.toContain(equipment.code)
  expect(container.querySelector('table')?.textContent).not.toContain(equipment.id)
  expect(container.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0')
  expect(container.textContent).toContain('纸面信息需重新打印')
})

it('keeps the same QR URL when editable company and people change and supports English labels', async () => {
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  const originalHref = container.querySelector('.equipment-label-url')?.getAttribute('href')
  expect(originalHref).toBe(equipmentUrl(equipment.id))
  const english = (_zh: string, en: string) => en
  await act(async () => root.render(<EquipmentLabel equipment={{ ...equipment, company: '西浦', responsiblePerson: 'new owner', currentUser: 'current user', version: 2 }} t={english} onClose={vi.fn()} />))
  expect(container.querySelector('.equipment-label-url')?.getAttribute('href')).toBe(originalHref)
  expect(container.querySelector('thead th')?.textContent).toBe('Fixed asset identification')
  expect(container.querySelector('table')?.textContent).toContain('西浦')
  expect(container.querySelector('table')?.textContent).toContain('new owner')
  expect(QRCode.toDataURL).toHaveBeenCalledWith(originalHref, expect.objectContaining({ margin: 4, width: 640 }))
})

it.each(['pdf', 'png'] as const)('offers a single print control and exports a complete %s label', async (format) => {
  const result = new Blob(['complete label'], { type: format === 'pdf' ? 'application/pdf' : 'image/png' })
  vi.mocked(exportAssetLabel).mockResolvedValueOnce(result)
  const print = vi.spyOn(window, 'print').mockImplementation(() => {})
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  const select = printSelect()
  expect(select).not.toBeNull(); expect(select.disabled).toBe(false)
  expect([...select.options].map(option => [option.value, option.textContent])).toEqual([['', '打印标签'], ['pdf', 'PDF（已裁剪）'], ['png', 'PNG']])
  expect(container.querySelectorAll('footer select')).toHaveLength(1)
  expect(container.querySelectorAll('a[download]')).toHaveLength(0)
  expect(container.textContent).not.toContain('下载完整标签'); expect(container.textContent).not.toContain('下载二维码')
  await chooseFormat(format)
  expect(exportAssetLabel).toHaveBeenCalledOnce()
  const [svg, exportedFormat] = vi.mocked(exportAssetLabel).mock.calls[0]
  expect(exportedFormat).toBe(format)
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  expect(document.querySelector('parsererror')).toBeNull()
  expect(document.querySelectorAll('text')).toHaveLength(11)
  expect(document.documentElement.textContent).toContain(equipment.serialNumber)
  expect(document.documentElement.textContent).toContain(equipment.name)
  expect(document.querySelector('image')?.getAttribute('href')).toBe('data:image/png;base64,cXI=')
  expect(downloadAssetLabel).toHaveBeenCalledWith(result, equipment.serialNumber, format)
  expect(print).not.toHaveBeenCalled()
  expect(printSelect().value).toBe('')
})

it('disables printing until the QR image is ready and reports QR generation failures', async () => {
  let resolveQr!: (image: string) => void
  vi.mocked(QRCode.toDataURL).mockImplementationOnce(() => new Promise<string>(resolve => { resolveQr = resolve }))
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  expect(printSelect().disabled).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('正在生成二维码')
  expect(exportAssetLabel).not.toHaveBeenCalled()
  await act(async () => resolveQr('data:image/png;base64,cXI='))
  expect(printSelect().disabled).toBe(false)
  vi.mocked(QRCode.toDataURL).mockRejectedValueOnce(new Error('QR failure'))
  await act(async () => root.render(<EquipmentLabel equipment={{ ...equipment, id: 'another-device' }} t={t} onClose={vi.fn()} />))
  expect(printSelect().disabled).toBe(true)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('二维码生成失败')
  expect(downloadAssetLabel).not.toHaveBeenCalled()
})

it('prevents duplicate exports while generating and allows retry after an export failure', async () => {
  let rejectExport!: (reason: Error) => void
  vi.mocked(exportAssetLabel).mockImplementationOnce(() => new Promise<Blob>((_resolve, reject) => { rejectExport = reject }))
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  await chooseFormat('pdf')
  expect(printSelect().disabled).toBe(true)
  expect(container.textContent).toContain('正在生成')
  expect(downloadAssetLabel).not.toHaveBeenCalled()
  await act(async () => rejectExport(new Error('Could not rasterize label')))
  expect(printSelect().disabled).toBe(false)
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/失败|重试/)
  expect(downloadAssetLabel).not.toHaveBeenCalled()
  await chooseFormat('png')
  expect(exportAssetLabel).toHaveBeenCalledTimes(2)
  expect(downloadAssetLabel).toHaveBeenCalledOnce()
  expect(downloadAssetLabel).toHaveBeenCalledWith(expect.any(Blob), equipment.serialNumber, 'png')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('does not download a late export after the label dialog has unmounted', async () => {
  let resolveExport!: (value: Blob) => void
  vi.mocked(exportAssetLabel).mockImplementationOnce(() => new Promise<Blob>(resolve => { resolveExport = resolve }))
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  await chooseFormat('pdf')
  await act(async () => root.render(null))
  await act(async () => resolveExport(new Blob(['label'], { type: 'application/pdf' })))
  expect(downloadAssetLabel).not.toHaveBeenCalled()
})

it('discards a pending export when equipment changes and exports the new label on retry', async () => {
  let resolveExport!: (value: Blob) => void
  vi.mocked(exportAssetLabel).mockImplementationOnce(() => new Promise<Blob>(resolve => { resolveExport = resolve }))
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  await chooseFormat('pdf')
  const nextEquipment = { ...equipment, id: 'new-device', serialNumber: '00000016', name: '更新后的设备' }
  await act(async () => root.render(<EquipmentLabel equipment={nextEquipment} t={t} onClose={vi.fn()} />))
  expect(printSelect().disabled).toBe(false)
  await act(async () => resolveExport(new Blob(['old label'], { type: 'application/pdf' })))
  expect(downloadAssetLabel).not.toHaveBeenCalled()
  await chooseFormat('png')
  expect(exportAssetLabel).toHaveBeenLastCalledWith(expect.stringContaining('更新后的设备'), 'png')
  expect(downloadAssetLabel).toHaveBeenCalledOnce()
  expect(downloadAssetLabel).toHaveBeenCalledWith(expect.any(Blob), nextEquipment.serialNumber, 'png')
})

it('keeps an export running across background rerenders with equivalent equipment and translations', async () => {
  let resolveExport!: (value: Blob) => void
  vi.mocked(exportAssetLabel).mockImplementationOnce(() => new Promise<Blob>(resolve => { resolveExport = resolve }))
  await act(async () => root.render(<EquipmentLabel equipment={equipment} t={t} onClose={vi.fn()} />))
  await chooseFormat('pdf')
  await act(async () => root.render(<EquipmentLabel equipment={{ ...equipment }} t={(zh) => zh} onClose={vi.fn()} />))
  expect(printSelect().disabled).toBe(true)
  expect(container.querySelector('[role="status"]')?.textContent).toContain('正在生成标签')
  const result = new Blob(['complete label'], { type: 'application/pdf' })
  await act(async () => resolveExport(result))
  expect(downloadAssetLabel).toHaveBeenCalledExactlyOnceWith(result, equipment.serialNumber, 'pdf')
  expect(printSelect().disabled).toBe(false)
})
