#!/usr/bin/env bash
# Prompt cache efficiency test for pi-claude-bridge.
# Runs a multi-turn conversation and verifies Anthropic prompt caching is working.
# Expects: cacheRead grows across turns (system prompt + history are cache-hit),
#   cacheWrite is small after the first turn (only new content is written).

set -euo pipefail
echo "=== cache-test.sh ==="

# npm prepends node_modules/.bin to PATH, which shadows the system pi
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$DIR/.test-output"
LOGFILE="$LOGDIR/cache-test.ndjson"
mkdir -p "$LOGDIR"

kill_descendants() { pkill -P $$ 2>/dev/null || true; sleep 1; }
trap kill_descendants EXIT

TMPFILE="$LOGDIR/cache-test-scratch.txt"
rm -f "$TMPFILE"

echo "Running 5-turn conversation (text + tool use)..."
timeout 180 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret number is 42. Acknowledge briefly." \
     "Write the secret number to $TMPFILE. Just the number, nothing else." \
     "What is 42 * 2? Just the number." \
     "Read $TMPFILE and tell me what's in it." \
     "What was the secret number, what did you write, what did you read, and what was 42*2? One per line." \
  > "$LOGFILE" 2>"$LOGFILE.err"

rm -f "$TMPFILE"

echo ""
echo "Turn-by-turn cache metrics:"
echo "---"
printf "%-6s  %8s  %8s  %8s  %8s  %s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "CacheHit%"

TURN=0
FAIL=0
PREV_CACHE_READ=0

while IFS= read -r line; do
  TURN=$((TURN + 1))
  INPUT=$(echo "$line" | jq -r '.input')
  CACHE_READ=$(echo "$line" | jq -r '.cacheRead')
  CACHE_WRITE=$(echo "$line" | jq -r '.cacheWrite')
  OUTPUT=$(echo "$line" | jq -r '.output')
  TOTAL_INPUT=$((INPUT + CACHE_READ + CACHE_WRITE))

  if [ "$TOTAL_INPUT" -gt 0 ]; then
    HIT_PCT=$((CACHE_READ * 100 / TOTAL_INPUT))
  else
    HIT_PCT=0
  fi

  printf "%-6s  %8s  %8s  %8s  %8s  %s%%\n" "$TURN" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$HIT_PCT"

  # Assertions
  if [ "$TURN" -ge 3 ]; then
    # Turn 3+: cache read should be >= turn 2's (system prompt + history cached).
    # It can stay flat when the prior turn's response was short.
    if [ "$CACHE_READ" -lt "$PREV_CACHE_READ" ]; then
      echo "  FAIL: Turn $TURN cacheRead ($CACHE_READ) decreased from turn $((TURN - 1)) ($PREV_CACHE_READ)"
      FAIL=$((FAIL + 1))
    fi
    # Cache hit rate should be high (>90% of input from cache)
    if [ "$HIT_PCT" -lt 90 ]; then
      echo "  FAIL: Turn $TURN cache hit rate ${HIT_PCT}% < 50%"
      FAIL=$((FAIL + 1))
    fi
  fi

  PREV_CACHE_READ=$CACHE_READ
done < <(jq -c 'select(.type == "turn_end") | .message.usage | {input, cacheRead, cacheWrite, output}' "$LOGFILE")

echo "---"

# Tool calls create sub-turns, so we expect more than 5 turn_end events
if [ "$TURN" -lt 7 ]; then
  echo "WARNING: Only $TURN turns detected (expected >= 7 with tool use sub-turns)."
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: Prompt caching is working across turns"
else
  echo "FAIL: $FAIL cache assertions failed"
  echo "  Log: $LOGFILE"
  exit 1
fi
