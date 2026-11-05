#!/usr/bin/env bash
set -euo pipefail

# Storyteller Studio - Google Cloud Run Deployment Script
# Zero secrets hardcoded. Reads from environment variables or Google Secret Manager.

echo "=================================================="
echo " Storyteller Studio — Cloud Run Deployment"
echo "=================================================="

SERVICE_NAME="${SERVICE_NAME:-storyteller-studio}"
REGION="${REGION:-us-central1}"

# Check gcloud CLI installation
if ! command -v gcloud &> /dev/null; then
  echo "Error: gcloud CLI is not installed or not in PATH."
  echo "Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "Error: No active GCP project configured in gcloud."
  echo "Set your project: gcloud config set project <PROJECT_ID>"
  exit 1
fi

echo "Project ID: ${PROJECT_ID}"
echo "Service:    ${SERVICE_NAME}"
echo "Region:     ${REGION}"
echo ""

echo "Deploying container source to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --region "${REGION}" \
  --allow-unauthenticated \
  --timeout=300 \
  --memory=512Mi \
  --cpu=1

echo ""
echo "Deployment initiated. Verify service URL in gcloud output above."
