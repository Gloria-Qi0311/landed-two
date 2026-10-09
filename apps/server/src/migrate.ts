// Applies migrations/*.sql in filename order, each in its own transaction,
// recording applied names in schema_migrations. Run: pnpm --filter @landed/server migrate
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { connect, type Sql } from './db.ts'

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name))
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const name of files) {
    if (done.has(name)) continue
    const text = await readFile(DIR + name, 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`insert into schema_migrations (name) values (${name})`
    })
    log(`applied ${name}`)
    applied.push(name)
  }
  return applied
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL must be set')
  const sql = connect(url)
  const applied = await migrate(sql, console.log)
  if (applied.length === 0) console.log('up to date')
  await sql.end()
}
