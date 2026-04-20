#!/bin/bash
# Docker network partition demo for Mini-RAFT
# Usage: ./scripts/test-network-partition.sh

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

LOG_ROOT="logs"
RUN_ID=$(date +"%Y%m%d-%H%M%S")
RUN_DIR="${LOG_ROOT}/partition-${RUN_ID}"
mkdir -p "$RUN_DIR"
CURL_MAX_TIME=2

service_port() {
  case "$1" in
    replica1) echo 3001 ;;
    replica2) echo 3002 ;;
    replica3) echo 3003 ;;
    replica4) echo 3004 ;;
    *) echo "" ;;
  esac
}

write_snapshot() {
  local name="$1"
  {
    echo "=== ${name} @ $(date -u +"%Y-%m-%dT%H:%M:%SZ") ==="
    for port in 3001 3002 3003 3004; do
      echo "port ${port}:"
      curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${port}/status" 2>/dev/null || echo '{"error":"unreachable"}'
      echo ""
    done
  } > "${RUN_DIR}/${name}.json"
}

wait_for_leader() {
  local timeout=${1:-12}
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    for port in 3001 3002 3003 3004; do
      local status
      status=$(curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${port}/status" 2>/dev/null || echo '{}')
      local state
      state=$(echo "$status" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
      if [ "$state" = "leader" ]; then
        local id
        id=$(echo "$status" | grep -o '"replicaId":"[^"]*"' | cut -d'"' -f4)
        echo "$id:$port"
        return 0
      fi
    done
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

get_network_name() {
  local name
  name=$(docker network ls --format '{{.Name}}' | grep '_raft-net$' | head -n1 || true)
  if [ -z "$name" ]; then
    fail "Could not find compose raft network"
  fi
  echo "$name"
}

echo "========================================"
echo "  Mini-RAFT Network Partition Demo"
echo "========================================"

info "Checking replica health endpoints"
for port in 3001 3002 3003 3004; do
  if ! curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${port}/health" > /dev/null 2>&1; then
    fail "Replica on port $port is not running. Run: docker compose up --build -d"
  fi
done
pass "Cluster appears up"

leader_info=$(wait_for_leader 12) || fail "No leader elected"
leader_id=$(echo "$leader_info" | cut -d: -f1)
leader_port=$(echo "$leader_info" | cut -d: -f2)
pass "Leader before partition: $leader_id (port $leader_port)"

write_snapshot "before-partition"

network_name=$(get_network_name)
info "Detected network: ${network_name}"

# Prefer isolating replica4 if present, else isolate the current leader.
isolate_service="replica4"
if [ -z "$(docker compose ps -q replica4 2>/dev/null || true)" ]; then
  isolate_service="$leader_id"
fi

container_id=$(docker compose ps -q "$isolate_service" 2>/dev/null || true)
if [ -z "$container_id" ]; then
  fail "Unable to resolve container ID for ${isolate_service}"
fi

isolate_port=$(service_port "$isolate_service")
if [ -z "$isolate_port" ]; then
  fail "Could not determine port for ${isolate_service}"
fi

info "Disconnecting ${isolate_service} (${container_id}) from ${network_name}"
docker network disconnect "$network_name" "$container_id"
pass "Partition applied"

sleep 4
write_snapshot "during-partition"

# Attempt a write against current leader endpoint (if still reachable)
write_result=$(curl -s -X POST "http://localhost:${leader_port}/client-write" \
  -H "Content-Type: application/json" \
  -d '{"stroke":{"id":"partition-s1","boardId":"partition-board","userId":"u1","color":"#f00","width":3,"points":[[0,0],[10,10]],"timestamp":1}}' || true)
echo "$write_result" > "${RUN_DIR}/write-during-partition.json"

info "Reconnecting ${isolate_service}"
docker network connect --alias "$isolate_service" "$network_name" "$container_id"
pass "Partition healed"

sleep 5
write_snapshot "after-heal"

# Verify isolated node is reachable and catches up to at least leader commit index.
leader_info_after=$(wait_for_leader 20) || fail "No leader after healing partition"
leader_port_after=$(echo "$leader_info_after" | cut -d: -f2)

max_catchup_wait=25
catchup_elapsed=0
is_caught_up=0
while [ $catchup_elapsed -lt $max_catchup_wait ]; do
  leader_status=$(curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${leader_port_after}/status" 2>/dev/null || echo '{}')
  isolated_status=$(curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${isolate_port}/status" 2>/dev/null || echo '{}')

  leader_commit=$(echo "$leader_status" | grep -o '"commitIndex":[0-9]*' | cut -d: -f2)
  isolated_commit=$(echo "$isolated_status" | grep -o '"commitIndex":[0-9]*' | cut -d: -f2)

  if [ -n "$leader_commit" ] && [ -n "$isolated_commit" ] && [ "$isolated_commit" -ge "$leader_commit" ]; then
    is_caught_up=1
    break
  fi

  sleep 1
  catchup_elapsed=$((catchup_elapsed + 1))
done

if [ "$is_caught_up" -eq 1 ]; then
  pass "${isolate_service} caught up after heal"
else
  info "Leader status: ${leader_status}"
  info "Isolated replica status: ${isolated_status}"
  fail "${isolate_service} did not catch up within ${max_catchup_wait}s"
fi

docker compose logs gateway replica1 replica2 replica3 replica4 > "${RUN_DIR}/docker-compose.log" 2>&1 || true

echo "========================================"
echo -e "  ${GREEN}Network partition demo complete${NC}"
echo "========================================"
echo "Logs captured in ${RUN_DIR}"
