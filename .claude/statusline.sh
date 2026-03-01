#!/bin/bash
# Substrate AI — persistent status line
# Receives JSON on stdin with session metadata

input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null)
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null | cut -d. -f1)
COST=$(echo "$input" | jq -r '.session.cost // "0.00"' 2>/dev/null)
BRANCH=$(echo "$input" | jq -r '.git.branch // ""' 2>/dev/null)

BRANCH_PART=""
if [ -n "$BRANCH" ]; then
  BRANCH_PART=" | $BRANCH"
fi

echo "⚡ substrate-ai | $MODEL | ctx ${PCT}% | \$${COST}${BRANCH_PART}"
