import { useEffect, useRef, useState } from 'react'
import { Camera, Package } from 'lucide-react'
import { api } from './api'
import type { Equipment, Translate } from './types'
import './equipment-thumbnail.css'

export function EquipmentThumbnail({ equipment, t }: { equipment: Equipment; t: Translate }) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!equipment.photo || !element.current) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '160px' })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [equipment.id, Boolean(equipment.photo)])
  useEffect(() => {
    let active = true, url = ''
    setSrc(''); setFailed(false)
    if (!visible || !equipment.photo) return
    void api.equipmentPhoto(equipment.id, equipment.version).then(blob => {
      if (!active) return
      url = URL.createObjectURL(blob); setSrc(url)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [equipment.id, equipment.version, Boolean(equipment.photo), visible])
  return <span ref={element} className="equipment-thumbnail" title={failed ? t('照片暂时无法读取', 'Photo unavailable') : equipment.name}>
    {src ? <img src={src} alt={`${equipment.name} ${t('设备照片', 'device photo')}`} /> : equipment.photo ? <Camera size={24} aria-label={failed ? t('照片暂时无法读取', 'Photo unavailable') : t('正在读取照片', 'Loading photo')} /> : <Package size={24} aria-label={t('暂无照片', 'No photo')} />}
  </span>
}
