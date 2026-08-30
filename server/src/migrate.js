import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool, q } from './store.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

export async function migrate() {
  // One boot at a time, whatever the replica count.
  await q('select pg_advisory_lock(918111)')
  try {
    await q(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`)
    const done = new Set((await q('select name from schema_migrations')).rows.map((r) => r.name))
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files) {
      if (done.has(f)) continue
      await q(readFileSync(join(dir, f), 'utf8'))
      await q('insert into schema_migrations (name) values ($1)', [f])
      console.log(JSON.stringify({ level: 'info', msg: 'migration applied', file: f }))
    }
  } finally {
    await q('select pg_advisory_unlock(918111)')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => console.log('migrations ok'))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
