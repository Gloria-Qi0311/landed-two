// Set a new password for an account, from a terminal on the server — for
// the owner who forgot theirs (passwords are stored only as scrypt hashes,
// so they can't be looked up). Asks for the new password twice without
// echoing it, then signs the account out everywhere.
//
//   cd apps/server && node --env-file=.env src/reset-password.ts you@example.com
//
// `--stdin` reads the two lines from standard input instead (tests, scripts).
import { createInterface } from 'node:readline'
import { hashPassword } from './auth.ts'
import { connect } from './db.ts'

const args = process.argv.slice(2)
const email = (args.find((a) => !a.startsWith('--')) ?? '').trim().toLowerCase()
const fromStdin = args.includes('--stdin')

if (!email) {
  console.error('Usage: node --env-file=.env src/reset-password.ts <email>')
  process.exit(2)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — run this from apps/server with --env-file=.env')
  process.exit(2)
}

/** A line typed without showing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question)
    const chars: string[] = []
    process.stdin.setRawMode(true)
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    const onData = (input: string) => {
      for (const ch of input) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(chars.join(''))
        }
        if (ch === '\u0003') { // Ctrl-C
          process.stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') chars.pop()
        else chars.push(ch)
      }
    }
    process.stdin.on('data', onData)
  })
}

async function readTwo(): Promise<[string, string]> {
  if (fromStdin) {
    const lines: string[] = []
    for await (const line of createInterface({ input: process.stdin })) {
      lines.push(line)
      if (lines.length === 2) break
    }
    return [lines[0] ?? '', lines[1] ?? '']
  }
  if (!process.stdin.isTTY) {
    console.error('Run this in a terminal (with ssh, use ssh -t), or pass --stdin.')
    process.exit(2)
  }
  return [await askHidden('New password: '), await askHidden('Again: ')]
}

const sql = connect(process.env.DATABASE_URL)
try {
  const [user] = await sql<{ id: string }[]>`select id from users where email = ${email}`
  if (!user) {
    console.error(`No account with the email ${email}.`)
    process.exitCode = 1
  } else {
    const [password, again] = await readTwo()
    if (password !== again) {
      console.error("The two passwords don't match. Nothing changed.")
      process.exitCode = 1
    } else if (password.length < 8 || password.length > 1024) {
      console.error('The password must be 8–1024 characters. Nothing changed.')
      process.exitCode = 1
    } else {
      const hash = await hashPassword(password)
      const signedOut = await sql.begin(async (tx) => {
        await tx`update users set password_hash = ${hash} where id = ${user.id}`
        return tx`delete from sessions where user_id = ${user.id} returning 1`
      })
      console.log(`Done: ${email} has a new password. Signed out of ${signedOut.length} session${signedOut.length === 1 ? '' : 's'} — sign in again with it.`)
    }
  }
} finally {
  await sql.end({ timeout: 5 })
}
