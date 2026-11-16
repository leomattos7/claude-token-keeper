import type { EngineInterface, Register } from 'claude-code'

type Dollar = EngineInterface

// Same endpoint and public client id Claude Code uses for its own refresh (read from the 2.1.325 binary).
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
// Claude Code's own refresh lock (a directory created with mkdir, stale after 60 s): taking the same one
// keeps us and Claude Code from refreshing the same account at the same time.
const LOCK_NAME = '.oauth_refresh.lock'
const LOCK_STALE_MS = 60_000
const MINUTE = 60_000
const FETCH_TIMEOUT_MS = 30_000
// Temp file created exclusively (noclobber, after removing any leftover or planted one) with mode 0600, then
// renamed over the original; removed if anything fails. The tokens arrive on stdin, never in argv.
const SAVE_SCRIPT = 'umask 077; rm -f "$1"; set -C; cat > "$1" && mv -f "$1" "$2" || { rm -f "$1"; exit 1; }'

// Identifies this loaded module in the lease file; a /clear keeps the process, and so the lease.
const HOLDER = crypto.randomUUID()

type Credentials = { claudeAiOauth: Record<string, any>; [key: string]: unknown }
type Read = { creds: Credentials; mtimeMs: number; isLink: boolean }
type AccountState = { lastRefreshAt?: number; lastError?: string; needsLoginMtime?: number; toasted?: boolean }
// $ may only be handed to functions declared at the top of this file, so what the hooks share lives here.
type Ctx = {
  accounts: string
  checkEvery: number
  refreshBefore: number
  states: Map<string, AccountState>
  rotated: Map<string, string> // hashes of refresh tokens this mod rotated away, and the dir each came from
  ticking: boolean
  timer?: { cancel: () => void }
}

function stateOf(c: Ctx, dir: string): AccountState {
  let s = c.states.get(dir)
  if (!s) c.states.set(dir, (s = {}))
  return s
}

async function readCreds($: Dollar, file: string): Promise<Read | undefined> {
  try {
    const creds = JSON.parse(await $.fs.read(file))
    const { mtimeMs, isLink } = await $.fs.stat(file)
    return creds?.claudeAiOauth ? { creds, mtimeMs, isLink } : undefined
  } catch {
    return undefined
  }
}

// Why an account cannot be refreshed: a symlinked file is never rewritten, and an empty refresh token has nothing to send.
function problem(read: Read): string | undefined {
  if (read.isLink) return 'skipped (credentials file is a symlink)'
  const token = read.creds.claudeAiOauth.refreshToken
  if (typeof token !== 'string' || !token) return 'skipped (no refresh token)'
}

// First 8 bytes of SHA-256, hex: names a lease file and spots copies of one login; never shown or stored.
async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function resolveAccounts($: Dollar, c: Ctx): Promise<string[]> {
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/$/, '')
  if (c.accounts === 'current') return [(await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`]
  if (c.accounts !== 'auto') {
    const dirs = c.accounts.split(',').map((s) => s.trim().replace(/^~(?=\/|$)/, home).replace(/\/$/, ''))
    return [...new Set(dirs.filter(Boolean))]
  }
  const dirs = [`${home}/.claude`]
  for (const entry of await $.fs.list(home).catch(() => [])) {
    const dir = `${home}/${entry.name}`
    if (entry.name.startsWith('.claude-') && entry.kind !== 'file' && (await readCreds($, `${dir}/.credentials.json`))) dirs.push(dir)
  }
  return dirs
}

// One lease file per set of accounts, so sessions that look after different accounts do not block each other.
async function leaseFile($: Dollar, dirs: string[]): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const base = (await $.env.get('XDG_STATE_HOME')) || `${home}/.local/state`
  return `${base}/claude-token-keeper/lease-${await sha([...dirs].sort().join('\n'))}.json`
}

// Only one open session refreshes at a time. Two sessions can both take an expired lease in the same
// instant; the per-account lock and the re-read under it still keep that to one request.
async function holdsLease($: Dollar, c: Ctx, dirs: string[], now: number): Promise<boolean> {
  const file = await leaseFile($, dirs)
  const lease = await $.fs.read(file).then(JSON.parse, () => undefined)
  if (lease && lease.holder !== HOLDER && lease.until > now) return false
  await $.fs.write(file, JSON.stringify({ holder: HOLDER, until: now + 2 * c.checkEvery }))
  return true
}

async function releaseLease($: Dollar, c: Ctx) {
  const file = await leaseFile($, await resolveAccounts($, c))
  const lease = await $.fs.read(file).then(JSON.parse, () => undefined)
  if (lease?.holder === HOLDER) await $.fs.write(file, JSON.stringify({ holder: HOLDER, until: 0 }))
}

// Returns the lock directory's mtime as we created it (so release can tell it is still ours), or undefined.
async function takeLock($: Dollar, lock: string, now: number): Promise<number | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await $.process.run(['mkdir', lock])).exitCode === 0) {
      const mtimeMs = await $.fs.stat(lock).then((s) => s.mtimeMs, () => undefined)
      if (mtimeMs !== undefined) return mtimeMs
      await $.process.run(['rmdir', lock]) // cannot tell later whether it is still ours: do not hold it
      return undefined
    }
    const age = await $.fs.stat(lock).then((s) => now - s.mtimeMs, () => 0)
    if (age < LOCK_STALE_MS) return undefined
    // Rename before deleting so two breakers never delete the same directory. A lock that went live again
    // between the check and the rename can still be broken (a window of microseconds, accepted).
    const aside = `${lock}.stale-${crypto.randomUUID()}`
    await $.process.run(['mv', lock, aside])
    await $.process.run(['rmdir', aside])
  }
  return undefined
}

// Release only a lock that is still the one we created: after a stall past the stale limit it may be someone else's.
async function releaseLock($: Dollar, lock: string, mtimeMs: number) {
  const now = await $.fs.stat(lock).then((s) => s.mtimeMs, () => undefined)
  if (now === mtimeMs) await $.process.run(['rmdir', lock]).catch(() => undefined)
}

async function save($: Dollar, file: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await $.process.run(['sh', '-c', SAVE_SCRIPT, 'sh', `${file}.tk-tmp`, file], { stdin: text }).catch(() => undefined)
    if (run?.exitCode === 0) return true
  }
  return false
}

// The token endpoint, raced against a timer so a hung request cannot hold the lock or the tick forever.
async function requestToken($: Dollar, body: Record<string, string>) {
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = $.clock.after(FETCH_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    return await Promise.race([
      $.http.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined),
      timeout,
    ])
  } finally {
    timer?.cancel()
  }
}

const isDue = (c: Ctx, oauth: Record<string, any>, now: number, force: boolean) => force || now >= oauth.expiresAt - c.refreshBefore

async function refresh($: Dollar, c: Ctx, dir: string, force: boolean, seen: Map<string, string>) {
  const state = stateOf(c, dir)
  const file = `${dir}/.credentials.json`
  const lock = `${dir}/${LOCK_NAME}`
  const first = await readCreds($, file)
  if (!first) {
    state.lastError = 'skipped (no credentials file)'
    return
  }
  const bad = problem(first)
  if (bad) {
    state.lastError = bad
    return
  }
  // Copies of one login (a copied config dir) would each spend the same refresh token: handle it once per tick.
  const hash = await sha(first.creds.claudeAiOauth.refreshToken)
  const twin = seen.get(hash)
  if (twin) {
    state.lastError = `same login as ${twin}`
    return
  }
  seen.set(hash, dir)
  const rotatedFrom = c.rotated.get(hash)
  if (rotatedFrom) {
    state.lastError = `stale copy of ${rotatedFrom}` // its refresh token was rotated away: the server would refuse it
    return
  }
  if (!force && first.mtimeMs === state.needsLoginMtime) return
  if (!isDue(c, first.creds.claudeAiOauth, await $.clock.now(), force)) return
  const mine = await takeLock($, lock, await $.clock.now())
  if (mine === undefined) {
    state.lastError = 'another process is refreshing'
    return
  }
  try {
    // Claude Code (or another session) may have refreshed while we waited for the lock.
    const current = await readCreds($, file)
    if (!current || problem(current) || !isDue(c, current.creds.claudeAiOauth, await $.clock.now(), force)) return
    const old = current.creds.claudeAiOauth

    const res = await requestToken($, {
      grant_type: 'refresh_token',
      refresh_token: old.refreshToken,
      client_id: old.clientId ?? CLIENT_ID,
      ...(old.scopes?.length ? { scope: old.scopes.join(' ') } : {}),
    })
    if (!res) {
      state.lastError = 'network error'
      return
    }
    let data: any
    try {
      data = JSON.parse(res.text)
    } catch {
      // Falls through to the status or "unexpected response".
    }
    const code = typeof data?.error === 'string' ? data.error : data?.error?.type
    if ((res.status === 400 || res.status === 401) && code === 'invalid_grant') {
      state.lastError = 'needs login'
      state.needsLoginMtime = current.mtimeMs
      if (!state.toasted) {
        state.toasted = true
        $.ui.toast(`token-keeper: ${dir} needs "claude auth login" (CLAUDE_CONFIG_DIR=${dir})`, { timeoutMs: 15000 })
      }
      return
    }
    if (!res.ok || typeof data?.access_token !== 'string' || typeof data?.expires_in !== 'number') {
      state.lastError = res.ok ? 'unexpected response' : `http ${res.status}`
      return
    }

    // Something may have written the file while the request was out: never overwrite a login we did not read.
    const latest = await readCreds($, file)
    if (!latest || problem(latest) || latest.creds.claudeAiOauth.refreshToken !== old.refreshToken) {
      state.lastError = 'credentials changed during the refresh; not saved'
      return
    }
    const now = await $.clock.now()
    const oauth: Record<string, any> = {
      ...latest.creds.claudeAiOauth,
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : old.refreshToken,
      expiresAt: now + data.expires_in * 1000,
    }
    if (typeof data.refresh_token_expires_in === 'number') oauth.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000
    if (typeof data.scope === 'string' && data.scope) oauth.scopes = data.scope.split(' ').filter(Boolean)

    if (await save($, file, JSON.stringify({ ...latest.creds, claudeAiOauth: oauth }))) {
      state.lastRefreshAt = now
      if (oauth.refreshToken !== old.refreshToken) c.rotated.set(await sha(old.refreshToken), dir)
      state.lastError = undefined
      state.needsLoginMtime = undefined
    } else {
      // The server may already have rotated the refresh token: tell the person, do not stay silent.
      state.lastError = 'could not save the refreshed login'
      $.ui.toast(`token-keeper: could not save the refreshed login of ${dir}; if it is logged out, run "claude auth login" (CLAUDE_CONFIG_DIR=${dir})`, {
        timeoutMs: 15000,
      })
    }
  } finally {
    await releaseLock($, lock, mine)
  }
}

async function tick($: Dollar, c: Ctx, force: boolean) {
  const dirs = await resolveAccounts($, c)
  if (!force && !(await holdsLease($, c, dirs, await $.clock.now()))) return
  const seen = new Map<string, string>()
  for (const dir of dirs) {
    try {
      await refresh($, c, dir, force, seen)
    } catch {
      stateOf(c, dir).lastError = 'unexpected error'
    }
  }
}

async function guardedTick($: Dollar, c: Ctx) {
  if (c.ticking) return
  c.ticking = true
  try {
    await tick($, c, false)
  } catch {
    // Next tick tries again.
  } finally {
    c.ticking = false
  }
}

function span(ms: number): string {
  if (ms <= 0) return 'expired'
  const days = Math.floor(ms / 86_400_000)
  if (days >= 1) return `${days}d`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / MINUTE)}m`
}

async function report($: Dollar, c: Ctx): Promise<string> {
  const now = await $.clock.now()
  const lines = ['token-keeper']
  for (const dir of await resolveAccounts($, c)) {
    const state = stateOf(c, dir)
    const read = await readCreds($, `${dir}/.credentials.json`)
    if (!read) {
      lines.push(`${dir}: no credentials file`)
      continue
    }
    const oauth = read.creds.claudeAiOauth
    const age = state.lastRefreshAt === undefined ? undefined : now - state.lastRefreshAt
    const refreshed = age === undefined ? 'never (this session)' : age < MINUTE ? 'just now' : `${span(age)} ago`
    const login = typeof oauth.refreshTokenExpiresAt === 'number' ? span(oauth.refreshTokenExpiresAt - now) : 'unknown'
    lines.push(
      `${dir}: access token expires in ${span(oauth.expiresAt - now)}, login expires in ${login}, last refresh ${refreshed}, last error ${state.lastError ?? 'none'}`,
    )
  }
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const c: Ctx = {
    accounts: String(options.accounts ?? 'auto').trim(),
    checkEvery: Math.max(1, Number(options.checkEveryMinutes ?? 10)) * MINUTE,
    refreshBefore: Math.max(1, Number(options.refreshBeforeMinutes ?? 30)) * MINUTE,
    states: new Map(),
    rotated: new Map(),
    ticking: false,
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'token-keeper',
        description: 'Show the Claude logins token-keeper maintains; "now" forces a refresh.',
        argumentHint: '[now]',
      })
    } catch {
      // The command is a convenience; keeping the logins fresh must go on without it.
    }
    c.timer?.cancel()
    c.timer = $.clock.every(c.checkEvery, () => void guardedTick($, c))
    void guardedTick($, c)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // After /clear the process goes on under a new session and no session.start follows: keep ticking.
    if (e.reason !== 'clear') {
      c.timer?.cancel()
      c.timer = undefined
      await releaseLease($, c).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'token-keeper' }, async ($, e) => {
    if (e.args.trim() === 'now') await tick($, c, true)
    return { text: await report($, c) }
  })
}
