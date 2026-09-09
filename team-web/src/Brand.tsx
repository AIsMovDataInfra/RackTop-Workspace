import { Activity } from 'lucide-react'
import type { Translate } from './types'

export function Brand({ t }: { t: Translate }) {
  return <div className="brand"><span aria-hidden="true"><Activity size={24} /></span><div><strong>RackTop</strong><small>AIsMov · {t('团队工作台', 'Team workspace')}</small></div></div>
}
