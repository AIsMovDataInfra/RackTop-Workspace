import type { BookingStartMode, Translate } from './types'

export function BookingModePicker({ mode, onChange, disabled, t }: { mode: BookingStartMode; onChange: (mode: BookingStartMode) => void; disabled?: boolean; t: Translate }) {
  return <div className="segmented booking-mode" role="group" aria-label={t('使用时间', 'When to use')}>
    <button type="button" disabled={disabled} className={mode === 'now' ? 'is-active' : ''} aria-pressed={mode === 'now'} onClick={() => onChange('now')}>{t('现在使用', 'Use now')}</button>
    <button type="button" disabled={disabled} className={mode === 'scheduled' ? 'is-active' : ''} aria-pressed={mode === 'scheduled'} onClick={() => onChange('scheduled')}>{t('预约未来时段', 'Book a future slot')}</button>
  </div>
}
