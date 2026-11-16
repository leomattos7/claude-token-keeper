import { expect, mock, test } from 'claude-code/testing'

const HOME = '/home/u'
const MIN = 60_000
const T0 = 1_800_000_000_000
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const ALL_TOKENS = ['AT-old-secret', 'RT-old-secret', 'AT-new-secret', 'RT-new-secret']

const creds = (expiresAt: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'AT-old-secret',
      refreshToken: 'RT-old-secret',
      expiresAt,
      refreshTokenExpiresAt: T0 + 25 * 86_400_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      ...over,
    },
    mcpOAuth: { server: { keep: ['me'] } },
    unknownKey: { nested: true },
  })

const okReply = (over: Record<string, unknown> = {}) => ({
  status: 200,
  ok: true,
  headers: {},
  text: JSON.stringify({
    access_token: 'AT-new-secret',
    refresh_token: 'RT-new-secret',
    expires_in: 28800,
    refresh_token_expires_in: 2_592_000,
    scope: 'user:inference user:profile',
    ...over,
  }),
})

type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

// The world beneath the plugin: files, lock directories, the token endpoint, toasts and every argv, in memory.
function world(on: any, clock: { now: () => number }, init: { files?: Record<string, string>; entries?: Entry[]; reply?: () => unknown } = {}) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const dirs = new Map<string, number>()
  const w = {
    files,
    dirs,
    requests: [] as { url: string; init: any }[],
    toasts: [] as string[],
    statuses: [] as unknown[],
    stores: [] as unknown[],
    argvs: [] as string[][],
    writes: [] as { script: string; tmp: string; file: string }[],
    reply: init.reply ?? (() => okReply()),
    failSave: false,
    onLock: undefined as undefined | ((dir: string) => void),
    put(path: string, text: string) {
      files.set(path, { text, mtimeMs: clock.now() })
    },
    text: (path: string) => files.get(path)?.text,
    oauth: (path: string) => JSON.parse(files.get(path)!.text).claudeAiOauth,
  }
  for (const [path, text] of Object.entries(init.files ?? {})) w.put(path, text)

  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path)!.text } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => {
    w.put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($: any, e: any) => {
    const f = files.get(e.path)
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    if (dirs.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: dirs.get(e.path), isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('fs.list', () => ({ value: (init.entries ?? []).map((x) => ({ ...x, size: 0, mtimeMs: 0, isLink: false })) }))
  on('process.run', ($: any, e: any) => {
    w.argvs.push([...e.argv])
    const [cmd, a, script, , tmp, file] = e.argv
    const done = (exitCode: number) => ({ value: { exitCode, stdout: '', stderr: '' } })
    if (cmd === 'mkdir') {
      if (dirs.has(a)) return done(1)
      dirs.set(a, clock.now())
      w.onLock?.(a)
      return done(0)
    }
    if (cmd === 'rmdir') return done(dirs.delete(a) ? 0 : 1)
    if (cmd === 'sh') {
      if (w.failSave) return done(1)
      w.writes.push({ script, tmp, file })
      w.put(file, e.init.stdin)
      return done(0)
    }
    return { deny: `unexpected command ${cmd}` }
  })
  on('http.fetch', ($: any, e: any) => {
    w.requests.push({ url: e.url, init: e.init })
    const reply = w.reply()
    return reply === 'network' ? { deny: 'network down' } : { value: reply }
  })
  on('ui.toast', ($: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($: any, e: any) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('store.set', ($: any, e: any) => {
    w.stores.push(e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'token-keeper' } }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  return w
}

const start = ($: any) => $.session.start({ cwd: '/w', surface: null, isInteractive: false })
const end = ($: any, reason = 'other') => $.session.end({ reason, sessionId: 's1', resume: {} })
const status = async ($: any, args = '') => (await $.command.run({ command: 'token-keeper', args })).text as string

const CRED = `${HOME}/.claude/.credentials.json`
const LOCK = `${HOME}/.claude/.oauth_refresh.lock`
const LEASE = `${HOME}/.local/state/claude-token-keeper/lease.json`

test('a token outside the window is left alone; inside it, one request rotates it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 40 * MIN) } })
  const before = w.text(CRED)

  await start($)
  await clock.settle()
  expect(w.requests.length).toBe(0)
  expect(w.text(CRED)).toBe(before)

  await clock.advance(10 * MIN) // the next tick finds the token 30 minutes from expiry
  expect(w.requests.length).toBe(1)
  expect(w.requests[0]!.url).toBe(TOKEN_URL)
  expect(w.requests[0]!.init.method).toBe('POST')
  expect(JSON.parse(w.requests[0]!.init.body)).toEqual({
    grant_type: 'refresh_token',
    refresh_token: 'RT-old-secret',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'user:inference user:profile',
  })
  const now = clock.now()
  expect(w.oauth(CRED)).toMatchObject({
    accessToken: 'AT-new-secret',
    refreshToken: 'RT-new-secret',
    expiresAt: now + 28800 * 1000,
    refreshTokenExpiresAt: now + 2_592_000 * 1000,
  })

  await clock.advance(10 * MIN) // fresh again: no second rotation
  expect(w.requests.length).toBe(1)
})

test('other keys survive and the write is a 0600 temp file renamed over the original', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN) } })

  await start($)
  await clock.settle()

  const saved = JSON.parse(w.text(CRED)!)
  expect(saved.mcpOAuth).toEqual({ server: { keep: ['me'] } })
  expect(saved.unknownKey).toEqual({ nested: true })
  expect(saved.claudeAiOauth.subscriptionType).toBe('max')
  expect(w.writes.length).toBe(1)
  expect(w.writes[0]!.script).toContain('umask 077')
  expect(w.writes[0]!.script).toContain('mv -f')
  expect(w.writes[0]!.tmp).toBe(`${CRED}.tk-tmp`)
  expect(w.writes[0]!.file).toBe(CRED)
  expect(w.dirs.has(LOCK)).toBe(false) // lock released

})

test('only the lease holder refreshes, and an expired lease is taken over', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const lease = JSON.stringify({ holder: 'another-session', until: T0 + 5 * MIN })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN), [LEASE]: lease } })

  await start($)
  await clock.settle()
  expect(w.requests.length).toBe(0)
  expect(JSON.parse(w.text(LEASE)!).holder).toBe('another-session')

  await clock.advance(10 * MIN) // the other session's lease ran out
  expect(w.requests.length).toBe(1)
  const taken = JSON.parse(w.text(LEASE)!)
  expect(taken.holder).not.toBe('another-session')
  expect(taken.until).toBe(clock.now() + 20 * MIN)

  await end($) // leaving frees the lease for the other open sessions
  expect(JSON.parse(w.text(LEASE)!).until).toBe(0)
})

test('a lock held by another process blocks, a stale one is taken, a refresh that landed meanwhile is not repeated', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN) } })
  w.dirs.set(LOCK, T0 - 10_000) // Claude Code itself is refreshing

  await start($)
  await clock.settle()
  expect(w.requests.length).toBe(0)
  expect(await status($)).toContain('another process is refreshing')

  w.dirs.set(LOCK, T0 - 90_000) // its holder died: stale after 60 s
  await clock.advance(10 * MIN)
  expect(w.requests.length).toBe(1)

  // Someone else lands a fresh token between our first read and the lock.
  w.put(CRED, creds(T0 + 5 * MIN))
  w.onLock = () => w.put(CRED, creds(clock.now() + 8 * 60 * MIN, { accessToken: 'AT-new-secret' }))
  await clock.advance(10 * MIN)
  expect(w.requests.length).toBe(1)
  expect(w.oauth(CRED).accessToken).toBe('AT-new-secret')
  expect(w.dirs.has(LOCK)).toBe(false)
})

test('a refused refresh leaves the file alone, toasts once and waits for the file to change', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN) }, reply: () => ({ status: 400, ok: false, headers: {}, text: '{"error":"invalid_grant"}' }) })
  const before = w.text(CRED)

  await start($)
  await clock.settle()
  expect(w.requests.length).toBe(1)
  expect(w.text(CRED)).toBe(before)
  expect(w.toasts).toEqual([`token-keeper: ${HOME}/.claude needs "claude auth login" (CLAUDE_CONFIG_DIR=${HOME}/.claude)`])

  await clock.advance(30 * MIN) // three more ticks, no retries
  expect(w.requests.length).toBe(1)
  expect(await status($)).toContain('last error needs login')

  w.put(CRED, creds(clock.now() + 5 * MIN)) // the file changed (a new login): try again, no second toast
  await clock.advance(10 * MIN)
  expect(w.requests.length).toBe(2)
  expect(w.toasts.length).toBe(1)
})

test('a network error is retried on the next tick without a toast', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  let down = true
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN) }, reply: () => (down ? 'network' : okReply()) })

  await start($)
  await clock.settle()
  expect(w.requests.length).toBe(1)
  expect(w.toasts.length).toBe(0)
  expect(w.oauth(CRED).accessToken).toBe('AT-old-secret')

  down = false
  await clock.advance(10 * MIN)
  expect(w.requests.length).toBe(2)
  expect(w.oauth(CRED).accessToken).toBe('AT-new-secret')
})

test('a refreshed login that cannot be saved is reported, not silent', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN) } })
  w.failSave = true

  await start($)
  await clock.settle()
  expect(w.argvs.filter((a) => a[0] === 'sh').length).toBe(3) // three attempts
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('could not save the refreshed login')
  expect(w.oauth(CRED).accessToken).toBe('AT-old-secret')
})

test('accounts=auto refreshes ~/.claude and every ~/.claude-* dir with a login', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const due = creds(T0 + 5 * MIN)
  const w = world(on, clock, {
    files: {
      [CRED]: due,
      [`${HOME}/.claude-pessoal/.credentials.json`]: creds(T0 + 5 * MIN, { refreshToken: 'RT-pessoal' }),
      [`${HOME}/.claude-empty/.credentials.json`]: JSON.stringify({ somethingElse: 1 }),
      [`${HOME}/.other/.credentials.json`]: due,
    },
    entries: [
      { name: '.claude', kind: 'dir' },
      { name: '.claude-pessoal', kind: 'dir' },
      { name: '.claude-empty', kind: 'dir' },
      { name: '.claude-file', kind: 'file' },
      { name: '.other', kind: 'dir' },
    ],
  })

  await start($)
  await clock.settle()
  const sent = w.requests.map((r) => JSON.parse(r.init.body).refresh_token).sort()
  expect(sent).toEqual(['RT-old-secret', 'RT-pessoal'])
  expect(w.text(`${HOME}/.claude-empty/.credentials.json`)).toBe(JSON.stringify({ somethingElse: 1 }))
  expect(w.text(`${HOME}/.other/.credentials.json`)).toBe(due)
})

test('accounts=current uses the session config dir', { options: { accounts: 'current' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: `${HOME}/.claude-pessoal` })
  const w = world(on, clock, {
    files: { [CRED]: creds(T0 + 5 * MIN), [`${HOME}/.claude-pessoal/.credentials.json`]: creds(T0 + 5 * MIN, { refreshToken: 'RT-pessoal' }) },
  })

  await start($)
  await clock.settle()
  expect(w.requests.map((r) => JSON.parse(r.init.body).refresh_token)).toEqual(['RT-pessoal'])
})

test('accounts as a list takes ~, drops a trailing slash and never creates a missing credentials file', { options: { accounts: '~/.claude, /srv/acct/, ~/missing' } }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN), '/srv/acct/.credentials.json': creds(T0 + 5 * MIN, { refreshToken: 'RT-srv' }) } })

  await start($)
  await clock.settle()
  expect(w.requests.map((r) => JSON.parse(r.init.body).refresh_token).sort()).toEqual(['RT-old-secret', 'RT-srv'])
  const text = await status($)
  expect(text).toContain('/home/u/missing: no credentials file')
  expect(w.files.has('/home/u/missing/.credentials.json')).toBe(false)
  expect(w.writes.map((x) => x.file).sort()).toEqual([CRED, '/srv/acct/.credentials.json'])
})

test('no token appears in a toast, a status line, the command output, the store or an argv', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * MIN) } })

  await start($) // refreshes: tokens move through the write
  await clock.settle()
  w.failSave = true
  w.reply = () => ({ status: 401, ok: false, headers: {}, text: '{"error":"RT-old-secret"}' })
  await status($, 'now') // refused: toast
  w.reply = () => okReply()
  await status($, 'now') // save fails: toast

  expect(w.toasts.length).toBeGreaterThan(0)
  const surfaces = [...w.toasts, ...w.statuses.map(String), await status($), await status($, 'now'), JSON.stringify(w.stores), ...w.argvs.map((a) => a.join(' '))]
  for (const text of surfaces) for (const token of ALL_TOKENS) expect(text).not.toContain(token)
  expect(w.stores.length).toBe(0)
})

test('/token-keeper shows each account; "now" refreshes even a fresh token', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 5 * 60 * MIN + 12 * MIN) } })

  await start($)
  await clock.settle()
  expect(w.requests.length).toBe(0)

  const plain = await status($)
  expect(plain).toBe(
    `token-keeper\n${HOME}/.claude: access token expires in 5h 12m, login expires in 25d, last refresh never (this session), last error none`,
  )
  expect(w.requests.length).toBe(0)

  const forced = await status($, 'now')
  expect(w.requests.length).toBe(1)
  expect(forced).toContain('access token expires in 8h 0m')
  expect(forced).toContain('login expires in 30d')
  expect(forced).toContain('last refresh just now')
})

test('after /clear the checks go on; after the session ends they stop', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME })
  const w = world(on, clock, { files: { [CRED]: creds(T0 + 40 * MIN) } })

  await start($)
  await clock.settle()
  await end($, 'clear')
  await clock.advance(10 * MIN)
  expect(w.requests.length).toBe(1)

  w.put(CRED, creds(clock.now() + 5 * MIN))
  await end($, 'prompt_input_exit')
  await clock.advance(30 * MIN)
  expect(w.requests.length).toBe(1)
})
