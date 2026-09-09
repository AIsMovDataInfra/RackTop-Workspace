import { Bot, Cat, Dog, Flower2, Rocket, Star, UserRound } from 'lucide-react'
import type { Translate } from './types'
import './member-avatar.css'

export const MEMBER_AVATARS = [
  { id: 'user', zh: '人物', en: 'Person', Icon: UserRound },
  { id: 'cat', zh: '猫', en: 'Cat', Icon: Cat },
  { id: 'dog', zh: '狗', en: 'Dog', Icon: Dog },
  { id: 'rocket', zh: '火箭', en: 'Rocket', Icon: Rocket },
  { id: 'robot', zh: '机器人', en: 'Robot', Icon: Bot },
  { id: 'flower', zh: '花朵', en: 'Flower', Icon: Flower2 },
  { id: 'star', zh: '星星', en: 'Star', Icon: Star },
] as const

export function MemberAvatar({ avatar, size = 20, className = '' }: { avatar?: string; size?: number; className?: string }) {
  const { Icon } = MEMBER_AVATARS.find((item) => item.id === avatar) || MEMBER_AVATARS[0]
  return <span className={`member-avatar ${className}`} aria-hidden="true"><Icon size={size}/></span>
}

export function AvatarPicker({ value, onChange, disabled, t }: { value: string; onChange: (avatar: string) => void; disabled?: boolean; t: Translate }) {
  return <fieldset className="member-avatar-picker" disabled={disabled}><legend>{t('选择头像', 'Choose an avatar')}</legend><div className="member-avatar-options">{MEMBER_AVATARS.map(({ id, zh, en }) => <button type="button" key={id} aria-label={t(zh, en)} aria-pressed={value === id} onClick={() => onChange(id)}><MemberAvatar avatar={id}/><span>{t(zh, en)}</span></button>)}</div></fieldset>
}
