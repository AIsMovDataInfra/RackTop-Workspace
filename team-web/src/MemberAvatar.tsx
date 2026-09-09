import type { CSSProperties } from 'react'
import { Bird, Bot, Bug, Cat, Compass, Cpu, Dog, Fish, Flower2, Gem, HardHat, Headphones, Laptop, MoonStar, Orbit, Rabbit, Rocket, Satellite, Sprout, Squirrel, Star, Sun, Turtle, UserRound } from 'lucide-react'
import type { Translate } from './types'
import './member-avatar.css'

const PALETTES = {
  blue: { background: '#dbeafe', fill: '#60a5fa', ink: '#1e3a8a' },
  orange: { background: '#ffedd5', fill: '#fb923c', ink: '#7c2d12' },
  violet: { background: '#ede9fe', fill: '#a78bfa', ink: '#4c1d95' },
  teal: { background: '#ccfbf1', fill: '#2dd4bf', ink: '#134e4a' },
  pink: { background: '#fce7f3', fill: '#f472b6', ink: '#831843' },
  yellow: { background: '#fef3c7', fill: '#fbbf24', ink: '#78350f' },
  green: { background: '#dcfce7', fill: '#4ade80', ink: '#14532d' },
  sky: { background: '#e0f2fe', fill: '#38bdf8', ink: '#0c4a6e' },
  coral: { background: '#ffe4e6', fill: '#fb7185', ink: '#881337' },
  indigo: { background: '#e0e7ff', fill: '#818cf8', ink: '#312e81' },
} as const

export const MEMBER_AVATARS = [
  { id: 'user', zh: '人物', en: 'Person', Icon: UserRound, palette: PALETTES.blue },
  { id: 'cat', zh: '猫', en: 'Cat', Icon: Cat, palette: PALETTES.orange },
  { id: 'dog', zh: '狗', en: 'Dog', Icon: Dog, palette: PALETTES.yellow },
  { id: 'rocket', zh: '火箭', en: 'Rocket', Icon: Rocket, palette: PALETTES.coral },
  { id: 'robot', zh: '机器人', en: 'Robot', Icon: Bot, palette: PALETTES.teal },
  { id: 'flower', zh: '花朵', en: 'Flower', Icon: Flower2, palette: PALETTES.pink },
  { id: 'star', zh: '星星', en: 'Star', Icon: Star, palette: PALETTES.yellow },
  { id: 'engineer', zh: '工程师', en: 'Engineer', Icon: HardHat, palette: PALETTES.orange },
  { id: 'explorer', zh: '探索者', en: 'Explorer', Icon: Compass, palette: PALETTES.teal },
  { id: 'rabbit', zh: '兔子', en: 'Rabbit', Icon: Rabbit, palette: PALETTES.pink },
  { id: 'bird', zh: '小鸟', en: 'Bird', Icon: Bird, palette: PALETTES.sky },
  { id: 'fish', zh: '小鱼', en: 'Fish', Icon: Fish, palette: PALETTES.orange },
  { id: 'turtle', zh: '乌龟', en: 'Turtle', Icon: Turtle, palette: PALETTES.green },
  { id: 'squirrel', zh: '松鼠', en: 'Squirrel', Icon: Squirrel, palette: PALETTES.yellow },
  { id: 'bug', zh: '甲虫', en: 'Beetle', Icon: Bug, palette: PALETTES.coral },
  { id: 'satellite', zh: '卫星', en: 'Satellite', Icon: Satellite, palette: PALETTES.indigo },
  { id: 'planet', zh: '行星', en: 'Planet', Icon: Orbit, palette: PALETTES.violet },
  { id: 'moon', zh: '月亮', en: 'Moon', Icon: MoonStar, palette: PALETTES.indigo },
  { id: 'sun', zh: '太阳', en: 'Sun', Icon: Sun, palette: PALETTES.orange },
  { id: 'computer', zh: '电脑', en: 'Computer', Icon: Laptop, palette: PALETTES.blue },
  { id: 'circuit', zh: '芯片', en: 'Chip', Icon: Cpu, palette: PALETTES.teal },
  { id: 'headphones', zh: '耳机', en: 'Headphones', Icon: Headphones, palette: PALETTES.violet },
  { id: 'sprout', zh: '新芽', en: 'Sprout', Icon: Sprout, palette: PALETTES.green },
  { id: 'gem', zh: '宝石', en: 'Gem', Icon: Gem, palette: PALETTES.sky },
] as const

export function MemberAvatar({ avatar, size = 20, className = '' }: { avatar?: string; size?: number; className?: string }) {
  const { id, Icon, palette } = MEMBER_AVATARS.find((item) => item.id === avatar) || MEMBER_AVATARS[0]
  const style = { '--avatar-background': palette.background, '--avatar-fill': palette.fill, '--avatar-ink': palette.ink, '--avatar-size': `${size + 12}px` } as CSSProperties
  return <span className={`member-avatar ${className}`} data-avatar={id} style={style} aria-hidden="true"><Icon size={size} fill="var(--avatar-fill)" stroke="var(--avatar-ink)" strokeWidth={1.8} /></span>
}

export function AvatarPicker({ value, onChange, disabled, t }: { value: string; onChange: (avatar: string) => void; disabled?: boolean; t: Translate }) {
  const selected = MEMBER_AVATARS.some((item) => item.id === value) ? value : 'user'
  return <fieldset className="member-avatar-picker" disabled={disabled}><legend>{t('选择头像', 'Choose an avatar')}</legend><div className="member-avatar-options">{MEMBER_AVATARS.map(({ id, zh, en }) => <button type="button" key={id} aria-label={t(zh, en)} aria-pressed={selected === id} onClick={() => onChange(id)}><MemberAvatar avatar={id} size={26}/><span>{t(zh, en)}</span></button>)}</div></fieldset>
}
