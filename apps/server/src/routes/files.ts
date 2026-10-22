// Files the extension uploads into application forms (Cloud accounts): the
// user's resume file and cover letter, one per kind. Mounted behind
// requireCloud — sync-off accounts keep theirs in the browser. The list is
// metadata only; the bytes come one file at a time.
import { parseApplicationFile, parseResumeFile, isFileKind } from '@landed/schema/application-files'
import { Hono } from 'hono'
import type { AppEnv } from '../auth.ts'
import type { Sql } from '../db.ts'
import { fail, jsonBody } from '../http.ts'

export const FILE_COLUMNS = ['id', 'kind', 'name', 'mime', 'size', 'data', 'created_at'] as const
const META = ['id', 'kind', 'name', 'mime', 'size', 'created_at']
export const RESUME_FILE_COLUMNS = ['id', 'resume_id', 'name', 'mime', 'size', 'data', 'created_at'] as const
const RESUME_META = ['id', 'resume_id', 'name', 'mime', 'size', 'created_at']

export function fileRoutes(sql: Sql) {
  const app = new Hono<AppEnv>()

  app.get('/application-files', async (c) => {
    return c.json(await sql`select ${sql(META)} from application_files where user_id = ${c.get('user').id} order by kind`)
  })

  app.get('/application-files/:kind/data', async (c) => {
    const kind = c.req.param('kind')
    if (!isFileKind(kind)) fail(404, 'no such file')
    const [row] = await sql`select id, data from application_files where user_id = ${c.get('user').id} and kind = ${kind}`
    if (!row) fail(404, 'no such file')
    return c.json(row)
  })

  // Replace this kind's file (a new id each time, so the extension sees the change).
  app.put('/application-files/:kind', async (c) => {
    const parsed = parseApplicationFile({ ...(await jsonBody(c)), kind: c.req.param('kind'), created_at: undefined })
    if (!parsed.ok) fail(400, parsed.error)
    const f = parsed.file
    const [row] = await sql`
      insert into application_files (id, user_id, kind, name, mime, size, data)
      values (${f.id}, ${c.get('user').id}, ${f.kind}, ${f.name}, ${f.mime}, ${f.size}, ${f.data})
      on conflict (user_id, kind) do update
        set id = excluded.id, name = excluded.name, mime = excluded.mime, size = excluded.size, data = excluded.data, created_at = now()
      returning ${sql(META)}`
    return c.json(row)
  })

  app.delete('/application-files/:kind', async (c) => {
    const kind = c.req.param('kind')
    if (!isFileKind(kind)) fail(404, 'no such file')
    await sql`delete from application_files where user_id = ${c.get('user').id} and kind = ${kind}`
    return c.body(null, 204)
  })

  // Each uploaded resume's own file (resume_files): a fill with that resume
  // uploads it. One per resume; it goes when the resume does.
  app.get('/resume-files', async (c) => {
    return c.json(await sql`select ${sql(RESUME_META)} from resume_files where user_id = ${c.get('user').id} order by created_at`)
  })

  app.get('/resume-files/:resumeId/data', async (c) => {
    const [row] = await sql`select id, data from resume_files where user_id = ${c.get('user').id} and resume_id = ${uuidParam(c.req.param('resumeId'))}`
    if (!row) fail(404, 'no such file')
    return c.json(row)
  })

  app.put('/resume-files/:resumeId', async (c) => {
    const parsed = parseResumeFile({ ...(await jsonBody(c)), resume_id: c.req.param('resumeId'), created_at: undefined })
    if (!parsed.ok) fail(400, parsed.error)
    const f = parsed.file
    const userId = c.get('user').id
    const [resume] = await sql`select id from resumes where id = ${f.resume_id} and user_id = ${userId}`
    if (!resume) fail(404, 'no such resume')
    const [row] = await sql`
      insert into resume_files (id, user_id, resume_id, name, mime, size, data)
      values (${f.id}, ${userId}, ${f.resume_id}, ${f.name}, ${f.mime}, ${f.size}, ${f.data})
      on conflict (user_id, resume_id) do update
        set id = excluded.id, name = excluded.name, mime = excluded.mime, size = excluded.size, data = excluded.data, created_at = now()
      returning ${sql(RESUME_META)}`
    return c.json(row)
  })

  app.delete('/resume-files/:resumeId', async (c) => {
    await sql`delete from resume_files where user_id = ${c.get('user').id} and resume_id = ${uuidParam(c.req.param('resumeId'))}`
    return c.body(null, 204)
  })

  return app
}

/** A path id that isn't a uuid finds nothing (instead of a database error). */
function uuidParam(v: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(v)) fail(404, 'no such file')
  return v
}
