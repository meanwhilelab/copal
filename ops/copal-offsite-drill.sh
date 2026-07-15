#!/bin/bash
# Offsite restore drill — proves the R2 copy is RESTORABLE, not just present.
# Restores from repo2 into a scratch cluster (socket-only), verifies, tears down.
# Run as: sudo bash ~/copal-offsite-drill.sh
set -euo pipefail

DRILL=/var/lib/postgresql/16/drill-r2
BIN=/usr/lib/postgresql/16/bin
PORT=5435

# Always tear down, even on failure — otherwise a failed drill leaves a scratch
# postmaster running on $PORT and the next run rm -rf's the datadir beneath it.
cleanup() {
  sudo -u postgres "$BIN/pg_ctl" -D "$DRILL" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$DRILL"
}
trap cleanup EXIT

if sudo -u postgres "$BIN/pg_isready" -p "$PORT" -h /tmp >/dev/null 2>&1; then
  echo "port $PORT already serving — a previous drill didn't clean up; aborting"
  exit 1
fi

echo "== flush WAL so the archive is current =="
sudo -u postgres psql -Atc "SELECT pg_switch_wal();" > /dev/null
sleep 5

echo "== restore FROM R2 (repo2) into scratch dir =="
rm -rf "$DRILL"
install -d -o postgres -g postgres -m 700 "$DRILL"
# Pin archive-get to repo2 too, so WAL replay is served FROM R2 (not repo1) —
# otherwise the drill could pass on a corrupt offsite archive.
sudo -u postgres pgbackrest --stanza=main --repo=2 --pg1-path="$DRILL" \
  --recovery-option="restore_command=pgbackrest --stanza=main --repo=2 archive-get %f \"%p\"" \
  restore

echo "== minimal config (Debian keeps the real one in /etc — also backed up offsite) =="
sudo -u postgres tee "$DRILL/postgresql.conf" > /dev/null <<'EOF'
# drill config; postgresql.auto.conf carries restore_command
EOF
sudo -u postgres tee "$DRILL/pg_hba.conf" > /dev/null <<'EOF'
local all all peer
EOF
sudo -u postgres touch "$DRILL/pg_ident.conf"

echo "== start scratch cluster =="
sudo -u postgres "$BIN/pg_ctl" -D "$DRILL" -t 180 -w \
  -o "-p $PORT -k /tmp -c listen_addresses='' -c archive_mode=off" start

echo "== verify amber data =="
sudo -u postgres psql -p "$PORT" -h /tmp -d amber -Atc \
  "SELECT 'boards: ' || count(*) FROM boards;" -Atc \
  "SELECT 'items: ' || count(*) FROM items;" -Atc \
  "SELECT 'ideas: ' || count(*) FROM ideas;" -Atc \
  "SELECT 'sessions: ' || count(*) FROM sessions;"

echo "== teardown (also runs via trap on any early exit) =="
sudo -u postgres "$BIN/pg_ctl" -D "$DRILL" -w stop > /dev/null
trap - EXIT
rm -rf "$DRILL"
echo "== OFFSITE DRILL PASSED =="
