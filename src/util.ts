import { useEffect, useRef } from 'react'

// localStorage can throw (private mode, blocked storage); never let that break the page.
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* ignore */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
}

/** Calls fn now, every intervalMs while the tab is visible, and again on focus/visibility/online. */
export function usePoll(fn: () => void, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    const run = () => {
      if (document.visibilityState === 'visible') fnRef.current()
    }
    run()
    const id = setInterval(run, intervalMs)
    document.addEventListener('visibilitychange', run)
    window.addEventListener('focus', run)
    window.addEventListener('online', run)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', run)
      window.removeEventListener('focus', run)
      window.removeEventListener('online', run)
    }
  }, [intervalMs, enabled])
}

const sgt = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})
const sgtTime = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export const formatSgt = (iso: string) => sgt.format(new Date(iso)) + ' SGT'
export const formatClock = (d: Date) => sgtTime.format(d)
