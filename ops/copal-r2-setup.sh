#!/bin/bash
# Copal offsite backups — Cloudflare R2 as pgBackRest repo2 + weekly /etc tar.
# Run as: sudo bash ~/copal-r2-setup.sh   (prompts for credentials; never echoes)
set -euo pipefail

# Paste the S3 API URL exactly as shown in the bucket's Settings → General
# (e.g. https://<account>.eu.r2.cloudflarestorage.com/<your-r2-bucket> —
# jurisdiction-scoped buckets like EU carry a different endpoint host).
read -rp  "S3 API URL (paste from bucket settings): " R2_URL
read -rp  "R2 access key id: " R2_KEY
read -rsp "R2 secret access key: " R2_SECRET; echo
STRIPPED=${R2_URL#http://}; STRIPPED=${STRIPPED#https://}
ENDPOINT=${STRIPPED%%/*}
REST=${STRIPPED#"$ENDPOINT"}; REST=${REST#/}; BUCKET=${REST%%/*}
if [ -z "$BUCKET" ]; then
  read -rp "Bucket name [<your-r2-bucket>]: " BUCKET
  BUCKET=${BUCKET:-<your-r2-bucket>}
fi
case "$ENDPOINT" in
  *.r2.cloudflarestorage.com) ;;
  *) echo "endpoint '$ENDPOINT' doesn't look like an R2 endpoint"; exit 1 ;;
esac
echo "endpoint: $ENDPOINT | bucket: $BUCKET"

echo "== pgbackrest repo2 (S3/R2) =="
install -d -o postgres -g postgres /var/spool/pgbackrest
# Back up the current conf with 600 perms — on a rotation re-run it contains the
# OLD R2 secret and must not linger world-readable.
install -m 600 /etc/pgbackrest/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf.bak-r2
cat > /etc/pgbackrest/pgbackrest.conf <<EOF
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
repo2-type=s3
repo2-path=/pgbackrest
repo2-s3-bucket=${BUCKET}
repo2-s3-endpoint=${ENDPOINT}
repo2-s3-region=auto
repo2-s3-uri-style=path
repo2-s3-key=${R2_KEY}
repo2-s3-key-secret=${R2_SECRET}
repo2-retention-full=2
repo2-bundle=y
start-fast=y
archive-async=y
spool-path=/var/spool/pgbackrest
# Bound WAL retention when a repo is unreachable: past this the archive drops
# WAL (an archive GAP on that repo) instead of letting pg_wal fill the disk and
# PANIC the primary. Sized well above normal daily WAL churn.
archive-push-queue-max=4GiB

[main]
pg1-path=/var/lib/postgresql/16/main
EOF
# postgres must read this (it runs the backups); root writes it.
chown root:postgres /etc/pgbackrest/pgbackrest.conf
chmod 640 /etc/pgbackrest/pgbackrest.conf

echo "== stanza-create on repo2 + check (both repos) =="
sudo -u postgres pgbackrest --stanza=main stanza-create
sudo -u postgres pgbackrest --stanza=main check

echo "== first full backup to R2 (may take a couple of minutes) =="
sudo -u postgres pgbackrest --stanza=main --repo=2 --type=full backup

echo "== backup crons: repo1 then repo2, chained (one stanza lock at a time) =="
# Chain repo1 && repo2 in a single entry: pgbackrest holds one lock per stanza,
# so separate near-simultaneous entries would make the second fail silently.
# MAILTO surfaces cron failures if an MTA is configured.
cat > /etc/cron.d/pgbackrest <<'EOF'
MAILTO=root
30 2 * * 1-6 postgres pgbackrest --stanza=main --repo=1 --type=diff backup && pgbackrest --stanza=main --repo=2 --type=diff backup
30 2 * * 0 postgres pgbackrest --stanza=main --repo=1 --type=full backup && pgbackrest --stanza=main --repo=2 --type=full backup
0 4 * * * postgres pgbackrest --stanza=main check
EOF

echo "== rclone for /etc configs (same bucket, /etc-configs prefix) =="
apt-get install -y -qq rclone >/dev/null
install -d -m 700 /root/.config/rclone
cat > /root/.config/rclone/rclone.conf <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_KEY}
secret_access_key = ${R2_SECRET}
endpoint = https://${ENDPOINT}
# R2 does not support ACLs — sending one 403s with bucket-scoped tokens.
no_check_bucket = true
EOF
chmod 600 /root/.config/rclone/rclone.conf

cat > /usr/local/bin/copal-etc-backup <<EOF
#!/bin/bash
# Weekly push of the Debian-side Postgres configs (OUTSIDE PGDATA — the
# restore-drill lesson) to R2. pgbackrest secrets are excluded.
set -euo pipefail
STAMP=\$(date +%Y%m%d)
TMP=\$(mktemp -d)
trap 'rm -rf "\$TMP"' EXIT
tar -czf "\$TMP/etc-postgresql-\$STAMP.tar.gz" /etc/postgresql/16/main 2>/dev/null
rclone copy "\$TMP/etc-postgresql-\$STAMP.tar.gz" r2:${BUCKET}/etc-configs/
rclone delete r2:${BUCKET}/etc-configs/ --min-age 90d || true
EOF
chmod 755 /usr/local/bin/copal-etc-backup
echo "15 3 * * 0 root /usr/local/bin/copal-etc-backup" > /etc/cron.d/copal-etc-backup
/usr/local/bin/copal-etc-backup

echo "== ALL DONE — repo status =="
sudo -u postgres pgbackrest info
rclone ls r2:${BUCKET}/etc-configs/ 2>/dev/null | head -3 || true
