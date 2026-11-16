# token-keeper

A Claude Code mod that keeps the OAuth login of one or more Claude config dirs fresh **while any Claude Code session is open**, so an account you rarely use does not end up logged out.

If you run more than one account (for example `~/.claude` for work and `~/.claude-personal` for yourself), the one you did not touch for weeks stops refreshing, and one day its refresh token is dead. token-keeper refreshes every account from whichever session is open, at the moment Claude Code itself would (just before the access token expires).

> This mod rewrites `.credentials.json` files. Read "How it works" and "Limits" before enabling it.

## Install

At the prompt of a terminal session:

```
/plugin install token-keeper --marketplace leomattos7/claude-token-keeper
```

From a shell:

```
claude plugin install token-keeper --marketplace leomattos7/claude-token-keeper
```

The plugin is called `token-keeper` (a plugin name may not start with `claude-`); the repository is `claude-token-keeper`. Requires Claude Code 2.1.287 or later (mods API). Tested on Linux and WSL with Claude Code 2.1.325.

## Options

Set them in `/plugin` (configure), or under `pluginConfigs["token-keeper"].options` in settings.json. None is secret.

| Option | Default | Meaning |
|---|---|---|
| `accounts` | `auto` | `auto`: `~/.claude` plus every `~/.claude-*` dir whose `.credentials.json` has a login. `current`: only this session's own config dir (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), for a single account with nothing to set up. Or a comma-separated list of dirs (`~` allowed). |
| `checkEveryMinutes` | `10` | How often the open sessions check the logins (minimum 1). |
| `refreshBeforeMinutes` | `30` | Refresh an account when its access token expires within this window, or already expired. A fresher token is never rotated (minimum 1). |

## Command

- `/token-keeper`: per account, when the access token expires, when the login (refresh token) expires, when token-keeper last refreshed it in this session, and the last error.
- `/token-keeper now`: refresh every configured account now, ignoring the window.

Tokens are never printed, logged, toasted or stored by the mod.

## How it works

- **One refresher across all open sessions.** A lease file at `${XDG_STATE_HOME:-~/.local/state}/claude-token-keeper/lease.json` (`{ holder, until }`) lets one session at a time do the checking; it renews the lease each tick (lease = 2 x the check interval) and frees it when the session ends. The mod's own `$.store` is a file under the Claude config dir, so it is per account (not shared between `~/.claude` and `~/.claude-personal`); that is why the lease is a plain file in a path both can see.
- **Same endpoint as Claude Code.** `POST https://platform.claude.com/v1/oauth/token` with `grant_type=refresh_token`, the stored refresh token, Claude Code's public client id and the stored scopes. The response fields used are `access_token`, `refresh_token` (the old one is kept if the response has none), `expires_in`, and, when present, `refresh_token_expires_in` and `scope`.
- **Same lock as Claude Code.** Before refreshing an account the mod creates `<config dir>/.oauth_refresh.lock` (a directory, stale after 60 s), the lock Claude Code takes for its own refresh. It then re-reads the credentials file and only goes on if the token is still inside the window.
- **Claude Code re-reads the file too.** Rotating a refresh token behind a running session is safe only if the session does not keep an old copy in memory. Claude Code 2.1.325 does the following (quoted from the binary, no secrets) after it takes the lock: `let re=await xc(v); ... if(re.accessToken!==U) return "refreshed"; if(!h&&!HI(re.expiresAt)) return "not_needed"`, that is, it re-reads the credentials from disk and drops its own refresh when another process already landed a new token. When it saves, it writes only if the stored refresh token is still the one it sent. A running session can therefore keep using an old access token until it expires and then picks the new one up from the file.
- **Write.** Merge into `claudeAiOauth`: `accessToken`, `refreshToken`, `expiresAt = now + expires_in`, and `refreshTokenExpiresAt` / `scopes` when the response has them. Every other key (`mcpOAuth`, anything unknown) is kept as it was. The file is written to `<file>.tk-tmp` with mode 0600 (tokens go on stdin, never in a command line) and renamed over the original. A missing credentials file is never created.
- **Errors.** HTTP 400/401 (refused refresh token): the file is left untouched, one toast per account per session says to run `claude auth login`, and that account is not retried until its file changes. Network errors and other HTTP errors are retried on the next tick without a toast. If the new tokens cannot be written the mod retries three times and then says so in a toast.

## Limits

- Linux and WSL (file credentials) only. macOS keychain logins are not read or written: such an account is reported as `no credentials file`.
- Claude Code may change its credentials format, endpoint or client id; the mod follows what 2.1.325 does.
- Refresh tokens can rotate. The window keeps the refresh to the moment Claude Code would do it itself, and Claude Code re-reads the file before refreshing (see above), but a rotation can still race with a process that cached the old token.
- The request goes through the host's `$.http.fetch`, so another mod that hooks `http.fetch` can see it.
- Two sessions that both find an expired lease in the same instant can both start; the account lock and the re-read under it keep that to one request.
- This mod acts on the same account credentials Claude Code uses. Use it only for your own accounts.

## Uninstall

```
/plugin uninstall token-keeper
```

Then remove the lease directory if you like: `rm -r ~/.local/state/claude-token-keeper`. Nothing else is left behind; the credentials files keep working as written by the last refresh.

## Develop

```
claude plugin validate .
claude plugin test .
```

MIT licensed.
