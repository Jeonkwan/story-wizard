#!/usr/bin/env bash
set -euo pipefail

# Storyteller Studio - Google Cloud Run Deployment Script
# Zero secrets hardcoded. Reads from environment variables or Google Secret Manager.
#
# ==============================================================================
# Required Production Environment Variables (fail-closed in server/config.ts):
# ==============================================================================
#
# 1. SESSION_SECRET (CRITICAL):
#    Must be at least 32 characters long. In production (K_SERVICE or NODE_ENV=production),
#    the server will throw an error and refuse to boot if SESSION_SECRET is unset or too short.
#    Recommended: store in Secret Manager and bind via --set-secrets.
#
# 2. GEMINI_API_KEY (REQUIRED for story generation & TTS synthesis):
#    API key for Gemini 3.8 Flash, Flash-TTS, and Flash-Lite-TTS models.
#    Recommended: store in Secret Manager and bind via --set-secrets.
#
# 3. GCS_BUCKET_NAME (RECOMMENDED for persistent catalog & audio on Cloud Run):
#    If set, the server uses GoogleCloudStorageAdapter with atomic updates and Range streaming.
#    If omitted, local filesystem storage is used (ephemeral on Cloud Run instances).
#
# 4. ADMIN_GOOGLE_EMAIL & GOOGLE_CLIENT_ID (REQUIRED for production admin authentication):
#    Admin email permitted to log in via Google Identity Services (GIS).
#
# Example gcloud Secret Manager setup:
#   gcloud secrets create storyteller-session-secret --data-file=- <<< "your-random-32+-char-secret"
#   gcloud secrets create storyteller-gemini-api-key --data-file=- <<< "AIza..."
#
# Example gcloud run deploy with secrets and env vars:
#   gcloud run deploy storyteller-studio \
#     --source . \
#     --region us-central1 \
#     --allow-unauthenticated \
#     --timeout=300 \
#     --memory=512Mi \
#     --cpu=1 \
#     --set-secrets="SESSION_SECRET=storyteller-session-secret:latest,GEMINI_API_KEY=storyteller-gemini-api-key:latest" \
#     --set-env-vars="GCS_BUCKET_NAME=my-storyteller-bucket,ADMIN_GOOGLE_EMAIL=admin@example.com,GOOGLE_CLIENT_ID=123.apps.googleusercontent.com"
# ==============================================================================

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
echo "Pre-flight configuration checklist:"
echo "  [?] SESSION_SECRET (>= 32 chars) bound via Secret Manager or Cloud Run env"
echo "  [?] GEMINI_API_KEY bound via Secret Manager or Cloud Run env"
echo "  [?] GCS_BUCKET_NAME configured for persistent storage (optional for local data)"
echo "  [?] ADMIN_GOOGLE_EMAIL & GOOGLE_CLIENT_ID configured for admin auth"
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
echo "Reminder: Ensure Secret Manager secrets are bound and IAM service account has 'Secret Manager Secret Accessor' role."
