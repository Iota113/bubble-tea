import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, rpc, type CupResult, type DoorStats, type Rsvp } from './api'
import { formatClock, storage, usePoll } from './util'

const PIN_KEY = 'door_pin'
const POLL_MS = 5000

export default function DoorPage() {
  const [pin, setPin] = useState<string | null>(() => storage.get(PIN_KEY))
  const [gateMsg, setGateMsg] = useState<string | null>(null)

  const logout = (msg: string | null) => {
    storage.remove(PIN_KEY)
    setPin(null)
    setGateMsg(msg)
  }

  if (!pin) {
    return (
      <PinGate
        message={gateMsg}
        onOk={(p) => {
          storage.set(PIN_KEY, p)
          setPin(p)
        }}
      />
    )
  }
  return <Door pin={pin} onBadPin={() => logout('PIN was rejected — it may have been changed. Enter the new one.')} onLogout={() => logout(null)} />
}

function PinGate({ message, onOk }: { message: string | null; onOk: (pin: string) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(message)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!value) return
    setBusy(true)
    setError(null)
    try {
      await rpc('door_stats', { p_pin: value })
      onOk(value)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'bad_pin' ? 'Wrong PIN.' : "Can't reach the server. Check Wi-Fi and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page">
      <section className="card">
        <h1 className="title">Door helpers</h1>
        <p className="muted">Enter the shared door PIN. This phone will remember it.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>PIN</span>
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus autoComplete="off" />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy || !value}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </section>
    </main>
  )
}

type Tab = 'cups' | 'rsvps' | 'stats'

function Door({ pin, onBadPin, onLogout }: { pin: string; onBadPin: () => void; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('cups')
  // Only ever holds numbers the server returned.
  const [stats, setStats] = useState<DoorStats | null>(null)
  const [confirmedAt, setConfirmedAt] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [connError, setConnError] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [flash, setFlash] = useState<{ n: number; text: string } | null>(null)
  // Bumped whenever a tap's result lands, so an older in-flight poll can't overwrite it.
  const writeSeq = useRef(0)
  const inFlight = useRef(false)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useWakeLock()

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'bad_pin') onBadPin()
  }

  const refresh = async () => {
    const seq = writeSeq.current
    try {
      const s = await rpc<DoorStats>('door_stats', { p_pin: pin })
      if (seq !== writeSeq.current) return
      setStats(s)
      setConfirmedAt(new Date())
      setConnError(false)
    } catch (err) {
      handleError(err)
      setConnError(true)
    }
  }
  usePoll(refresh, POLL_MS)

  const tap = async (fn: 'give_cup' | 'undo_cup') => {
    // A ref, not just `busy`: two taps can land before React re-renders the disabled button.
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFlash(null)
    try {
      const r = await rpc<CupResult>(fn, { p_pin: pin })
      writeSeq.current++
      setStats((s) => (s ? { ...s, cups_given: r.cups_given, cup_limit: r.cup_limit } : s))
      setConfirmedAt(new Date())
      setSaveError(null)
      setConnError(false)
      if (fn === 'give_cup' && r.status === 'ok') {
        setFlash({ n: Date.now(), text: `✓ Saved — cup #${r.cups_given}` })
        navigator.vibrate?.(40)
      } else if (fn === 'undo_cup') {
        setFlash({ n: Date.now(), text: `↩ Undone — now ${r.cups_given}` })
        navigator.vibrate?.([20, 40, 20])
      } else {
        setFlash({ n: Date.now(), text: 'SOLD OUT — not counted' })
      }
      refresh()
    } catch (err) {
      handleError(err)
      setSaveError(fn === 'give_cup' ? 'NOT SAVED — tap +1 again' : 'UNDO NOT SAVED — tap undo again')
      navigator.vibrate?.([100, 60, 100])
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const given = stats?.cups_given ?? 0
  const limit = stats?.cup_limit ?? 0
  const left = Math.max(limit - given, 0)
  const soldOut = stats !== null && left === 0

  return (
    <main className="page door">
      {!online && <div className="banner banner-error" role="alert">OFFLINE — taps will NOT be saved. Check Wi-Fi / data.</div>}
      {saveError && <div className="banner banner-error" role="alert">{saveError}</div>}
      {online && connError && !saveError && (
        <div className="banner banner-error" role="alert">
          Can't reach server — count below may be out of date{confirmedAt ? ` (last confirmed ${formatClock(confirmedAt)})` : ''}.
        </div>
      )}

      <nav className="tabs">
        {(['cups', 'rsvps', 'stats'] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'cups' ? 'Cups' : t === 'rsvps' ? 'RSVPs' : 'Stats'}
          </button>
        ))}
      </nav>

      {tab === 'cups' && (
        <div className="door-cups">
          <div className={`door-count ${connError || saveError ? 'door-count-stale' : ''}`}>
            {stats ? (
              <>
                <div className="door-count-big">
                  {given} <span className="door-count-of">/ {limit}</span>
                </div>
                <div className="door-count-left">{soldOut ? 'SOLD OUT' : `${left} left`}</div>
              </>
            ) : (
              <div className="door-count-left">Loading count…</div>
            )}
          </div>

          <div className="flash-slot" aria-live="assertive">
            {flash && (
              <div key={flash.n} className="flash">
                {flash.text}
              </div>
            )}
          </div>

          <button
            className={`give-btn ${soldOut ? 'give-btn-soldout' : ''}`}
            onClick={() => tap('give_cup')}
            disabled={busy || !stats || soldOut}
          >
            {soldOut ? 'SOLD OUT' : busy ? 'Saving…' : '+1 cup given'}
          </button>

          <div className="undo-row">
            <button className="btn btn-undo" onClick={() => tap('undo_cup')} disabled={busy || !stats || given === 0}>
              − Undo 1
            </button>
          </div>
        </div>
      )}

      {tab === 'rsvps' && <RsvpSearch pin={pin} onError={handleError} />}

      {tab === 'stats' && <Stats pin={pin} stats={stats} confirmedAt={confirmedAt} onError={handleError} onLogout={onLogout} />}
    </main>
  )
}

function RsvpSearch({ pin, onError }: { pin: string; onError: (e: unknown) => void }) {
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Rsvp[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const reqSeq = useRef(0)

  useEffect(() => {
    const seq = ++reqSeq.current
    const t = setTimeout(async () => {
      try {
        const r = await rpc<Rsvp[]>('search_rsvps', { p_pin: pin, p_q: q })
        if (seq !== reqSeq.current) return
        setRows(r)
        setError(null)
      } catch (err) {
        if (seq !== reqSeq.current) return
        onError(err)
        setError("Search failed — can't reach server.")
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q, pin])

  const toggle = async (row: Rsvp) => {
    setPending(row.id)
    try {
      const r = await rpc<Rsvp[]>('mark_arrived', { p_pin: pin, p_id: row.id, p_arrived: !row.arrived_at })
      if (r[0]) setRows((rs) => rs?.map((x) => (x.id === row.id ? r[0] : x)) ?? rs)
      setError(null)
    } catch (err) {
      onError(err)
      setError(`NOT SAVED — tap ${row.name} again.`)
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="card">
      <p className="muted small">Ticking "arrived" is only for show-up stats. It does not change the cup count.</p>
      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or @handle" autoCapitalize="none" />
      {error && <p className="form-error" role="alert">{error}</p>}
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No RSVPs match.</p>
      ) : (
        <ul className="rsvp-list">
          {rows.map((r) => (
            <li key={r.id} className="rsvp-row">
              <div className="rsvp-who">
                <div className="rsvp-name">{r.name}</div>
                {r.tele_handle && <div className="muted small">@{r.tele_handle}</div>}
              </div>
              <button
                className={`btn btn-arrive ${r.arrived_at ? 'btn-arrived' : ''}`}
                onClick={() => toggle(r)}
                disabled={pending === r.id}
              >
                {pending === r.id ? '…' : r.arrived_at ? `✓ ${formatClock(new Date(r.arrived_at)).slice(0, 5)}` : 'Arrived?'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows?.length === 50 && <p className="muted small">Showing first 50 — type to narrow down.</p>}
    </section>
  )
}

function Stats({
  pin,
  stats,
  confirmedAt,
  onError,
  onLogout,
}: {
  pin: string
  stats: DoorStats | null
  confirmedAt: Date | null
  onError: (e: unknown) => void
  onLogout: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const rows = await rpc<Rsvp[]>('export_rsvps', { p_pin: pin })
      downloadCsv(rows)
    } catch (err) {
      onError(err)
      setError("Export failed — can't reach server.")
    } finally {
      setBusy(false)
    }
  }

  const item = (label: string, value: number | undefined) => (
    <div className="stat">
      <div className="stat-num">{value ?? '–'}</div>
      <div className="stat-label">{label}</div>
    </div>
  )

  return (
    <section className="card">
      <div className="stats-grid">
        {item('Cups given', stats?.cups_given)}
        {item('RSVPs total', stats?.rsvps_total)}
        {item('RSVPs arrived', stats?.rsvps_arrived)}
        {item('Walk-ins', stats?.walk_ins)}
      </div>
      <p className="muted small">
        Walk-ins = cups given − RSVPs arrived (min 0). Cup limit {stats?.cup_limit ?? '–'}.
        {confirmedAt && ` Updated ${formatClock(confirmedAt)}.`}
      </p>
      <button className="btn btn-primary" onClick={download} disabled={busy}>
        {busy ? 'Preparing…' : 'Download RSVPs (CSV)'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-secondary" onClick={onLogout}>
        Forget PIN on this phone
      </button>
    </section>
  )
}

function csvCell(v: string | number | null): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s // stop spreadsheets treating names as formulas
  return `"${s.replace(/"/g, '""')}"`
}

function downloadCsv(rows: Rsvp[]) {
  const header = ['id', 'name', 'telegram', 'rsvped_at', 'arrived_at']
  const lines = [header.join(',')].concat(
    rows.map((r) => [r.id, r.name, r.tele_handle, r.created_at, r.arrived_at].map(csvCell).join(',')),
  )
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `rsvps-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// Keep the door phone's screen awake where supported; harmless elsewhere.
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    const acquire = async () => {
      try {
        if (nav.wakeLock && document.visibilityState === 'visible') lock = await nav.wakeLock.request('screen')
      } catch {
        /* not allowed / unsupported */
      }
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      lock?.release().catch(() => {})
    }
  }, [])
}
