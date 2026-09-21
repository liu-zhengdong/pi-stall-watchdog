#!/usr/bin/env bash
# 跑 stall-watchdog 的单元测试。
# 测试要 import @earendil-works/pi-ai，而 ESM 不认 NODE_PATH，所以从当前安装的 pi
# 里找到它，临时建一个 node_modules 软链。
#
# 不能只认 PATH 上第一个 pi：npm 会把各级 node_modules/.bin 塞进 PATH 顶端，
# 那里可能是另一个装不全的 pi。所以逐个候选探测，验证真的含 pi-ai 再用。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

candidates=()
[ -n "${PI_ROOT:-}" ] && candidates+=("$PI_ROOT/node_modules")
while IFS= read -r bin; do
	[ -n "$bin" ] || continue
	real="$(readlink -f "$bin" 2>/dev/null)" || continue
	candidates+=("$(cd "$(dirname "$real")/../.." 2>/dev/null && pwd)/node_modules")
done < <(type -aP pi 2>/dev/null || true)
if npm_global="$(npm root -g 2>/dev/null)"; then
	candidates+=("$npm_global/@earendil-works/pi-coding-agent/node_modules")
fi

modules=""
for candidate in "${candidates[@]}"; do
	if [ -d "$candidate/@earendil-works/pi-ai" ]; then
		modules="$candidate"
		break
	fi
done

if [ -z "$modules" ]; then
	echo "找不到 @earendil-works/pi-ai。探测过的位置：" >&2
	printf '  %s\n' "${candidates[@]}" >&2
	echo "需要本机装好 pi；也可以用 PI_ROOT 指向 pi-coding-agent 包目录。" >&2
	exit 1
fi

ln -sfn "$modules" "$here/node_modules"
trap 'rm -f "$here/node_modules"' EXIT

cd "$here"
node --test watchdog.test.mjs
