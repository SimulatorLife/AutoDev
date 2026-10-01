#!/usr/bin/env bash
#
# Pin and verify the first-party OpenLIT image for AutoDev.
#
# OpenLIT 2.1.0 does NOT ship a generic producer-facing otelcol pass-through.
# Producers send standard OTLP directly to OpenLIT's first-party OTLP/HTTP
# receiver on :4318 (or gRPC :4317). This script pulls and verifies the
# published image digest; it does not introduce a sidecar Collector.
#
# Inputs:
#   AUTODEV_OPENLIT_IMAGE         image ref to pin (default ghcr.io/openlit/openlit:2.1.0)
#   AUTODEV_OPENLIT_IMAGE_DIGEST  expected digest (default the pinned value)
#
# Exit codes:
#   0  image pulled and digest matches the pinned value
#   1  invalid invocation
#   2  pulled digest does not match the pinned digest

set -euo pipefail

IMAGE="${AUTODEV_OPENLIT_IMAGE:-ghcr.io/openlit/openlit:2.1.0}"
EXPECTED_DIGEST="${AUTODEV_OPENLIT_IMAGE_DIGEST:-sha256:94552ccd09379b5e2fec3c51c4fec1b41d88d6b56b0a5ccc895c116673884fa8}"

if ! command -v docker >/dev/null 2>&1; then
	echo "pin-image.sh: docker is required" >&2
	exit 1
fi

echo "==> Pulling $IMAGE"
docker pull --quiet "$IMAGE" >/dev/null

# Resolve the manifest digest for the pulled tag.
ACTUAL_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" | cut -d@ -f2)"
if [[ -z "$ACTUAL_DIGEST" ]]; then
	# Older docker clients don't populate RepoDigests until the image is
	# referenced by digest. Pull again by tag with --quiet to be sure.
	docker pull --quiet "$IMAGE" >/dev/null
	ACTUAL_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" | cut -d@ -f2)"
fi

if [[ -z "$ACTUAL_DIGEST" ]]; then
	echo "pin-image.sh: could not resolve digest for $IMAGE" >&2
	exit 2
fi

if [[ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]]; then
	echo "pin-image.sh: digest mismatch" >&2
	echo "  expected: $EXPECTED_DIGEST" >&2
	echo "  actual:   $ACTUAL_DIGEST" >&2
	exit 2
fi

# Re-tag by digest so the rest of the deployment can pin by immutable ref.
PINNED_TAG="${IMAGE%:*}@${ACTUAL_DIGEST}"
echo "==> Image pinned at $PINNED_TAG"

cat <<INFO
==> OpenLIT image pin verified.

  ref:        $IMAGE
  digest:     $ACTUAL_DIGEST
  pinned:     $PINNED_TAG

Producers should send standard OTLP directly to the published OpenLIT
container's OTLP/HTTP receiver (:4318) or OTLP/gRPC receiver (:4317).
Do NOT introduce a separate sidecar Collector: OpenLIT 2.1.0 already
provides the receiver, and the target-state document (M1, G1) records
that an additional Collector is not part of the target absent a
documented policy need.

To export AUTODEV_OPENLIT_PINNED_IMAGE to compose manifests:

  export AUTODEV_OPENLIT_PINNED_IMAGE="$PINNED_TAG"
INFO
