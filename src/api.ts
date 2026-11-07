import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configError =
  !url || !key ? 'App not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.' : null

const supabase = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Errors our Postgres functions raise on purpose. Anything else (timeout,
// offline, 5xx) is reported as 'network' so the UI says "not saved".
const KNOWN = ['bad_pin', 'rsvp_closed', 'name_required'] as const
export type ApiErrorCode = (typeof KNOWN)[number] | 'network'

export class ApiError extends Error {
  code: ApiErrorCode
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export async function rpc<T>(fn: string, args?: Record<string, unknown>, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const { data, error } = await supabase.rpc(fn, args).abortSignal(ctrl.signal)
    if (error) {
      const code = KNOWN.find((k) => error.message === k) ?? 'network'
      throw new ApiError(code, error.message)
    }
    return data as T
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError('network', String(e))
  } finally {
    clearTimeout(timer)
  }
}

export type PublicStatus = {
  cups_given: number
  cup_limit: number
  rsvp_open: boolean
  rsvp_closes_at: string
  event_name: string
  event_time: string
  event_location: string
}

export type CupResult = { status: 'ok' | 'sold_out'; cups_given: number; cup_limit: number }

export type DoorStats = {
  cups_given: number
  cup_limit: number
  rsvps_total: number
  rsvps_arrived: number
  walk_ins: number
}

export type Rsvp = {
  id: number
  name: string
  tele_handle: string | null
  created_at: string
  arrived_at: string | null
}
