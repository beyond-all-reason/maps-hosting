#!/bin/bash

set -euo pipefail

function log {
    echo -e "\e[1;32m$1\e[0m"
}

cd $(dirname $(realpath -s "$0"))

if [[ -z "${1-}" || ! "$1" =~ ^(dev|prod)$ ]]; then
    echo "Usage: $0 <dev|prod>"
    exit 1
fi
ENV="$1"

log "Authenticated to GCP as $(gcloud auth list --filter=status:ACTIVE --format="value(account)")"
log "Logged in to Pulumi as $(pulumi whoami)"

if [[ $ENV == "dev" ]]; then
    log "Build and push worker script..."
    UPLOAD_TARGET="$(pulumi stack -s dev output workerScriptUploadTarget)"
    pushd ../fetcher
    npm install
    npm run build
    gcloud storage cp dist/index.js "$UPLOAD_TARGET"
    popd

    log "Build and push cacher..."
    CACHE_IMAGE_NAME="$(pulumi stack -s dev output cacherImageName)"
    pushd ../cacher
    podman build --format=docker -t "$CACHE_IMAGE_NAME" .. -f Dockerfile
    podman push "$CACHE_IMAGE_NAME"
    popd

    log "Deploying dev stack..."
    pulumi up -s dev
elif [[ $ENV == "prod" ]]; then
    log "Copy worker script from dev..."
    UPLOAD_TARGET_DEV="$(pulumi stack -s dev output workerScriptUploadTarget)"
    UPLOAD_TARGET="$(pulumi stack -s prod output workerScriptUploadTarget)"
    gsutil cp "$UPLOAD_TARGET_DEV" "$UPLOAD_TARGET"

    log "Copy cacher image from dev..."
    CACHE_IMAGE_NAME_DEV="$(pulumi stack -s dev output cacherImageName)"
    CACHE_IMAGE_NAME="$(pulumi stack -s prod output cacherImageName)"
    podman pull "$CACHE_IMAGE_NAME_DEV"
    podman tag "$CACHE_IMAGE_NAME_DEV" "$CACHE_IMAGE_NAME"
    podman push "$CACHE_IMAGE_NAME"

    log "Deploying prod stack..."
    pulumi up -s prod
fi

log "Done!"
