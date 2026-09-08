import { useEffect, useState } from 'react'
import { Download, Printer } from 'lucide-react'
import QRCode from 'qrcode'
import { Dialog } from './Dialog'
import type { Equipment, Translate } from './types'
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
  const layout = rows(equipment, t).map(([label, value]) => ({ label: wrap(label, 7), value: wrap(value, 18) }))
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
  const url = equipmentUrl(equipment.id)
  useEffect(() => {
    let active = true
    setImage(''); setError(false)
    void QRCode.toDataURL(url, { width: 640, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then((value) => { if (active) setImage(value) }).catch(() => { if (active) setError(true) })
    document.body.classList.add('equipment-label-open')
    return () => { active = false; document.body.classList.remove('equipment-label-open') }
  }, [url])
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
    </div>
    <footer>{image && <><a className="button" href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(assetLabelSvg(equipment, image, t))}`} download={`${equipment.serialNumber}-asset-label.svg`}><Download size={16}/>{t('下载完整标签', 'Download full label')}</a><a className="button" href={image} download={`${equipment.serialNumber}-QR.png`}>{t('下载二维码', 'Download QR')}</a></>}<button className="primary" disabled={!image} onClick={() => window.print()}><Printer size={16}/>{t('打印标签', 'Print label')}</button></footer>
  </Dialog>
}
