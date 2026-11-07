// End-to-end checks against a Supabase project (or the local fake, see README).
// Talks to the API with the *anon key* exactly like the browser does, and uses
// DATABASE_URL (the project's Postgres connection string) only to set up and
// restore state around the tests.
//
// DO NOT RUN DURING THE EVENT: it temporarily changes the PIN, deadline and cup
// count. Everything is restored at the end, and test RSVPs are deleted.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... DATABASE_URL=... npm run verify
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const DB = process.env.DATABASE_URL
if (!URL_ || !KEY || !DB) {
  console.error('Need SUPABASE_URL, SUPABASE_ANON_KEY and DATABASE_URL')
  process.exit(2)
}

const TEST_PIN = 'verify-' + Math.random().toString(36).slice(2)
const TEST_PREFIX = '__verify__'
const anon = createClient(URL_, KEY, { auth: { persistSession: false } })
const db = new pg.Client({ connectionString: DB })

let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`)
  if (!ok) failures++
}
const count = async () => (await db.query('select cups_given from settings')).rows[0].cups_given
const rpc = (fn, args) => anon.rpc(fn, args)

await db.connect()
const saved = (await db.query('select s.cups_given, s.cup_limit, s.rsvp_closes_at, x.door_pin_hash from settings s, secrets x')).rows[0]

try {
  await db.query(`select set_door_pin($1)`, [TEST_PIN])
  await db.query(`update settings set cups_given = 0, cup_limit = 150, rsvp_closes_at = now() + interval '1 hour'`)

  // ---- 1. Concurrency: 200 simultaneous taps must stop at exactly 150 ----
  const results = await Promise.all(Array.from({ length: 200 }, () => rpc('give_cup', { p_pin: TEST_PIN })))
  const errs = results.filter((r) => r.error)
  const ok = results.filter((r) => r.data?.status === 'ok')
  const sold = results.filter((r) => r.data?.status === 'sold_out')
  const seen = new Set(ok.map((r) => r.data.cups_given))
  check(errs.length === 0, '200 concurrent give_cup: no request errors', errs[0]?.error?.message)
  check(ok.length === 150 && sold.length === 50, '150 ok + 50 sold_out', `ok=${ok.length} sold_out=${sold.length}`)
  check(seen.size === 150 && Math.min(...seen) === 1 && Math.max(...seen) === 150, 'each ok got a unique count 1..150')
  check((await count()) === 150, 'final cups_given is exactly 150', `db=${await count()}`)

  // ---- 2. Wrong PIN changes nothing ----
  const before = await count()
  for (const [fn, args] of [
    ['give_cup', {}],
    ['undo_cup', {}],
    ['door_stats', {}],
    ['search_rsvps', { p_q: '' }],
    ['export_rsvps', {}],
    ['mark_arrived', { p_id: 1 }],
  ]) {
    for (const pin of ['wrong', '', null]) {
      const r = await rpc(fn, { p_pin: pin, ...args })
      check(r.error?.message === 'bad_pin' && r.data == null, `${fn} rejects pin=${JSON.stringify(pin)}`)
    }
  }
  check((await count()) === before, 'count unchanged after wrong-PIN calls')

  // ---- 3. Anon key cannot touch tables directly ----
  for (const t of ['settings', 'secrets', 'rsvps']) {
    const r = await anon.from(t).select('*')
    check(!!r.error || (r.data ?? []).length === 0, `anon cannot read ${t}`, r.error?.message ?? `rows=${r.data?.length}`)
  }
  const ins = await anon.from('rsvps').insert({ name: TEST_PREFIX + 'direct' })
  check(!!ins.error, 'anon cannot insert into rsvps', ins.error?.message)
  const upd = await anon.from('settings').update({ cups_given: 0 }).eq('id', true)
  check(!!upd.error && (await count()) === before, 'anon cannot update settings', upd.error?.message)
  const pinUpd = await anon.from('secrets').update({ door_pin_hash: 'x' }).eq('id', true)
  check(!!pinUpd.error, 'anon cannot update secrets', pinUpd.error?.message)
  for (const fn of ['_require_pin', 'set_door_pin']) {
    const args = fn === 'set_door_pin' ? { p_new_pin: 'hacked' } : { p_pin: TEST_PIN }
    const r = await rpc(fn, args)
    check(!!r.error, `anon cannot call ${fn}`, r.error?.message)
  }
  check((await rpc('door_stats', { p_pin: TEST_PIN })).error == null, 'PIN still the test PIN (not hijacked)')

  // ---- 4. Undo floors at 0 ----
  await db.query('update settings set cups_given = 1')
  const undos = await Promise.all([1, 2, 3].map(() => rpc('undo_cup', { p_pin: TEST_PIN })))
  check(undos.every((r) => !r.error) && (await count()) === 0, 'undo floors at 0', `db=${await count()}`)
  const sold2 = await db.query('update settings set cups_given = cup_limit')
  const g = await rpc('give_cup', { p_pin: TEST_PIN })
  check(g.data?.status === 'sold_out' && (await count()) === 150, 'give_cup at cap returns sold_out', sold2.rowCount + '')

  // ---- 5. RSVPs ----
  const r1 = await rpc('submit_rsvp', { p_name: `  ${TEST_PREFIX}Alice  `, p_handle: '@alice_t' })
  check(r1.data?.ok === true, 'RSVP accepted before deadline', r1.error?.message)
  const row = (await db.query(`select * from rsvps where name like $1 order by id desc limit 1`, [TEST_PREFIX + 'Alice'])).rows[0]
  check(row?.name === TEST_PREFIX + 'Alice' && row?.tele_handle === 'alice_t', 'name trimmed, @ stripped from handle')
  const r2 = await rpc('submit_rsvp', { p_name: TEST_PREFIX + 'x'.repeat(500), p_handle: 'h'.repeat(500) })
  const long = (await db.query(`select length(name) n, length(tele_handle) h from rsvps where name like $1 || 'xxx%'`, [TEST_PREFIX])).rows[0]
  check(!r2.error && long?.n === 80 && long?.h === 40, 'long name/handle truncated to 80/40', JSON.stringify(long))
  const r3 = await rpc('submit_rsvp', { p_name: '   ', p_handle: null })
  check(r3.error?.message === 'name_required', 'blank name rejected')

  const st = await rpc('door_stats', { p_pin: TEST_PIN })
  const found = await rpc('search_rsvps', { p_pin: TEST_PIN, p_q: '__verify__al' })
  check(found.data?.length === 1, 'search_rsvps finds by substring', `n=${found.data?.length}`)
  const wild = await rpc('search_rsvps', { p_pin: TEST_PIN, p_q: '%' })
  check(!wild.error && wild.data.every((x) => x.name.includes('%') || (x.tele_handle ?? '').includes('%')), '% is matched literally')
  const m = await rpc('mark_arrived', { p_pin: TEST_PIN, p_id: row.id })
  check(m.data?.[0]?.arrived_at != null, 'mark_arrived sets arrived_at')
  const st2 = await rpc('door_stats', { p_pin: TEST_PIN })
  check(st2.data.rsvps_arrived === st.data.rsvps_arrived + 1 && st2.data.cups_given === st.data.cups_given, 'arrived counted, cup count untouched')
  check(st2.data.walk_ins === Math.max(st2.data.cups_given - st2.data.rsvps_arrived, 0), 'walk_ins = given - arrived')
  await rpc('mark_arrived', { p_pin: TEST_PIN, p_id: row.id, p_arrived: false })
  const st3 = await rpc('door_stats', { p_pin: TEST_PIN })
  check(st3.data.rsvps_arrived === st.data.rsvps_arrived, 'mark_arrived(false) un-ticks')
  const exp = await rpc('export_rsvps', { p_pin: TEST_PIN })
  check(Array.isArray(exp.data) && exp.data.some((x) => x.id === Number(row.id)), 'export_rsvps returns rows')

  await db.query(`update settings set rsvp_closes_at = now() - interval '1 second'`)
  const late = await rpc('submit_rsvp', { p_name: TEST_PREFIX + 'Late', p_handle: '' })
  check(late.error?.message === 'rsvp_closed', 'RSVP rejected after deadline', late.error?.message)
  const lateRows = (await db.query(`select count(*)::int n from rsvps where name = $1`, [TEST_PREFIX + 'Late'])).rows[0].n
  check(lateRows === 0, 'late RSVP not stored')
  const pub = await rpc('get_public_status')
  check(pub.data?.rsvp_open === false && pub.data?.cup_limit === 150, 'public status shows rsvp_open=false')
} finally {
  await db.query(`delete from rsvps where name like $1`, [TEST_PREFIX + '%'])
  await db.query(`update settings set cups_given = $1, cup_limit = $2, rsvp_closes_at = $3`, [saved.cups_given, saved.cup_limit, saved.rsvp_closes_at])
  await db.query(`update secrets set door_pin_hash = $1`, [saved.door_pin_hash])
  await db.end()
  console.log('\nRestored original count, limit, deadline and PIN; deleted test RSVPs.')
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
