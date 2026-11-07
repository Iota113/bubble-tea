import { useState, type FormEvent } from 'react'
import { ApiError, rpc, type PublicStatus } from './api'
import { formatClock, formatSgt, storage, usePoll } from './util'

const POLL_MS = 5000
const LOW_THRESHOLD = 20

export default function PublicPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null)
  const [stale, setStale] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const refresh = async () => {
    try {
      setStatus(await rpc<PublicStatus>('get_public_status'))
      setUpdatedAt(new Date())
      setStale(false)
    } catch {
      setStale(true)
    }
  }
  usePoll(refresh, POLL_MS)

  return (
    <main className="page">
      {stale && (
        <div className="banner banner-warn" role="status">
          Can't reach the server{updatedAt ? ` — count last updated ${formatClock(updatedAt)}` : ''}. Retrying…
        </div>
      )}

      <Counter status={status} />

      <section className="card">
        <h1 className="title">🧋 {status?.event_name ?? 'Study Break: Free Bubble Tea Night'}</h1>
        <p className="info">
          <strong>{status?.event_time ?? '…'}</strong>
          <br />
          {status?.event_location ?? '…'}
        </p>
        <p className="muted">
          Free bubble tea + snacks before finals. Just turn up — no sign-up needed to collect.
          Cups are first come, first served while they last.
        </p>
      </section>

      <RsvpSection status={status} onClosed={refresh} />
    </main>
  )
}

function Counter({ status }: { status: PublicStatus | null }) {
  if (!status) {
    return (
      <section className="counter" aria-live="polite">
        <div className="counter-big">…</div>
        <div className="counter-label">Loading cups left</div>
      </section>
    )
  }
  const left = Math.max(status.cup_limit - status.cups_given, 0)

  if (left === 0) {
    return (
      <section className="counter counter-soldout" aria-live="polite">
        <div className="counter-big">SOLD OUT</div>
        <div className="counter-label">All {status.cup_limit} cups are gone. Thanks for coming!</div>
      </section>
    )
  }

  const low = left < LOW_THRESHOLD
  return (
    <section className={`counter ${low ? 'counter-low' : ''}`} aria-live="polite">
      {low && <div className="counter-flag">Running low!</div>}
      <div className="counter-big">
        {left}
        <span className="counter-of"> / {status.cup_limit}</span>
      </div>
      <div className="counter-label">cups left</div>
    </section>
  )
}

function RsvpSection({ status, onClosed }: { status: PublicStatus | null; onClosed: () => void }) {
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(() => storage.get('rsvp_name'))

  if (!status) return null

  if (!status.rsvp_open) {
    return (
      <section className="card">
        <h2>RSVPs closed</h2>
        <p className="muted">
          You can still just turn up — cups are first come, first served at the door.
        </p>
      </section>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Please enter your name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await rpc('submit_rsvp', { p_name: name, p_handle: handle })
      storage.set('rsvp_name', name.trim())
      setDone(name.trim())
      setName('')
      setHandle('')
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network'
      if (code === 'rsvp_closed') {
        setError('Sorry, RSVPs just closed. You can still turn up!')
        onClosed()
      } else if (code === 'name_required') {
        setError('Please enter your name.')
      } else {
        setError("Couldn't send your RSVP — check your connection and try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>RSVP</h2>
      <p className="note">
        RSVP is only to help us estimate food. <strong>It is not a reserved cup</strong> — cups are
        first come, first served on the night.
      </p>
      <p className="muted small">RSVPs close {formatSgt(status.rsvp_closes_at)}.</p>

      {done ? (
        <div className="success">
          <p>
            Thanks, <strong>{done}</strong>! You're counted. See you there.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              storage.remove('rsvp_name')
              setDone(null)
            }}
          >
            RSVP for someone else
          </button>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <label className="field">
            <span>Name *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoComplete="name"
              required
            />
          </label>
          <label className="field">
            <span>Telegram handle (optional)</span>
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              maxLength={41}
              placeholder="@yourhandle"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Sending…' : "I'm coming"}
          </button>
        </form>
      )}
    </section>
  )
}
