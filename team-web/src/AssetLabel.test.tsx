import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import { assetLabelSvg, EquipmentLabel, equipmentUrl } from './AssetLabel'
import type { Equipment } from './types'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,cXI=') } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (zh: string) => zh
const equipment: Equipment = { id: '31b0d006-a451-424c-b7f1-e7c3aaee0f49', code: 'RT-INTERNAL', name: '机械臂', serialNumber: '00000015', company: '', category: '机械臂', model: '', location: '上海', responsiblePerson: '责任人甲', currentUser: '', notes: '', status: 'available', photo: null, version: 1, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' }
let container: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.mocked(QRCode.toDataURL).mockImplementation(() => Promise.resolve('data:image/png;base64,cXI=')) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

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
