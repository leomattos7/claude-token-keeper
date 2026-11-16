#!/usr/bin/env bash
# Runs the real SAVE_SCRIPT from hooks/register.ts against a temp dir (the plugin test kit cannot spawn processes).
# Usage: tests/save-script.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$(python3 -I -c 'import re,sys; print(re.search(r"const SAVE_SCRIPT = \x27(.*)\x27", open(sys.argv[1]).read()).group(1))' "$here/hooks/register.ts")"
[ -n "$script" ] || { echo "SAVE_SCRIPT not found" >&2; exit 2; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; failn=0
t() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1"; failn=$((failn+1)); fi; }
save() { printf '%s' "$3" | sh -c "$script" sh "$1" "$2"; }   # save <tmp> <file> <text>

umask 022
printf 'old' > "$T/cred"; chmod 644 "$T/cred"
t "saves the new text" "save '$T/cred.tk-tmp' '$T/cred' 'new text' && [ \"\$(cat '$T/cred')\" = 'new text' ]"
t "result has mode 0600 even under umask 022" "[ \"\$(stat -c %a '$T/cred')\" = 600 ]"
t "temp file is gone" "[ ! -e '$T/cred.tk-tmp' ]"

printf 'victim' > "$T/victim"; ln -s "$T/victim" "$T/cred.tk-tmp"
t "a symlink planted as the temp name is replaced, not followed" "save '$T/cred.tk-tmp' '$T/cred' 'again' && [ \"\$(cat '$T/victim')\" = victim ] && [ \"\$(cat '$T/cred')\" = again ] && [ ! -e '$T/cred.tk-tmp' ] && [ ! -L '$T/cred.tk-tmp' ]"

printf 'target' > "$T/real"; ln -sf "$T/real" "$T/linked"
t "a symlinked destination is replaced by the file, its target untouched" "save '$T/linked.tk-tmp' '$T/linked' 'x' && [ ! -L '$T/linked' ] && [ \"\$(cat '$T/real')\" = target ]"

printf 'keep' > "$T/keep"
t "a failed rename exits non-zero, leaves no temp file and the original alone" "! save '$T/keep.tk-tmp' '$T/nope/dir/file' 'zzz' && [ ! -e '$T/keep.tk-tmp' ] && [ \"\$(cat '$T/keep')\" = keep ]"
t "a failed write (temp dir missing) exits non-zero" "! save '$T/missing/x.tk-tmp' '$T/keep' 'zzz' && [ \"\$(cat '$T/keep')\" = keep ]"

echo "== $pass passed, $failn failed"
[ "$failn" = 0 ]
