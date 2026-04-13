#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT_DIR}"

RUNNER_IMAGE="${RUNNER_IMAGE:-gooseherd/k8s-runner:dev}"
NAMESPACE="${NAMESPACE:-default}"
GOOSEHERD_INTERNAL_BASE_URL="${GOOSEHERD_INTERNAL_BASE_URL:-http://host.minikube.internal:8787}"
HARNESS_SUBDIR="${HARNESS_SUBDIR:-tmp/kubernetes-harness/$(date +%Y%m%d-%H%M%S)}"
HARNESS_DIR="${HARNESS_DIR:-${ROOT_DIR}/${HARNESS_SUBDIR}}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180s}"
RUNNING_TIMEOUT_SECONDS="${RUNNING_TIMEOUT_SECONDS:-60}"

mkdir -p "${HARNESS_DIR}"

json_field() {
  local file="$1"
  local field="$2"
  node -e "const fs=require('fs'); const obj=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(obj[process.argv[2]] ?? ''));" "${file}" "${field}"
}

seed_scenario() {
  local scenario="$1"
  local pipeline_file="$2"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local container_dir="/app/${HARNESS_SUBDIR}/${scenario}"
  mkdir -p "${host_dir}"

  docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/seed-smoke-run.ts ${container_dir} ${RUNNER_IMAGE} ${GOOSEHERD_INTERNAL_BASE_URL} ${NAMESPACE} ${pipeline_file} ${scenario}" >/dev/null
}

finalize_scenario() {
  local scenario="$1"
  local runtime_fact="$2"
  local container_metadata="/app/${HARNESS_SUBDIR}/${scenario}/metadata.json"
  local raw_json
  raw_json="$(docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/finalize-smoke-run.ts ${container_metadata} ${runtime_fact}")"
  printf '%s\n' "${raw_json}" | tail -n 1
}

request_cancel() {
  local scenario="$1"
  docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/request-cancel.ts /app/${HARNESS_SUBDIR}/${scenario}/metadata.json" >/dev/null
}

cleanup_resources() {
  local scenario="$1"
  node --import tsx "scripts/kubernetes/cleanup-run.ts" "${HARNESS_DIR}/${scenario}/metadata.json" >/dev/null
}

override_run_token() {
  local scenario="$1"
  local run_token="$2"
  docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/override-secret-token.ts /app/${HARNESS_SUBDIR}/${scenario}/job.yaml ${run_token}" >/dev/null
}

override_internal_base_url() {
  local scenario="$1"
  local base_url="$2"
  docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/override-internal-base-url.ts /app/${HARNESS_SUBDIR}/${scenario}/job.yaml ${base_url}" >/dev/null
}

override_runner_image() {
  local scenario="$1"
  local image="$2"
  docker compose run --rm -T \
    -v "${ROOT_DIR}:/app" \
    --entrypoint sh gooseherd \
    -lc "cd /app && node --import tsx scripts/kubernetes/override-runner-image.ts /app/${HARNESS_SUBDIR}/${scenario}/job.yaml ${image}" >/dev/null
}

wait_for_pod_running() {
  local job_name="$1"
  local deadline=$((SECONDS + RUNNING_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    local phase
    phase="$(kubectl get pods --namespace "${NAMESPACE}" -l "job-name=${job_name}" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)"
    if [[ "${phase}" == "Running" ]]; then
      return 0
    fi
    sleep 1
  done

  echo "[harness] timed out waiting for pod of ${job_name} to reach Running"
  return 1
}

wait_for_pod_waiting_reason() {
  local job_name="$1"
  local expected_regex="$2"
  local deadline=$((SECONDS + RUNNING_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    local reason
    reason="$(kubectl get pods --namespace "${NAMESPACE}" -l "job-name=${job_name}" -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)"
    if [[ "${reason}" =~ ${expected_regex} ]]; then
      return 0
    fi
    sleep 1
  done

  echo "[harness] timed out waiting for pod of ${job_name} to reach waiting reason ${expected_regex}"
  return 1
}

assert_cleanup_complete() {
  local metadata_path="$1"
  local job_name secret_name
  job_name="$(json_field "${metadata_path}" "jobName")"
  secret_name="$(json_field "${metadata_path}" "secretName")"

  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    local job_ref secret_ref pod_count
    job_ref="$(kubectl get job "${job_name}" --namespace "${NAMESPACE}" --ignore-not-found -o name)"
    secret_ref="$(kubectl get secret "${secret_name}" --namespace "${NAMESPACE}" --ignore-not-found -o name)"
    pod_count="$(kubectl get pods --namespace "${NAMESPACE}" -l "job-name=${job_name}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"

    if [[ -z "${job_ref}" && -z "${secret_ref}" && "${pod_count}" == "0" ]]; then
      return 0
    fi

    sleep 1
  done

  echo "[harness] cleanup incomplete for ${job_name}"
  kubectl get pods,jobs,secrets --namespace "${NAMESPACE}" | grep "${job_name}\|${secret_name}" || true
  return 1
}

run_success_scenario() {
  local scenario="success"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local metadata_path="${host_dir}/metadata.json"
  local manifest_path="${host_dir}/job.yaml"

  seed_scenario "${scenario}" "pipelines/kubernetes-smoke.yml"

  local run_id job_name
  run_id="$(json_field "${metadata_path}" "runId")"
  job_name="$(json_field "${metadata_path}" "jobName")"

  echo "[harness] success: applying ${job_name}"
  kubectl apply -f "${manifest_path}"
  kubectl wait --namespace "${NAMESPACE}" --for=condition=complete "job/${job_name}" --timeout="${WAIT_TIMEOUT}"
  kubectl logs --namespace "${NAMESPACE}" "job/${job_name}"

  local run_json run_status
  run_json="$(finalize_scenario "${scenario}" "succeeded")"
  run_status="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${run_json}")"

  if [[ "${run_status}" != "completed" ]]; then
    echo "[harness] success scenario expected completed, got ${run_status}"
    return 1
  fi

  cleanup_resources "${scenario}"
  assert_cleanup_complete "${metadata_path}"
  echo "[harness] success scenario passed for ${run_id}"
}

run_invalid_token_scenario() {
  local scenario="invalid-token"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local metadata_path="${host_dir}/metadata.json"
  local manifest_path="${host_dir}/job.yaml"

  seed_scenario "${scenario}" "pipelines/kubernetes-smoke.yml"
  override_run_token "${scenario}" "invalid-run-token"

  local run_id job_name
  run_id="$(json_field "${metadata_path}" "runId")"
  job_name="$(json_field "${metadata_path}" "jobName")"

  echo "[harness] invalid-token: applying ${job_name}"
  kubectl apply -f "${manifest_path}"
  kubectl wait --namespace "${NAMESPACE}" --for=condition=failed "job/${job_name}" --timeout="${WAIT_TIMEOUT}"

  local log_output
  log_output="$(kubectl logs --namespace "${NAMESPACE}" "job/${job_name}")"
  printf '%s\n' "${log_output}"

  if [[ "${log_output}" != *"terminal status 401 for payload"* ]]; then
    echo "[harness] invalid-token scenario expected a 401 payload auth failure"
    return 1
  fi

  local run_json run_status
  run_json="$(finalize_scenario "${scenario}" "failed")"
  run_status="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${run_json}")"

  if [[ "${run_status}" != "failed" ]]; then
    echo "[harness] invalid-token scenario expected failed, got ${run_status}"
    return 1
  fi

  cleanup_resources "${scenario}"
  assert_cleanup_complete "${metadata_path}"
  echo "[harness] invalid-token scenario passed for ${run_id}"
}

run_control_plane_down_scenario() {
  local scenario="control-plane-down"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local metadata_path="${host_dir}/metadata.json"
  local manifest_path="${host_dir}/job.yaml"

  seed_scenario "${scenario}" "pipelines/kubernetes-smoke.yml"
  override_internal_base_url "${scenario}" "http://host.minikube.internal:1"

  local run_id job_name
  run_id="$(json_field "${metadata_path}" "runId")"
  job_name="$(json_field "${metadata_path}" "jobName")"

  echo "[harness] control-plane-down: applying ${job_name}"
  kubectl apply -f "${manifest_path}"
  kubectl wait --namespace "${NAMESPACE}" --for=condition=failed "job/${job_name}" --timeout="${WAIT_TIMEOUT}"

  local log_output
  log_output="$(kubectl logs --namespace "${NAMESPACE}" "job/${job_name}")"
  printf '%s\n' "${log_output}"

  if [[ "${log_output}" != *"retry budget exhausted for payload"* ]]; then
    echo "[harness] control-plane-down scenario expected payload retry exhaustion"
    return 1
  fi

  local run_json run_status
  run_json="$(finalize_scenario "${scenario}" "failed")"
  run_status="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${run_json}")"

  if [[ "${run_status}" != "failed" ]]; then
    echo "[harness] control-plane-down scenario expected failed, got ${run_status}"
    return 1
  fi

  cleanup_resources "${scenario}"
  assert_cleanup_complete "${metadata_path}"
  echo "[harness] control-plane-down scenario passed for ${run_id}"
}

run_image_pull_backoff_scenario() {
  local scenario="image-pull-backoff"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local metadata_path="${host_dir}/metadata.json"
  local manifest_path="${host_dir}/job.yaml"

  seed_scenario "${scenario}" "pipelines/kubernetes-smoke.yml"
  override_runner_image "${scenario}" "this-image-should-not-exist.invalid/gooseherd:nope"

  local run_id job_name
  run_id="$(json_field "${metadata_path}" "runId")"
  job_name="$(json_field "${metadata_path}" "jobName")"

  echo "[harness] image-pull-backoff: applying ${job_name}"
  kubectl apply -f "${manifest_path}"
  wait_for_pod_waiting_reason "${job_name}" "ImagePullBackOff|ErrImagePull"

  local pod_name describe_output
  pod_name="$(kubectl get pods --namespace "${NAMESPACE}" -l "job-name=${job_name}" -o jsonpath='{.items[0].metadata.name}')"
  describe_output="$(kubectl describe pod --namespace "${NAMESPACE}" "${pod_name}")"
  printf '%s\n' "${describe_output}"

  if [[ "${describe_output}" != *"ImagePullBackOff"* && "${describe_output}" != *"ErrImagePull"* ]]; then
    echo "[harness] image-pull-backoff scenario expected image pull failure details"
    return 1
  fi

  local run_json run_status
  run_json="$(finalize_scenario "${scenario}" "failed")"
  run_status="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${run_json}")"

  if [[ "${run_status}" != "failed" ]]; then
    echo "[harness] image-pull-backoff scenario expected failed, got ${run_status}"
    return 1
  fi

  cleanup_resources "${scenario}"
  assert_cleanup_complete "${metadata_path}"
  echo "[harness] image-pull-backoff scenario passed for ${run_id}"
}

run_failure_scenario() {
  local scenario="failure"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local metadata_path="${host_dir}/metadata.json"
  local manifest_path="${host_dir}/job.yaml"

  seed_scenario "${scenario}" "pipelines/kubernetes-fail-smoke.yml"

  local run_id job_name
  run_id="$(json_field "${metadata_path}" "runId")"
  job_name="$(json_field "${metadata_path}" "jobName")"

  echo "[harness] failure: applying ${job_name}"
  kubectl apply -f "${manifest_path}"
  kubectl wait --namespace "${NAMESPACE}" --for=condition=failed "job/${job_name}" --timeout="${WAIT_TIMEOUT}"
  kubectl logs --namespace "${NAMESPACE}" "job/${job_name}"

  local run_json run_status
  run_json="$(finalize_scenario "${scenario}" "failed")"
  run_status="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${run_json}")"

  if [[ "${run_status}" != "failed" ]]; then
    echo "[harness] failure scenario expected failed, got ${run_status}"
    return 1
  fi

  cleanup_resources "${scenario}"
  assert_cleanup_complete "${metadata_path}"
  echo "[harness] failure scenario passed for ${run_id}"
}

run_cancel_scenario() {
  local scenario="cancel"
  local host_dir="${HARNESS_DIR}/${scenario}"
  local metadata_path="${host_dir}/metadata.json"
  local manifest_path="${host_dir}/job.yaml"

  seed_scenario "${scenario}" "pipelines/kubernetes-cancel-smoke.yml"

  local run_id job_name
  run_id="$(json_field "${metadata_path}" "runId")"
  job_name="$(json_field "${metadata_path}" "jobName")"

  echo "[harness] cancel: applying ${job_name}"
  kubectl apply -f "${manifest_path}"
  wait_for_pod_running "${job_name}"
  request_cancel "${scenario}"
  kubectl wait --namespace "${NAMESPACE}" --for=condition=failed "job/${job_name}" --timeout="${WAIT_TIMEOUT}"
  kubectl logs --namespace "${NAMESPACE}" "job/${job_name}"

  local run_json run_status
  run_json="$(finalize_scenario "${scenario}" "failed")"
  run_status="$(node -e "const run=JSON.parse(process.argv[1]); process.stdout.write(run.status);" "${run_json}")"

  if [[ "${run_status}" != "cancelled" ]]; then
    echo "[harness] cancel scenario expected cancelled, got ${run_status}"
    return 1
  fi

  cleanup_resources "${scenario}"
  assert_cleanup_complete "${metadata_path}"
  echo "[harness] cancel scenario passed for ${run_id}"
}

echo "[harness] building/loading runner image ${RUNNER_IMAGE}"
bash scripts/kubernetes/build-runner-image.sh "${RUNNER_IMAGE}"

run_success_scenario
run_invalid_token_scenario
run_control_plane_down_scenario
run_image_pull_backoff_scenario
run_failure_scenario
run_cancel_scenario

echo "[harness] all scenarios passed"
