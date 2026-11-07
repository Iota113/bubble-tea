// LOCAL TESTING ONLY. A tiny stand-in for Supabase's REST API (PostgREST) so the
// app and scripts/verify.mjs can run against a plain local Postgres.
// Every request runs as the `anon` role, exactly like the browser's anon key.
//
//   DATABASE_URL=postgres://postgres@localhost:54329/bt node scripts/local/fake-postgrest.mjs
//   -> serves http://localhost:54321  (use as VITE_SUPABASE_URL, any anon key)
import http from 'node:http'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 250 })
const PORT = Number(process.env.PORT || 54321)
const IDENT = /^[a-z_][a-z0-9_]*$/

const httpStatus = (code) =>
  code === '42501' ? 401 : code === '28P01' ? 403 : code === '42883' || code === '42P01' ? 404 : 400

async function asAnon(sql, params) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role anon')
    const r = await c.query(sql, params)
    await c.query('commit')
    return r
  } catch (e) {
    await c.query('rollback').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

async function handle(method, path, body) {
  const rpc = path.match(/^\/rest\/v1\/rpc\/([^/?]+)/)
  if (rpc && method === 'POST') {
    const fn = rpc[1]
    const keys = Object.keys(body || {})
    if (!IDENT.test(fn) || !keys.every((k) => IDENT.test(k))) return [400, { message: 'bad identifier' }]
    const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ')
    const meta = await pool.query(
      `select proretset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace limit 1`,
      [fn],
    )
    if (!meta.rows[0]) return [404, { code: 'PGRST202', message: `function ${fn} not found` }]
    const values = keys.map((k) => body[k])
    if (meta.rows[0].proretset) {
      const r = await asAnon(`select coalesce(json_agg(t), '[]'::json) as j from public.${fn}(${args}) t`, values)
      return [200, r.rows[0].j]
    }
    const r = await asAnon(`select public.${fn}(${args}) as j`, values)
    return [200, r.rows[0].j]
  }

  const table = path.match(/^\/rest\/v1\/([^/?]+)/)?.[1]
  if (!table || !IDENT.test(table)) return [404, { message: 'not found' }]
  if (method === 'GET') return [200, (await asAnon(`select * from public.${table}`)).rows]
  if (method === 'DELETE') return [200, (await asAnon(`delete from public.${table} returning *`)).rows]
  const rows = Array.isArray(body) ? body : [body]
  const cols = Object.keys(rows[0] || {}).filter((k) => IDENT.test(k))
  if (method === 'POST') {
    const r = await asAnon(
      `insert into public.${table} (${cols}) values (${cols.map((_, i) => `$${i + 1}`)}) returning *`,
      cols.map((k) => rows[0][k]),
    )
    return [201, r.rows]
  }
  if (method === 'PATCH') {
    const r = await asAnon(
      `update public.${table} set ${cols.map((k, i) => `${k} = $${i + 1}`)} returning *`,
      cols.map((k) => rows[0][k]),
    )
    return [200, r.rows]
  }
  return [405, { message: 'method not allowed' }]
}

http
  .createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', async () => {
      let status, payload
      try {
        ;[status, payload] = await handle(req.method, req.url, raw ? JSON.parse(raw) : {})
      } catch (e) {
        status = httpStatus(e.code)
        payload = { code: e.code, message: e.message, details: null, hint: null }
      }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
    })
  })
  .listen(PORT, () => console.log(`fake PostgREST on http://localhost:${PORT}`))
