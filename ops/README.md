# Copal ops — backups & recovery (your VPS)

- **WAL archiving + PITR**: pgBackRest, stanza `main`, repo1 at `/var/lib/pgbackrest`,
  `archive_timeout=300` → RPO ≤ 5 min. Backups run chained (repo1 then repo2) in one
  cron entry so the per-stanza lock never collides: diff Mon–Sat 02:30, full Sun 02:30,
  plus a daily `pgbackrest check` at 04:00, via `/etc/cron.d/pgbackrest`.
- **R2-outage safety**: `archive-push-queue-max=4GiB` bounds WAL retention when a repo
  is unreachable — past it the archive drops WAL (an archive GAP on that repo, logged)
  rather than filling `pg_wal` and PANICking the primary. Recover a gap with a fresh full
  backup once the repo is reachable again. Retention is 2 fulls per repo (~2 weeks PITR).
- **Restore drill**: `copal-restore-drill.sh` — restores to a scratch cluster on a
  local socket, verifies data including a WAL-only marker row, tears down.
  First run passed 2026-07-03. Re-run periodically (DESIGN.md: recurring drills).
- **LESSON (Debian layout)**: `postgresql.conf` / `pg_hba.conf` live in
  `/etc/postgresql/16/main/`, OUTSIDE the data dir — pgBackRest does NOT back
  them up. A full disaster restore needs those files too. Step 7 must add
  `/etc/postgresql` to the offsite backup set, alongside the pgBackRest repo.
- **Offsite (step 7)**: Cloudflare R2 bucket `<your-r2-bucket>` as pgBackRest **repo2**
  (S3, `repo2-bundle`, retention 2 full) — WAL archives to both repos (`archive-async`,
  spool at /var/spool/pgbackrest); nightly R2 diff + weekly full crons. `/etc/postgresql/16/main`
  tar'd weekly to `r2:<your-r2-bucket>/etc-configs/` via rclone (90-day retention), closing the
  Debian-config lesson. Setup: `copal-r2-setup.sh`; offsite restore drill: `copal-offsite-drill.sh`
  (restores from repo2 into a scratch cluster, pinning archive-get to repo2 so the WAL replay
  is genuinely exercised FROM R2). R2 keys live only in /etc/pgbackrest/pgbackrest.conf and
  /root/.config/rclone/rclone.conf (both 600). Rotation: mint a new R2 token, re-run setup script
  (the old conf is preserved 600 as `pgbackrest.conf.bak-r2` — delete it once satisfied).

## Bare-metal restore (total server loss)

The bucket holds everything EXCEPT what must be recreated by hand. In order:

1. **New host**: install postgresql-16 + pgbackrest + rclone.
2. **R2 credentials**: mint a fresh R2 API token (the old secret is gone with the server).
3. **Minimal `/etc/pgbackrest/pgbackrest.conf`** — restore needs only the repo2 stanza
   (no repo1 yet), with the exact values below plus the new key/secret:
   ```
   [global]
   repo1-type=s3
   repo1-path=/pgbackrest
   repo1-s3-bucket=<your-r2-bucket>
   repo1-s3-endpoint=<acct>.eu.r2.cloudflarestorage.com
   repo1-s3-region=auto
   repo1-s3-uri-style=path
   repo1-s3-key=<new key>
   repo1-s3-key-secret=<new secret>
   [main]
   pg1-path=/var/lib/postgresql/16/main
   ```
   (Restore from the offsite repo referenced as repo1 here; renumber to repo2 afterward when
   re-running `copal-r2-setup.sh` to re-establish the local repo1.)
4. **Restore**: `sudo -u postgres pgbackrest --stanza=main restore`, then recover the Debian
   configs from `r2:<your-r2-bucket>/etc-configs/` (latest tarball) into `/etc/postgresql/16/main`,
   and start Postgres.
5. **App**: recreate `.env` (GEMINI_API_KEY, DATABASE_URL — NOT in any backup), the Caddy
   config, and the compose/network setup; `docker compose up -d`. Client bearer tokens live in
   the DB, so they return with the restore. Then re-run `copal-r2-setup.sh` to re-establish
   repo1 (local) + repo2 (R2) and the crons.

**Not backed up (must be recreated): the app `.env`, the Caddy config, and the docker-compose/network
setup.** Everything else — data, WAL, client tokens, Postgres configs — is in the bucket.
