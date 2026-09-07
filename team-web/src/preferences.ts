import { useEffect, useState } from 'react'
import type { Locale, Translate } from './types'

type Preferences = { locale: Locale; theme: 'light' | 'dark' | 'system'; largeText: boolean }
const defaults: Preferences = { locale: 'zh-CN', theme: 'light', largeText: false }

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('racktop-team-appearance') || '{}')
      return { locale: stored.locale === 'en' ? 'en' : 'zh-CN', theme: ['light', 'dark', 'system'].includes(stored.theme) ? stored.theme : 'light', largeText: stored.largeText === true }
    } catch { return defaults }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.dataset.textSize = preferences.largeText ? 'large' : 'standard'
    document.documentElement.lang = preferences.locale
    try { localStorage.setItem('racktop-team-appearance', JSON.stringify(preferences)) } catch { /* Appearance still applies for this session. */ }
  }, [preferences])
  const t: Translate = (zh, en) => preferences.locale === 'en' ? en : zh
  return { preferences, setPreferences, t }
}

export type PreferencesState = ReturnType<typeof usePreferences>
