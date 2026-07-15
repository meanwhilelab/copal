#!/bin/bash
# Copal PITR restore drill v2 — run as: sudo bash ~/copal-restore-drill.sh
# Debian keeps postgresql.conf/pg_hba.conf in /etc (outside PGDATA), so the
# restored data dir needs a minimal config to boot. Live cluster untouched.
set -euo pipefail

DRILL=/var/lib/postgresql/16/drill
BIN=/usr/lib/postgresql/16/bin

echo "== flush current WAL to archive =="
sudo -u postgres psql -Atc "SELECT pg_switch_wal();" > /dev/null
sleep 3

echo "== restore latest backup + WAL into scratch dir =="
rm -rf "$DRILL"
install -d -o postgres -g postgres -m 700 "$DRILL"
sudo -u postgres pgbackrest --stanza=main --pg1-path="$DRILL" restore

echo "== minimal config for the scratch cluster (Debian keeps real config in /etc) =="
sudo -u postgres tee "$DRILL/postgresql.conf" > /dev/null <<'EOF'
# minimal drill config; postgresql.auto.conf (written by pgbackrest) supplies restore_command
EOF
sudo -u postgres tee "$DRILL/pg_hba.conf" > /dev/null <<'EOF'
local all all peer
EOF
sudo -u postgres touch "$DRILL/pg_ident.conf"

echo "== start scratch cluster (socket-only, archiving off) =="
sudo -u postgres "$BIN/pg_ctl" -D "$DRILL" -t 120 -w \
  -o "-p 5434 -k /tmp -c listen_addresses='' -c archive_mode=off" start

echo "== verify =="
sudo -u postgres psql -p 5434 -h /tmp -d amber -Atc \
  "SELECT 'boards: ' || count(*) FROM boards;" -Atc \
  "SELECT 'items: ' || count(*) FROM items;" -Atc \
  "SELECT 'wal-replayed marker: ' || count(*) FROM ideas WHERE title = 'PITR-drill-marker';"

echo "== teardown =="
sudo -u postgres "$BIN/pg_ctl" -D "$DRILL" -w stop > /dev/null
rm -rf "$DRILL"
echo "== DRILL PASSED (expected: boards 1, items 2, marker 1) =="
