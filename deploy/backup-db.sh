#!/usr/bin/env bash
# نسخة احتياطية يومية لقاعدة بيانات مدار — يحتفظ بآخر 14 نسخة
set -euo pipefail

DB="/var/www/madar-new/server/data.db"
DIR="/var/backups/madar"
mkdir -p "$DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/data-$STAMP.db"

# نسخة آمنة متّسقة باستخدام أمر sqlite الخاص بالنسخ الاحتياطي
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$OUT'"
else
  cp "$DB" "$OUT"
fi

gzip -f "$OUT"

# احذف ما زاد عن آخر 14 نسخة
ls -1t "$DIR"/data-*.db.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "[backup] تم: $OUT.gz"
