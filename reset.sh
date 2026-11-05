#!/bin/bash
# Rebuilds a throwaway test database with a minimal stand-in for Supabase's "auth" schema.
# Usage:  PSQL="psql -U postgres" ./tests/reset.sh && PSQL="psql -U postgres" python3 tests/rls_test.py
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
P=${PSQL:-psql}
DB=${TEST_DB:-schooltest}
$P -d postgres -q -c "drop database if exists $DB" -c "create database $DB"
for f in "$HERE/stub_auth.sql" "$HERE/../supabase/01_schema.sql" "$HERE/../supabase/02_security.sql" "$HERE/../supabase/03_functions.sql" "$HERE/../supabase/07_academic_records_lesson_notes.sql"; do
  $P -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "test database ready"
