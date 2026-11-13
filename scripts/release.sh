#!/bin/bash
# Release a version for Homebrew users:
#
#   scripts/release.sh 1.1.0
#
# Runs the tests, sets the version in package.json, commits and tags vVERSION, then points
# Formula/search-scrape-mcp.rb at that tag and commit and pushes both. Users get it with
# `search-scrape-mcp update` (brew update && brew upgrade search-scrape-mcp).
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh VERSION (like 1.1.0)}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VERSION must look like 1.1.0."; exit 1; }
TAG="v$VERSION"
FORMULA=Formula/search-scrape-mcp.rb
cd "$(dirname "$0")/.."

[ "$(git branch --show-current)" = "main" ] || { echo "Release from main."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first."; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main isn't in step with origin/main."; exit 1; }
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then echo "$TAG already exists."; exit 1; fi

npm ci
npm run lint
npm test

npm version "$VERSION" --no-git-tag-version >/dev/null
git add package.json package-lock.json
git commit -q -m "Release $TAG"
git tag -a "$TAG" -m "search-scrape-mcp $VERSION"
REVISION="$(git rev-parse "$TAG^{commit}")"

sed -i '' -E -e "s/tag:( +)\"v[^\"]+\"/tag:\1\"$TAG\"/" -e "s/revision: \"[0-9a-f]+\"/revision: \"$REVISION\"/" "$FORMULA"
grep -q "\"$TAG\"" "$FORMULA" && grep -q "$REVISION" "$FORMULA" || { echo "Could not update $FORMULA."; exit 1; }
git add "$FORMULA"
git commit -q -m "Formula: $TAG"
git push -q origin main "$TAG"
echo "Released $TAG ($REVISION). Users update with: search-scrape-mcp update"
