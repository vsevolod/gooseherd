#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${1:-gooseherd/k8s-runner:dev}"
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-minikube}"
MINIKUBE_BUILD_IN_NODE="${MINIKUBE_BUILD_IN_NODE:-0}"
DOCKER_CONFIG="${DOCKER_CONFIG:-/tmp/gooseherd-docker-config}"

mkdir -p "${DOCKER_CONFIG}"
export DOCKER_CONFIG

docker build -f kubernetes/runner.Dockerfile -t "${IMAGE_TAG}" .

if [[ "${MINIKUBE_BUILD_IN_NODE}" == "1" ]]; then
  IMAGE_ARCHIVE="$(mktemp /tmp/gooseherd-k8s-runner-image.XXXXXX.tar)"
  trap 'rm -f "${IMAGE_ARCHIVE}"' EXIT
  echo "[image] streaming ${IMAGE_TAG} into ${MINIKUBE_PROFILE} docker daemon"
  docker save -o "${IMAGE_ARCHIVE}" "${IMAGE_TAG}"
  docker exec -i "${MINIKUBE_PROFILE}" sh -lc "cat > /tmp/gooseherd-k8s-runner-image.tar" < "${IMAGE_ARCHIVE}"
  docker exec "${MINIKUBE_PROFILE}" docker load -i /tmp/gooseherd-k8s-runner-image.tar
  docker exec "${MINIKUBE_PROFILE}" rm -f /tmp/gooseherd-k8s-runner-image.tar
else
  minikube image load "${IMAGE_TAG}"
fi

printf 'Loaded runner image into minikube: %s\n' "${IMAGE_TAG}"
