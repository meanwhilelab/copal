#!/bin/bash
# Phase 2 prerequisite: install pgvector on the native Postgres and enable the
# extension on the amber DB. `vector` is NOT a "trusted" extension, so CREATE
# EXTENSION must run as the postgres superuser (the amber migrator role can't).
# Run as: sudo bash ~/copal-pgvector-setup.sh
set -euo pipefail

echo "== installing postgresql-16-pgvector =="
apt-get update -qq
apt-get install -y -qq postgresql-16-pgvector

echo "== creating the vector extension on the amber database =="
sudo -u postgres psql -d amber -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "== verify =="
sudo -u postgres psql -d amber -Atc \
  "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
echo "== DONE — pgvector ready. Next: add OPENAI_API_KEY to ~/amber/.env and redeploy. =="
