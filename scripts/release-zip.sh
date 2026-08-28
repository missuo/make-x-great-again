#!/usr/bin/env bash
# 打发布包 —— 唯一允许用来产出对外分发 zip 的入口。
#
# 存在的理由：extension/.env 里的 WXT_LLM_* 是**构建期注入**，直接
# `npm run zip` 会把 API key 明文打进 background.js 和 options chunk。
# 2026-08-27 实测当时 build/ 里的两个文件都含 key。靠记性绕开这个坑
# 迟早会漏一次，所以把「移开 .env → 构建 → 回扫密钥 → 还原 .env」
# 固化成一条命令，并且**扫不干净就非零退出**，不给「先发了再说」留口子。
#
# 用法：scripts/release-zip.sh [chrome|firefox ...]   默认两个都打
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
ENV_FILE="$EXT/.env"
STASH="$(mktemp -d)/env.stashed"
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(chrome firefox)

restore() { [ -f "$STASH" ] && mv "$STASH" "$ENV_FILE" && echo "↩︎  已还原 extension/.env"; }
trap restore EXIT

if [ -f "$ENV_FILE" ]; then
  mv "$ENV_FILE" "$STASH"
  echo "→ 已移开 extension/.env（构建期不注入任何密钥）"
fi

cd "$EXT"
rm -rf .output
for t in "${TARGETS[@]}"; do
  echo "→ 构建 $t"
  if [ "$t" = "chrome" ]; then npx wxt zip; else npx wxt zip -b "$t"; fi
done

# 回扫：既查 .env 里的实际值，也查通用密钥形态，避免换了 key 就漏检。
echo "→ 回扫产物"
SCAN="$(mktemp -d)"
fail=0
for z in .output/*.zip; do
  rm -rf "${SCAN:?}/x"; mkdir -p "$SCAN/x"
  unzip -q "$z" -d "$SCAN/x"
  if [ -f "$STASH" ]; then
    while IFS='=' read -r k v; do
      case "$k" in ''|\#*) continue;; esac
      v="${v%\"}"; v="${v#\"}"
      [ ${#v} -lt 8 ] && continue
      if grep -rqF "$v" "$SCAN/x"; then echo "✖ $(basename "$z") 含 .env 值 $k"; fail=1; fi
    done < "$STASH"
  fi
  if grep -rqE '(sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})' "$SCAN/x"; then
    echo "✖ $(basename "$z") 含疑似 API key"; fail=1
  fi
done
rm -rf "$SCAN"
[ "$fail" -ne 0 ] && { echo "✖ 回扫未通过，产物不可分发"; exit 1; }

echo "✔ 回扫通过，产物可分发："
ls -la .output/*.zip
