#!/usr/bin/env bash
#
# Files that came from a mis-quoted shell command, rather than from anybody.
#
# Seven of them sat in the repo root for five milestones — `(value.length`,
# `b.currency`, `convert(money(100n` and friends, all empty, all swept in by
# `git add -A` after a heredoc or a `>` landed somewhere it should not have.
# Six more appeared in `packages/db` the day the first seven were removed.
# Nothing type-checks a filename, so nothing ever complained.
#
# Two rules, both about the *last* segment of the path:
#
#   1. It must end in an extension this repo actually uses. That is what
#      catches `b.currency` and `item.claimers))]`, which otherwise look like
#      ordinary dotted names.
#   2. Apart from the extension it must be ordinary — letters, digits, dot,
#      dash, underscore. Expo Router's `(tabs)` and `[id].tsx` are the
#      deliberate exceptions, and are spelled out rather than exempted by
#      loosening the character class for everybody.
#
# Adding a genuinely new kind of file means adding its extension here, which is
# the intended cost: it is one line, and it is a decision worth making once.

set -euo pipefail

EXTENSIONS='ts|tsx|js|jsx|mjs|cjs|json|md|sql|prisma|ya?ml|toml|css|html|svg|png|jpg|jpeg|webp|ico|ttf|otf|sh|txt|example|gitignore|gitattributes|npmrc|nvmrc|prettierrc|prettierignore|vercelignore|editorconfig|lock'

bad=""
while IFS= read -r path; do
  name=${path##*/}

  # Assets come out of design tools and Expo's icon generator with spaces and
  # copy-numbers in their names — `expo-symbol 2.svg`. Nobody types those, so
  # they are not the failure this is looking for.
  case $path in apps/*/assets/*) continue ;; esac

  # pnpm names the files under `patches/` after the package and version it
  # patches — `react-native-get-sms-android@2.1.0.patch`, an `@` and a `.patch`
  # neither of which this guard would otherwise allow. The name is the tool's,
  # not a person's, so the directory is exempt the same way assets are.
  case $path in patches/*.patch) continue ;; esac

  # Expo Router names a route group `(tabs)` and a dynamic segment `[id]` or
  # `[...rest]`. Both are directories or files the framework requires.
  if [[ $name =~ ^\(.+\)$ ]]; then continue; fi
  if [[ $name =~ ^\[\.{0,3}[A-Za-z0-9_-]+\](\.[A-Za-z0-9]+)?$ ]]; then continue; fi

  if [[ ! $name =~ ^[A-Za-z0-9._-]+$ ]] || [[ ! $name =~ \.($EXTENSIONS)$ ]]; then
    bad+="  $path"$'\n'
  fi
done < <(git ls-files)

if [[ -n $bad ]]; then
  echo 'Tracked files that look like shell debris, or use an unknown extension:'
  printf '%s' "$bad"
  echo
  echo 'If one of these is a real file, add its extension to scripts/check-filenames.sh.'
  exit 1
fi
