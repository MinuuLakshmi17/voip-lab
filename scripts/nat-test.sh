#!/usr/bin/env bash
# NAT/firewall test lab runner.
#
# Brings up the signaling server + coturn, runs two headless WebRTC
# clients in separate Docker networks (no direct path between them),
# and reports which ICE candidate types succeeded and whether the
# relayed call worked.
#
# Requires: Docker with the Compose plugin.
# Usage: ./scripts/nat-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/lab"

export TURN_SECRET="${TURN_SECRET:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is not available. Install Docker Desktop or the compose plugin first." >&2
  exit 1
fi

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building and starting signaling + coturn..."
docker compose up -d --build signaling coturn

echo "==> Waiting for the signaling server..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:3000/health || { echo "signaling server did not become healthy" >&2; exit 1; }

echo "==> Running the two lab clients (separate networks, no direct path)..."
docker compose run --rm --name voip-lab-client-a client-a > /tmp/voip-lab-client-a.log 2>&1 &
PID_A=$!
docker compose run --rm --name voip-lab-client-b client-b > /tmp/voip-lab-client-b.log 2>&1 &
PID_B=$!
wait "$PID_A" || true
wait "$PID_B" || true

echo ""
echo "==> Candidate matrix"
echo "--- client-a (caller) ---"
cat /tmp/voip-lab-client-a.log
echo "--- client-b (callee) ---"
cat /tmp/voip-lab-client-b.log
echo ""
echo "Expected outcome: both clients report success with a relay/relay"
echo "selected pair, because the two client networks have no direct route."
echo "If the pair is host/* or srflx/*, the networks are not isolated."
