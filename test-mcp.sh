#!/bin/bash
# MCP Protocol Smoke Test for ec-weather-alerts
# Usage: Start the server first (PORT=8080 npm start &), then: bash test-mcp.sh
BASE_URL="${MCP_URL:-http://localhost:8080}"
MCP_ENDPOINT="$BASE_URL/mcp"
HEALTH_ENDPOINT="$BASE_URL/health"
PASSED=0
FAILED=0
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}FAIL${NC} $1: $2"; FAILED=$((FAILED + 1)); }

mcp_post() {
  curl -sf -X POST "$MCP_ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1" 2>/dev/null || true
}

echo "Testing ec-weather-alerts at $BASE_URL"
echo "================================"

echo ""
echo "--- Health Check ---"
HEALTH=$(curl -sf "$HEALTH_ENDPOINT" 2>/dev/null) || true
if echo "$HEALTH" | grep -q "healthy"; then pass "GET /health returns healthy";
else fail "GET /health" "got: $HEALTH"; fi

echo ""
echo "--- MCP Initialize ---"
INIT_RESPONSE=$(mcp_post '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2025-03-26", "capabilities": {},
              "clientInfo": { "name": "smoke-test", "version": "1.0" } }
}')
if echo "$INIT_RESPONSE" | grep -q '"result"'; then pass "initialize returns result";
else fail "initialize" "got: ${INIT_RESPONSE:0:200}"; fi

echo ""
echo "--- List Tools ---"
TOOLS_RESPONSE=$(mcp_post '{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}')
if echo "$TOOLS_RESPONSE" | grep -q '"tools"'; then pass "tools/list returns tools array";
else fail "tools/list" "got: ${TOOLS_RESPONSE:0:200}"; fi

for TOOL in current_conditions forecast active_alerts; do
  if echo "$TOOLS_RESPONSE" | grep -q "\"$TOOL\""; then pass "Tool '$TOOL' is registered";
  else fail "Tool '$TOOL'" "not found in tools/list"; fi
done

call_tool() {
  local name="$1" args="$2" id="$3"
  mcp_post "{\"jsonrpc\": \"2.0\", \"id\": $id, \"method\": \"tools/call\",
    \"params\": { \"name\": \"$name\", \"arguments\": $args }}"
}

echo ""
echo "--- tools/call current_conditions (Toronto) ---"
R=$(call_tool "current_conditions" '{"location": "Toronto"}' 10)
if echo "$R" | grep -q '"temp_c"'; then
  pass "current_conditions returns temp_c"
  echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('     →', d['result']['structuredContent'])" 2>/dev/null
else fail "current_conditions" "got: ${R:0:300}"; fi

echo ""
echo "--- tools/call forecast (43.65,-79.38) ---"
R=$(call_tool "forecast" '{"location": "43.65,-79.38"}' 11)
if echo "$R" | grep -q '"periods"'; then
  pass "forecast returns periods"
  echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); p=d['result']['structuredContent']['periods']; print('     →', len(p), 'periods, first:', p[0])" 2>/dev/null
else fail "forecast" "got: ${R:0:300}"; fi

echo ""
echo "--- tools/call active_alerts (ON) ---"
R=$(call_tool "active_alerts" '{"location": "ON"}' 12)
if echo "$R" | grep -q '"alerts"'; then
  pass "active_alerts returns alerts array"
  echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('     → count:', d['result']['structuredContent']['count'])" 2>/dev/null
else fail "active_alerts" "got: ${R:0:300}"; fi

echo ""
echo "--- tools/call current_conditions (garbage → isError) ---"
R=$(call_tool "current_conditions" '{"location": "zzz-not-a-place"}' 13)
if echo "$R" | grep -q '"isError":true'; then pass "garbage location returns isError";
else fail "garbage location" "got: ${R:0:300}"; fi

echo ""
echo "--- Ping ---"
PING_RESPONSE=$(mcp_post '{"jsonrpc": "2.0", "id": 14, "method": "ping", "params": {}}')
if echo "$PING_RESPONSE" | grep -q '"result"'; then pass "ping returns result";
else fail "ping" "got: ${PING_RESPONSE:0:200}"; fi

echo ""
echo "================================"
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
[ "$FAILED" -gt 0 ] && exit 1
