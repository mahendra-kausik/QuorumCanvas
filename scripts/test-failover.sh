#!/bin/bash
# Docker-based failover test script for Mini-RAFT
# Usage: ./scripts/test-failover.sh
#
# Prerequisites: docker compose up --build -d

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

LOG_ROOT="logs"
RUN_ID=$(date +"%Y%m%d-%H%M%S")
RUN_DIR="${LOG_ROOT}/failover-${RUN_ID}"
mkdir -p "$RUN_DIR"
REPLICA_PORTS=(3001 3002 3003 3004)
CURL_MAX_TIME=2

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

capture_compose_logs() {
  docker compose logs gateway replica1 replica2 replica3 replica4 > "${RUN_DIR}/docker-compose.log" 2>&1 || true
}

wait_for_leader() {
  local timeout=${1:-10}
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    for port in "${REPLICA_PORTS[@]}"; do
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

get_status() {
  curl -s --max-time "$CURL_MAX_TIME" "http://localhost:$1/status" 2>/dev/null || echo '{"error":"unreachable"}'
}

echo "========================================"
echo "  Mini-RAFT Failover Test"
echo "========================================"
echo ""

# Ensure cluster is running
info "Checking cluster is running..."
for port in "${REPLICA_PORTS[@]}"; do
  if ! curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${port}/health" > /dev/null 2>&1; then
    fail "Replica on port $port is not running. Run: docker compose up --build -d"
  fi
done
pass "All ${#REPLICA_PORTS[@]} replicas are running"
write_snapshot "startup"

# Test 1: Leader election
echo ""
info "Test 1: Leader election"
leader_info=$(wait_for_leader 20) || fail "No leader elected within 20s"
leader_id=$(echo "$leader_info" | cut -d: -f1)
leader_port=$(echo "$leader_info" | cut -d: -f2)
pass "Leader elected: $leader_id (port $leader_port)"
write_snapshot "leader-elected"

# Show cluster state
echo ""
info "Cluster state:"
for port in "${REPLICA_PORTS[@]}"; do
  echo "  Port $port: $(get_status $port)"
done

# Test 2: Submit a stroke via the leader
echo ""
info "Test 2: Submit stroke to leader"
write_result=$(curl -s -X POST "http://localhost:${leader_port}/client-write" \
  -H "Content-Type: application/json" \
  -d '{"stroke":{"id":"test-s1","boardId":"test-board","userId":"u1","color":"#f00","width":3,"points":[[0,0],[10,10]],"timestamp":1}}')
success=$(echo "$write_result" | grep -o '"success":true')
if [ -n "$success" ]; then
  pass "Stroke committed via leader"
else
  fail "Stroke write failed: $write_result"
fi
echo "$write_result" > "${RUN_DIR}/write-1.json"

# Verify replication
sleep 1
info "Verifying replication..."
for port in "${REPLICA_PORTS[@]}"; do
  board=$(curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${port}/board-state?boardId=test-board" 2>/dev/null)
  stroke_count=$(echo "$board" | grep -o '"id"' | wc -l | tr -d ' ')
  if [ "$stroke_count" -ge 1 ]; then
    pass "Port $port has stroke replicated"
  else
    echo "  Port $port: $board"
    fail "Port $port missing stroke"
  fi
done

# Test 3: Kill the leader
echo ""
info "Test 3: Kill leader ($leader_id)"
leader_service=$(echo "$leader_id" | tr -d '"')
docker compose stop "$leader_service"
pass "Stopped $leader_service"
write_snapshot "leader-stopped"

# Wait for new leader
info "Waiting for new leader election..."
sleep 2
new_leader_info=$(wait_for_leader 20) || fail "No new leader elected after killing $leader_service"
new_leader_id=$(echo "$new_leader_info" | cut -d: -f1)
new_leader_port=$(echo "$new_leader_info" | cut -d: -f2)
if [ "$new_leader_id" != "$leader_id" ]; then
  pass "New leader elected: $new_leader_id (port $new_leader_port)"
else
  fail "Same leader re-elected (shouldn't happen — it's stopped)"
fi
write_snapshot "new-leader-elected"

# Test 4: Write to new leader
echo ""
info "Test 4: Submit stroke to new leader"
write_result2=$(curl -s -X POST "http://localhost:${new_leader_port}/client-write" \
  -H "Content-Type: application/json" \
  -d '{"stroke":{"id":"test-s2","boardId":"test-board","userId":"u1","color":"#00f","width":3,"points":[[20,20],[30,30]],"timestamp":2}}')
success2=$(echo "$write_result2" | grep -o '"success":true')
if [ -n "$success2" ]; then
  pass "Stroke committed on new leader after failover"
else
  fail "Write to new leader failed: $write_result2"
fi
echo "$write_result2" > "${RUN_DIR}/write-2.json"

# Test 5: Restart killed replica and verify catch-up
echo ""
info "Test 5: Restart $leader_service and verify catch-up"
docker compose start "$leader_service"

# Wait for restarted replica to become reachable
max_health_wait=20
health_elapsed=0
while [ $health_elapsed -lt $max_health_wait ]; do
  if curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${leader_port}/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
  health_elapsed=$((health_elapsed + 1))
done

restarted_port=$leader_port

# Poll for catch-up because sync can take a few heartbeat rounds after restart.
max_catchup_wait=25
catchup_elapsed=0
stroke_count=0
board='{"error":"not_fetched"}'
while [ $catchup_elapsed -lt $max_catchup_wait ]; do
  board=$(curl -s --max-time "$CURL_MAX_TIME" "http://localhost:${restarted_port}/board-state?boardId=test-board" 2>/dev/null || echo '{"error":"unreachable"}')
  stroke_count=$(echo "$board" | grep -o '"id"' | wc -l | tr -d ' ')
  if [ "$stroke_count" -ge 2 ]; then
    break
  fi
  sleep 1
  catchup_elapsed=$((catchup_elapsed + 1))
done

if [ "$stroke_count" -ge 2 ]; then
  pass "Restarted replica caught up (has $stroke_count strokes)"
else
  info "Restarted replica board state after ${max_catchup_wait}s: $board"
  fail "Restarted replica only has $stroke_count strokes (expected >= 2)"
fi

# Check restarted node stepped down (not leader with stale term)
restarted_status=$(get_status $restarted_port)
restarted_state=$(echo "$restarted_status" | grep -o '"state":"[^"]*"' | cut -d'"' -f4)
if [ "$restarted_state" = "follower" ]; then
  pass "Restarted replica is follower (correctly stepped down)"
else
  info "Restarted replica state: $restarted_state"
fi

write_snapshot "restart-catchup"
capture_compose_logs

echo ""
echo "========================================"
echo -e "  ${GREEN}All failover tests passed!${NC}"
echo "========================================"
echo "Logs captured in ${RUN_DIR}"
