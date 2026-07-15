#!/bin/bash
# Copal WAL archiving setup — run as: sudo bash ~/copal-wal-setup.sh
set -euo pipefail

mkdir -p /etc/pgbackrest /var/lib/pgbackrest
chown postgres:postgres /var/lib/pgbackrest

cat > /etc/pgbackrest/pgbackrest.conf <<'EOF'
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
start-fast=y

[main]
pg1-path=/var/lib/postgresql/16/main
EOF

echo "== restarting postgres (the ~5-10s blip) =="
systemctl restart postgresql@16-main
sleep 3

echo "== stanza-create =="
sudo -u postgres pgbackrest --stanza=main stanza-create

echo "== check =="
sudo -u postgres pgbackrest --stanza=main check

echo "== first full backup (may take a minute) =="
sudo -u postgres pgbackrest --stanza=main --type=full backup

cat > /etc/cron.d/pgbackrest <<'EOF'
30 2 * * 1-6 postgres pgbackrest --stanza=main --type=diff backup
30 2 * * 0 postgres pgbackrest --stanza=main --type=full backup
EOF

echo "== ALL DONE =="
sudo -u postgres pgbackrest info
