#!/bin/bash
# Phase 2 prerequisite: install pgvector on the native Postgres and enable the
# extension on the copal DB. `vector` is NOT a "trusted" extension, so CREATE
# EXTENSION must run as the postgres superuser (the copal migrator role can't).
# Run as: sudo bash ~/copal-pgvector-setup.sh
set -euo pipefail

echo "== installing postgresql-16-pgvector =="
apt-get update -qq
apt-get install -y -qq postgresql-16-pgvector

echo "== creating the vector extension on the copal database =="
sudo -u postgres psql -d copal -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "== verify =="
sudo -u postgres psql -d copal -Atc \
  "SELECT extname, extversion FROM pg_extension WHERE extname='vector';"
echo "== DONE — pgvector ready. Next: add OPENAI_API_KEY to ~/copal/.env and redeploy. =="
