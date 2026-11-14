// The notification. FireDial's page calls showToast directly, the background script injects it
// into web pages, so one notification serves both.

import { textOn } from '../color.ts'
import { accentOf } from '../model.ts'
import type { ViewId, Prefs, SparkId } from '../model.ts'

const TOAST_TIME = 6000 // ms

// The spark a click on the notification leads to.

declare const chrome: typeof browser // Chrome's name for browser

export interface Reveal {
  viewId: ViewId
  sparkId: SparkId
}

// Runs in web pages, so it can use nothing from outside itself. The shadow root keeps the page's
// styles out. Notifications stack, the newest at the bottom, and the oldest goes after three.
export function showToast(text: string, ms: number, background: string, color: string, reveal: Reveal | null): void {
  const stack = document.getElementById('firedial-toasts') ?? document.createElement('div')
  stack.id = 'firedial-toasts'
  stack.style.cssText =
    'all: initial; position: fixed; right: var(--firedial-toast-right, 16px); bottom: var(--firedial-toast-bottom, 16px); z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 8px'
  const host = document.createElement('div')
  host.style.cssText = 'all: initial; display: block'
  const remove = (): void => {
    host.remove()
    if (!stack.children.length) stack.remove()
  }
  const toast = document.createElement('div')
  toast.setAttribute('role', 'status')
  toast.style.cssText = `display: flex; align-items: center; gap: 12px; box-sizing: border-box; max-width: min(480px, calc(100vw - 32px)); padding: 14px; border-radius: 14px; background: ${background}; color: ${color}; font: 600 15px/1.4 var(--firedial-toast-font, system-ui, sans-serif); box-shadow: 0 10px 30px rgba(0, 0, 0, .35); cursor: ${reveal ? 'pointer' : 'default'}`
  const label = document.createElement('span')
  label.textContent = text
  label.style.cssText = 'display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3'
  const dismiss = document.createElement('button')
  dismiss.textContent = '✕'
  dismiss.setAttribute('aria-label', 'Dismiss')
  dismiss.style.cssText = 'flex-shrink: 0; padding: 0 4px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer'
  const flame = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  flame.setAttribute('viewBox', '0 0 24 24')
  flame.setAttribute(
    'style',
    'flex-shrink: 0; width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round'
  )
  const flamePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  flamePath.setAttribute(
    'd',
    'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z'
  )
  flame.append(flamePath)
  toast.append(flame, label, dismiss)
  host.attachShadow({ mode: 'closed' }).append(toast)
  stack.append(host)
  document.documentElement.append(stack)
  while (stack.children.length > 3) stack.firstElementChild?.remove()
  setTimeout(remove, ms)
  toast.addEventListener('click', (event) => {
    if (event.target === dismiss) {
      remove()
    } else if (reveal) {
      remove()
      // This runs in the page, where older Chrome has no browser.*, only chrome.*.
      void (typeof browser === 'undefined' ? chrome : browser).runtime.sendMessage(reveal)
    }
  })
}

// showToast's arguments, in the colors the user picked.
export function toastArgs(text: string, prefs: Prefs, reveal: Reveal | null = null): [string, number, string, string, Reveal | null] {
  const background = accentOf(prefs)
  return [text, TOAST_TIME, background, textOn(background), reveal]
}
