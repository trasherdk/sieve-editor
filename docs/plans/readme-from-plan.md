# Sieve editor README for the next person

Archived task plan. The result is [README.md](../../README.md). Do not copy mailbox passwords, SQL secrets, or AGPL sieve-old.

## What it is

Desktop Sieve editor for **Cyrus ManageSieve** (`timsieved` on **mail.fumlersoft.dk:4190**). Electron main owns TCP/STARTTLS; Svelte + CodeMirror 6 is the renderer. Scripts live on Cyrus; SQLite in Electron `userData` holds accounts/prefs only.

Rewrite the plan as **purpose + how it works now**, not a todo list. Drop “sieve-new is empty” and completed-task language.

## README sections

1. **Purpose** — edit Cyrus Sieve scripts with highlighting; RFC 5804 / RFC 5228; not a web app; sieve-old is protocol/UX reference only (do not copy).
2. **Architecture** — mermaid: Renderer IPC Main STARTTLS timsieved; SQLite userData. Point at [`src/main/managesieve.ts`](../../src/main/managesieve.ts), [`src/main/index.ts`](../../src/main/index.ts), [`src/preload/index.ts`](../../src/preload/index.ts), [`src/renderer/src/App.svelte`](../../src/renderer/src/App.svelte).
3. **Cyrus / network** — `sieve` = 4190 on this host; firewall `--dport sieve`; dual `cyrus.conf` lines are the same port; SASL PLAIN/LOGIN; STARTTLS; private CA **Trader Internet Root**; certs under `/var/imap/certs/` (`640` key, `cyrus` group); `tls_server_cert` / `tls_server_key`; `tls_server_ca_file` is not the client chain. Node’s Mozilla CAs fail; Electron uses OS trust store; plaintext TLS fallback exists.
4. **Local data** — Drizzle + better-sqlite3; `sieve.sqlite` in userData; passwords via `safeStorage`; migrations in [`drizzle/`](../../drizzle).
5. **Dev / package** — `pnpm.cmd install` (postinstall downloads Electron 43 binary — no npm postinstall on that package); `pnpm.cmd dev`; `pnpm.cmd run build:win`. Script list: active first, then name order. CHECKSCRIPT if Cyrus allows it; 50K save limit.
6. **Out of scope** — block editor, GSSAPI, web server, sieve-old code.

Keep it short enough to scan; the Cyrus TLS/port notes are the parts that took real debugging.
