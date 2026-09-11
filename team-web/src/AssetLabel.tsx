import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Printer } from 'lucide-react'
import QRCode from 'qrcode'
import { Dialog } from './Dialog'
import type { Equipment, Translate } from './types'
import { downloadAssetLabel, exportAssetLabel, type LabelFormat } from './asset-label-export'
import './asset-label.css'

export const equipmentUrl = (id: string) => `${window.location.origin}/equipment/${encodeURIComponent(id)}`
const title = (t: Translate) => t('固定资产标识码', 'Fixed asset identification')
const rows = (equipment: Equipment, t: Translate) => [
  [t('公司名称', 'Company'), equipment.company || t('待分配', 'Unassigned')],
  [t('资产编号', 'Asset number'), equipment.serialNumber],
  [t('资产名称', 'Asset name'), equipment.name],
  [t('责任人', 'Responsible person'), equipment.responsiblePerson || '—'],
  [t('使用人', 'Current user'), equipment.currentUser || '—'],
]
function escapeXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '').replace(/[\ud800-\udfff]/gu, '�').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
}
// Wrap by conservative text width without relying on fonts/canvas being ready.
// Rows grow with the content; long Chinese names are never ellipsized.
function wrap(value: string, units: number) {
  const lines: string[] = []; let line = '', width = 0
  for (const character of value) {
    const step = 1
    if (character === '\n' || (line && width + step > units)) { lines.push(line); line = ''; width = 0 }
    if (character !== '\n' && character !== '\r') { line += character; width += step }
  }
  lines.push(line)
  return lines
}

export function assetLabelSvg(equipment: Equipment, qr: string, t: Translate) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(qr)) throw new Error('Invalid QR image')
  // These short field labels fit the key column; keep English words intact.
  const layout = rows(equipment, t).map(([label, value]) => ({ label: label.split(' '), value: wrap(value, 18) }))
  const heights = layout.map((row) => Math.max(44, Math.max(row.label.length, row.value.length) * 25 + 16))
  const height = 52 + heights.reduce((sum, value) => sum + value, 0)
  const text = (lines: string[], x: number, y: number) => `<text x="${x}" y="${y}" font-size="18" stroke="none">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? 25 : 0}">${escapeXml(line)}</tspan>`).join('')}</text>`
  let y = 52
  const contents = layout.map((row, index) => {
    const markup = `<path d="M0 ${y}H${index ? 504 : 720}"/>${text(row.label, 12, y + 29)}${text(row.value, 156, y + 29)}`
    y += heights[index]
    return markup
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140mm" height="${(height * 140 / 720).toFixed(2)}mm" viewBox="0 0 720 ${height}" role="img" aria-labelledby="title"><title id="title">${escapeXml(title(t))}</title><rect width="720" height="${height}" fill="#fff"/><g font-family="Arial, 'Noto Sans CJK SC', 'PingFang SC', sans-serif" fill="#000"><text x="360" y="35" font-size="25" font-weight="700" text-anchor="middle">${escapeXml(title(t))}</text><g stroke="#000" stroke-width="1.5"><rect x="1" y="1" width="718" height="${height - 2}" fill="none"/><path d="M144 52V${height}M504 52V${height}"/>${contents}</g><image x="516" y="${52 + (height - 52 - 192) / 2}" width="192" height="192" href="${qr}"/></g></svg>`
}

export function EquipmentLabel({ equipment, t, onClose }: { equipment: Equipment; t: Translate; onClose: () => void }) {
  const [image, setImage] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exportError, setExportError] = useState(false)
  const exportJob = useRef(0), exporting = useRef(false)
  const url = equipmentUrl(equipment.id)
  const contentKey = JSON.stringify([url, title(t), rows(equipment, t)])
  useEffect(() => {
    exporting.current = false; setBusy(false); setExportError(false)
    return () => { exportJob.current += 1 }
  }, [contentKey])
  useEffect(() => {
    let active = true
    setImage(''); setError(false)
    void QRCode.toDataURL(url, { width: 640, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then((value) => { if (active) setImage(value) }).catch(() => { if (active) setError(true) })
    document.body.classList.add('equipment-label-open')
    return () => { active = false; document.body.classList.remove('equipment-label-open') }
  }, [url])
  async function printLabel(format: LabelFormat) {
    if (!image || exporting.current) return
    const job = ++exportJob.current
    exporting.current = true; setBusy(true); setExportError(false)
    try {
      const blob = await exportAssetLabel(assetLabelSvg(equipment, image, t), format)
      if (job === exportJob.current) downloadAssetLabel(blob, equipment.serialNumber, format)
    } catch {
      if (job === exportJob.current) setExportError(true)
    } finally {
      if (job === exportJob.current) { exporting.current = false; setBusy(false) }
    }
  }
  return <Dialog title={t('设备标签', 'Device label')} t={t} onClose={onClose}>
    <div className="dialog-body">
      <div className="asset-label-scroll" role="region" aria-label={title(t)} tabIndex={0}>
        <table className="asset-label-table" aria-label={title(t)}>
          <colgroup><col className="asset-label-key"/><col/><col className="asset-label-qr-column"/></colgroup>
          <thead><tr><th colSpan={3}>{title(t)}</th></tr></thead>
          <tbody>{rows(equipment, t).map(([label, value], index) => <tr key={label}>
            <th scope="row">{label}</th><td className={index === 1 ? 'asset-label-number' : undefined}>{value}</td>
            {index === 0 && <td rowSpan={5} className="asset-label-qr">{image ? <img width="192" height="192" src={image} alt={t('扫码查看此设备', 'Scan to view this device')}/> : <p role={error ? 'alert' : 'status'}>{error ? t('二维码生成失败，请关闭后重试。', 'Could not generate the QR code. Close and try again.') : t('正在生成二维码…', 'Generating QR code…')}</p>}</td>}
          </tr>)}</tbody>
        </table>
      </div>
      <p className="field-help">{t('标签较宽时可左右滑动。资产信息更新后，二维码保持不变；纸面信息需重新打印。扫码后登录团队账号查看。', 'Scroll horizontally to see a wide label. The QR code stays the same after updates; reprint to update the text on paper. Sign in with your team account after scanning.')}</p>
      <a className="equipment-label-url" href={url}>{t('打开此设备页面', 'Open this device page')}</a>
      {exportError && <p className="error" role="alert">{t('标签生成失败，请重新选择 PDF 或 PNG 重试。', 'Could not generate the label. Choose PDF or PNG to try again.')}</p>}
    </div>
    <footer>
      {busy && <span className="field-help" role="status">{t('正在生成标签…', 'Generating label…')}</span>}
      <label className="asset-label-print">
        <Printer size={16} aria-hidden="true"/>
        <select className="primary" aria-label={t('打印标签', 'Print label')} disabled={!image || busy} value="" onChange={(event) => { const format = event.target.value; if (format === 'pdf' || format === 'png') void printLabel(format) }}>
          <option value="" disabled hidden>{t('打印标签', 'Print label')}</option>
          <option value="pdf">{t('PDF（已裁剪）', 'PDF (cropped)')}</option>
          <option value="png">PNG</option>
        </select>
        <ChevronDown size={16} aria-hidden="true"/>
      </label>
    </footer>
  </Dialog>
}
