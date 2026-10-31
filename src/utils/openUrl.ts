import { Browser } from '@capacitor/browser'

/** 应用内浏览器打开外链（Android Custom Tabs / Web 新标签） */
export async function openExternal(url: string): Promise<void> {
  try {
    await Browser.open({ url })
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}
