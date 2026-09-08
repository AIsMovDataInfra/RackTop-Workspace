import { useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus, RefreshCw, Trash2, Upload } from 'lucide-react'
import { api, ApiError } from './api'
import { errorText } from './errors'
import { compressEquipmentPhoto } from './equipment-photo'
import type { Equipment, Translate } from './types'

export function EquipmentPhoto({ equipment, t, onChanged, onSessionExpired }: { equipment: Equipment; t: Translate; onChanged: (value: Equipment) => void; onSessionExpired: () => void }) {
  const [base, setBase] = useState(equipment)
  const [image, setImage] = useState('')
  const [pending, setPending] = useState<Awaited<ReturnType<typeof compressEquipmentPhoto>> | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [imageError, setImageError] = useState(false)
  const [photoLoading, setPhotoLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState<'saved' | 'deleted' | 'refreshed' | null>(null)
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null)
  const active = useRef(true)
  const operation = useRef(0)
  const conflict = error instanceof ApiError && error.code === 'VERSION_CONFLICT'
  useEffect(() => { active.current = true; return () => { active.current = false; operation.current++ } }, [])
  useEffect(() => setBase(equipment), [equipment])
  useEffect(() => {
    let cancelled = false, url = ''
    setImage(''); setImageError(false)
    if (!equipment.photo) { setPhotoLoading(false); return }
    setPhotoLoading(true)
    void api.equipmentPhoto(equipment.id, equipment.version).then((blob) => {
      if (cancelled) return
      url = URL.createObjectURL(blob); setImage(url)
    }).catch((reason) => { if (!cancelled) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); else setImageError(true) } }).finally(() => { if (!cancelled) setPhotoLoading(false) })
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url) }
  }, [equipment.id, equipment.version, Boolean(equipment.photo), revision])
  async function choose(file?: File) {
    if (!file || busy) return
    const current = ++operation.current
    setBusy('compress'); setError(null); setNotice(null); setConfirmDelete(false)
    try { const value = await compressEquipmentPhoto(file); if (active.current && current === operation.current) setPending(value) }
    catch (reason) { if (active.current && current === operation.current) setError(reason) }
    finally { if (active.current && current === operation.current) setBusy('') }
  }
  async function mutate(remove: boolean) {
    if (busy || (!remove && !pending)) return
    setBusy(remove ? 'delete' : 'upload'); setError(null); setNotice(null)
    try {
      const result = remove ? await api.deleteEquipmentPhoto(base.id, base.version) : await api.setEquipmentPhoto(base.id, base.version, pending!.dataUrl)
      if (!active.current) return
      setBase(result.equipment); setPending(null); setConfirmDelete(false); setNotice(remove ? 'deleted' : 'saved'); onChanged(result.equipment)
    } catch (reason) { if (active.current) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); else setError(reason) } }
    finally { if (active.current) setBusy('') }
  }
  async function refreshVersion() {
    if (busy) return
    setBusy('refresh')
    try { const result = await api.equipmentDetails(equipment.id); if (active.current) { setBase(result.equipment); onChanged(result.equipment); setError(null); setNotice('refreshed') } }
    catch (reason) { if (active.current) { if (reason instanceof ApiError && reason.status === 401) onSessionExpired(); else setError(reason) } }
    finally { if (active.current) setBusy('') }
  }
  const src = pending?.dataUrl || image
  return <section className="equipment-photo" aria-label={t('设备照片', 'Device photo')} aria-busy={Boolean(busy)}>
    <div className="equipment-section-title"><h3>{t('设备照片', 'Device photo')}</h3><span>{pending ? t('待保存', 'Not saved yet') : t('每台设备一张照片', 'One photo per device')}</span></div>
    {src ? <img className="equipment-photo-image" src={src} alt={pending ? t('待上传照片预览', 'Selected photo preview') : `${equipment.name} ${t('设备照片', 'device photo')}`} /> : <div className="equipment-photo-empty"><Camera size={28} /><span>{photoLoading ? t('正在读取照片…', 'Loading photo…') : imageError ? t('照片未能读取，请重试。', 'Could not load the photo. Try again.') : t('还没有照片', 'No photo yet')}</span>{imageError && <button onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} />{t('重试', 'Retry')}</button>}</div>}
    <input ref={camera} className="equipment-file-input" type="file" aria-label={t('拍摄设备照片', 'Take a device photo')} accept="image/jpeg,image/png,image/webp" capture="environment" disabled={Boolean(busy)} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = '' }} />
    <input ref={album} className="equipment-file-input" type="file" aria-label={t('从相册选择设备照片', 'Choose a device photo')} accept="image/jpeg,image/png,image/webp" disabled={Boolean(busy)} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = '' }} />
    <div className="equipment-photo-actions"><button disabled={Boolean(busy)} onClick={() => camera.current?.click()}><Camera size={16} />{t('拍照', 'Take photo')}</button><button disabled={Boolean(busy)} onClick={() => album.current?.click()}><ImagePlus size={16} />{equipment.photo || pending ? t('更换照片', 'Replace photo') : t('选择照片', 'Choose photo')}</button>{pending ? <><button className="primary" disabled={Boolean(busy) || conflict} onClick={() => void mutate(false)}><Upload size={16} />{t('保存照片', 'Save photo')}</button><button disabled={Boolean(busy)} onClick={() => { setPending(null); setError(null); setNotice(null) }}>{t('取消更换', 'Cancel replacement')}</button></> : equipment.photo && <button disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={16} />{t('删除照片', 'Delete photo')}</button>}</div>
    <p className="field-help">{pending ? `${pending.width} × ${pending.height} · ${Math.ceil(pending.bytes / 1024)} KB · JPEG` : t('支持 JPEG、PNG、WebP，上传前自动压缩。', 'JPEG, PNG and WebP are compressed before upload.')}</p>
    {busy && <p className="loading-inline" role="status">{busy === 'compress' ? t('正在压缩照片…', 'Compressing photo…') : busy === 'refresh' ? t('正在读取最新版本…', 'Loading latest version…') : t('正在保存照片…', 'Saving photo…')}</p>}
    {Boolean(error) && <div className="error" role="alert">{conflict ? t('设备已更新。所选照片已保留，请读取最新版本后再确认保存或删除。', 'The device changed. Your selected photo is preserved. Load the latest version, then confirm saving or deleting.') : errorText(error, t)}{conflict && <button disabled={Boolean(busy)} onClick={() => void refreshVersion()}>{t('读取最新版本', 'Load latest version')}</button>}</div>}
    {notice && <p role="status" className="available-text">{notice === 'saved' ? t('照片已保存。', 'Photo saved.') : notice === 'deleted' ? t('照片已删除。', 'Photo deleted.') : t('已读取最新版本，请核对照片后再保存或删除。', 'Latest version loaded. Review the photo before saving or deleting.')}</p>}
    {confirmDelete && <div className="callout equipment-photo-confirm"><span>{t('确定删除当前设备照片？', 'Delete the current device photo?')}</span><button className="danger" disabled={Boolean(busy) || conflict} onClick={() => void mutate(true)}>{t('确认删除', 'Confirm deletion')}</button><button disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)}>{t('取消', 'Cancel')}</button></div>}
  </section>
}
