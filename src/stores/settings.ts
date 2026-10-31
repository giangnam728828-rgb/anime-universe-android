import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'dark' | 'light'
export type ReaderMode = 'vertical' | 'horizontal'
export type ReaderBg = 'black' | 'gray' | 'white' | 'green'

export const READER_BG_CSS: Record<ReaderBg, string> = {
  black: '#000000',
  gray: '#8a8a93',
  white: '#f5f5f0',
  green: '#a9b8a0',
}

interface SettingsState {
  theme: ThemeMode
  readerMode: ReaderMode
  readerBg: ReaderBg
  setTheme: (t: ThemeMode) => void
  setReaderMode: (m: ReaderMode) => void
  setReaderBg: (b: ReaderBg) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'dark',
      readerMode: 'vertical',
      readerBg: 'black',
      setTheme: (theme) => set({ theme }),
      setReaderMode: (readerMode) => set({ readerMode }),
      setReaderBg: (readerBg) => set({ readerBg }),
    }),
    { name: 'au_settings' },
  ),
)
