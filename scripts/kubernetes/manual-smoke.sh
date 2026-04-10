#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT_DIR}"

RUNNER_IMAGE="${RUNNER_IMAGE:-gooseherd/k8s-runner:dev}"
NAMESPACE="${NAMESPACE:-default}"
GOOSEHERD_INTERNAL_BASE_URL="${GOOSEHERD_INTERNAL_BASE_URL:-http://host.minikube.internal:8787}"
OUTPUT_SUBDIR="${OUTPUT_SUBDIR:-tmp/kubernetes-smoke/$(date +%Y%m%d-%H%M%S)}"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/${OUTPUT_SUBDIR}}"
CONTAINER_OUTPUT_DIR="${CONTAINER_OUTPUT_DIR:-/app/${OUTPUT_SUBDIR}}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180s}"

mkdir -p "${OUTPUT_DIR}"

echo "[smoke] building/loading runner image ${RUNNER_IMAGE}"
bash scripts/kubernetes/build-runner-image.sh "${RUNNER_IMAGE}"

echo "[smoke] seeding run metadata and kubernetes manifest"
docker compose run --rm -T \
  -v "${ROOT_DIR}:/app" \
  --entrypoint sh gooseherd \
  -lc "cd /app && node --import tsx scripts/kubernetes/seed-smoke-run.ts ${CONTAINER_OUTPUT_DIR} ${RUNNER_IMAGE} ${GOOSEHERD_INTERNAL_BASE_URL} ${NAMESPACE}" >/dev/null

METADATA_PATH="${OUTPUT_DIR}/metadata.json"
MANIFEST_PATH="${OUTPUT_DIR}/job.yaml"

RUN_ID="$(node -e "const fs=require('fs'); const meta=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(meta.runId);" "${METADATA_PATH}")"
JOB_NAME="$(node -e "const fs=require('fs'); const meta=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(meta.jobName);" "${METADATA_PATH}")"

echo "[smoke] applying manifest ${MANIFEST_PATH}"
kubectl apply -f "${MANIFEST_PATH}"

if ! kubectl wait --namespace "${NAMESPACE}" --for=condition=complete "job/${JOB_NAME}" --timeout="${WAIT_TIMEOUT}"; then
  echo "[smoke] job did not complete successfully; pod logs follow"
  kubectl logs --namespace "${NAMESPACE}" "job/${JOB_NAME}" || true
  kubectl describe job --namespace "${NAMESPACE}" "${JOB_NAME}" || true
  docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/finalize-smoke-run.ts /app/${OUTPUT_SUBDIR}/metadata.json failed" || true
  exit 1
fi

echo "[smoke] job logs"
kubectl logs --namespace "${NAMESPACE}" "job/${JOB_NAME}"

RUN_JSON_RAW="$(docker compose run --rm -T \
  -v "${ROOT_DIR}:/app" \
  --entrypoint sh gooseherd \
  -lc "cd /app && node --import tsx scripts/kubernetes/finalize-smoke-run.ts /app/${OUTPUT_SUBDIR}/metadata.json succeeded")"
RUN_JSON="$(printf '%s\n' "${RUN_JSON_RAW}" | tail -n 1)"

RUN_STATUS="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${RUN_JSON}")"

echo "[smoke] run ${RUN_ID} finalized as ${RUN_STATUS}"
if [[ "${RUN_STATUS}" != "completed" ]]; then
  echo "[smoke] expected completed status"
  exit 1
fi

echo "[smoke] success"
