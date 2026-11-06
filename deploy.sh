#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Storyteller Studio — Production Google Cloud Run Deployment Script
# Zero secrets hardcoded. Reads from environment variables or Google Secret Manager.
# ==============================================================================

# Ensure non-interactive gcloud execution
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

# Default Configuration Parameters
SERVICE_NAME="${SERVICE_NAME:-storyteller-studio}"
REGION="${REGION:-asia-southeast1}"
GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-storyteller-studio-mokamaker}"
ADMIN_GOOGLE_EMAIL="${ADMIN_GOOGLE_EMAIL:-jeonkwan@gmail.com}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"

# Secret Manager Names (or read from environment)
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-storyteller-session-secret}"
GEMINI_API_KEY_NAME="${GEMINI_API_KEY_NAME:-storyteller-gemini-api-key}"
SESSION_SECRET="${SESSION_SECRET:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"

DRY_RUN=false

# Helper for non-interactive, bounded gcloud commands
safe_gcloud() {
  if command -v timeout &> /dev/null; then
    timeout 6s gcloud "$@" --quiet < /dev/null
  else
    gcloud "$@" --quiet < /dev/null
  fi
}

# Parse CLI arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --region=*)
      REGION="${1#*=}"
      shift
      ;;
    --service|--service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --service=*|--service-name=*)
      SERVICE_NAME="${1#*=}"
      shift
      ;;
    --bucket|--bucket-name)
      GCS_BUCKET_NAME="$2"
      shift 2
      ;;
    --bucket=*|--bucket-name=*)
      GCS_BUCKET_NAME="${1#*=}"
      shift
      ;;
    --project|--project-id)
      PROJECT_ID="$2"
      shift 2
      ;;
    --project=*|--project-id=*)
      PROJECT_ID="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "Storyteller Studio — Cloud Run Deployment"
      echo ""
      echo "Usage: ./deploy.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --dry-run              Inspect configuration and show deploy command without executing"
      echo "  --region=REGION        GCP region (default: asia-southeast1)"
      echo "  --service=SERVICE      Cloud Run service name (default: storyteller-studio)"
      echo "  --bucket=BUCKET        GCS bucket name (default: storyteller-studio-mokamaker)"
      echo "  --project=PROJECT_ID   GCP project ID (default: active gcloud project)"
      echo "  -h, --help             Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage instructions."
      exit 1
      ;;
  esac
done

echo "=================================================="
if [ "$DRY_RUN" = true ]; then
  echo " Storyteller Studio — Cloud Run Deployment [DRY RUN]"
else
  echo " Storyteller Studio — Cloud Run Deployment"
fi
echo "=================================================="

# Check gcloud CLI installation
if ! command -v gcloud &> /dev/null; then
  echo "Error: gcloud CLI is not installed or not in PATH."
  echo "Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(safe_gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "Error: No active GCP project configured in gcloud."
  echo "Set your project: gcloud config set project <PROJECT_ID>"
  exit 1
fi

echo "Project ID:   ${PROJECT_ID}"
echo "Service Name: ${SERVICE_NAME}"
echo "Region:       ${REGION}"
echo "GCS Bucket:   ${GCS_BUCKET_NAME}"
echo "Admin Email:  ${ADMIN_GOOGLE_EMAIL}"
echo ""

echo "Pre-flight Environment & Secret Inspection:"

# 1. Verify Authentication
ACTIVE_ACCOUNT="$(safe_gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -n 1 || true)"
if [ -n "${ACTIVE_ACCOUNT}" ]; then
  echo "  [OK] Authenticated Account: ${ACTIVE_ACCOUNT}"
else
  if [ "$DRY_RUN" = true ]; then
    echo "  [WARNING] No active gcloud authenticated account found (run 'gcloud auth login')"
  else
    echo "  [ERROR] No active gcloud authenticated account found. Run 'gcloud auth login' first."
    exit 1
  fi
fi

# 2. Check GCS Bucket
if [ -n "${GCS_BUCKET_NAME}" ]; then
  if safe_gcloud storage buckets describe "gs://${GCS_BUCKET_NAME}" --project="${PROJECT_ID}" &>/dev/null; then
    echo "  [OK] GCS Bucket gs://${GCS_BUCKET_NAME} exists and is accessible"
  else
    echo "  [INFO] GCS Bucket gs://${GCS_BUCKET_NAME} not found or not yet created."
    echo "         Creation command:"
    echo "           gcloud storage buckets create gs://${GCS_BUCKET_NAME} --project=${PROJECT_ID} --location=${REGION} --uniform-bucket-level-access"
    echo "         Versioning command:"
    echo "           gcloud storage buckets update gs://${GCS_BUCKET_NAME} --versioning"
    echo "         Lifecycle command:"
    echo "           gcloud storage buckets update gs://${GCS_BUCKET_NAME} --lifecycle-file=gcs-lifecycle.json"
  fi
fi

# 3. Check Secret Manager & Environment Variables
SESSION_SECRET_SOURCE=""
if safe_gcloud secrets describe "${SESSION_SECRET_NAME}" --project="${PROJECT_ID}" &>/dev/null; then
  SESSION_SECRET_SOURCE="secret"
  echo "  [OK] SESSION_SECRET: Found in Secret Manager ('${SESSION_SECRET_NAME}')"
elif [ -n "${SESSION_SECRET}" ]; then
  if [ ${#SESSION_SECRET} -ge 32 ]; then
    SESSION_SECRET_SOURCE="env"
    echo "  [OK] SESSION_SECRET: Provided via environment variable (${#SESSION_SECRET} chars)"
  else
    echo "  [ERROR] SESSION_SECRET environment variable is too short (${#SESSION_SECRET} chars, minimum 32 required)"
  fi
else
  echo "  [MISSING] SESSION_SECRET: Not found in Secret Manager ('${SESSION_SECRET_NAME}') or environment"
fi

GEMINI_API_KEY_SOURCE=""
if safe_gcloud secrets describe "${GEMINI_API_KEY_NAME}" --project="${PROJECT_ID}" &>/dev/null; then
  GEMINI_API_KEY_SOURCE="secret"
  echo "  [OK] GEMINI_API_KEY: Found in Secret Manager ('${GEMINI_API_KEY_NAME}')"
elif [ -n "${GEMINI_API_KEY}" ]; then
  GEMINI_API_KEY_SOURCE="env"
  echo "  [OK] GEMINI_API_KEY: Provided via environment variable"
else
  echo "  [MISSING] GEMINI_API_KEY: Not found in Secret Manager ('${GEMINI_API_KEY_NAME}') or environment"
fi

if [ -n "${GOOGLE_CLIENT_ID}" ]; then
  echo "  [OK] GOOGLE_CLIENT_ID: Configured"
else
  echo "  [INFO] GOOGLE_CLIENT_ID: Unset (Admin GIS login requires Google OAuth Web Client ID)"
fi

# Build deployment parameters
SECRETS_LIST=()
if [ "$SESSION_SECRET_SOURCE" = "secret" ]; then
  SECRETS_LIST+=("SESSION_SECRET=${SESSION_SECRET_NAME}:latest")
elif [ "$DRY_RUN" = true ] && [ "$SESSION_SECRET_SOURCE" != "env" ]; then
  SECRETS_LIST+=("SESSION_SECRET=${SESSION_SECRET_NAME}:latest")
fi

if [ "$GEMINI_API_KEY_SOURCE" = "secret" ]; then
  SECRETS_LIST+=("GEMINI_API_KEY=${GEMINI_API_KEY_NAME}:latest")
elif [ "$DRY_RUN" = true ] && [ "$GEMINI_API_KEY_SOURCE" != "env" ]; then
  SECRETS_LIST+=("GEMINI_API_KEY=${GEMINI_API_KEY_NAME}:latest")
fi

ENV_LIST=()
if [ -n "${GCS_BUCKET_NAME}" ]; then
  ENV_LIST+=("GCS_BUCKET_NAME=${GCS_BUCKET_NAME}")
fi
if [ -n "${ADMIN_GOOGLE_EMAIL}" ]; then
  ENV_LIST+=("ADMIN_GOOGLE_EMAIL=${ADMIN_GOOGLE_EMAIL}")
fi
if [ -n "${GOOGLE_CLIENT_ID}" ]; then
  ENV_LIST+=("GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}")
fi
if [ "$SESSION_SECRET_SOURCE" = "env" ]; then
  ENV_LIST+=("SESSION_SECRET=${SESSION_SECRET}")
fi
if [ "$GEMINI_API_KEY_SOURCE" = "env" ]; then
  ENV_LIST+=("GEMINI_API_KEY=${GEMINI_API_KEY}")
fi

DEPLOY_ARGS=(
  "${SERVICE_NAME}"
  "--source" "."
  "--region" "${REGION}"
  "--project" "${PROJECT_ID}"
  "--allow-unauthenticated"
  "--min-instances=0"
  "--max-instances=1"
  "--concurrency=80"
  "--timeout=300"
  "--memory=512Mi"
  "--cpu=1"
)

JOINED_SECRETS=""
if [ ${#SECRETS_LIST[@]} -gt 0 ]; then
  JOINED_SECRETS="$(IFS=,; echo "${SECRETS_LIST[*]}")"
  DEPLOY_ARGS+=("--set-secrets=${JOINED_SECRETS}")
fi

JOINED_ENVS=""
if [ ${#ENV_LIST[@]} -gt 0 ]; then
  JOINED_ENVS="$(IFS=,; echo "${ENV_LIST[*]}")"
  DEPLOY_ARGS+=("--set-env-vars=${JOINED_ENVS}")
fi

echo ""
echo "Target Deployment Command:"
echo "--------------------------------------------------"
echo "gcloud run deploy \\"
echo "  ${SERVICE_NAME} \\"
echo "  --source . \\"
echo "  --region ${REGION} \\"
echo "  --project ${PROJECT_ID} \\"
echo "  --allow-unauthenticated \\"
echo "  --min-instances=0 \\"
echo "  --max-instances=1 \\"
echo "  --concurrency=80 \\"
echo "  --timeout=300 \\"
echo "  --memory=512Mi \\"
echo "  --cpu=1"
if [ ${#SECRETS_LIST[@]} -gt 0 ]; then
  echo "  --set-secrets=\"${JOINED_SECRETS}\""
fi
if [ ${#ENV_LIST[@]} -gt 0 ]; then
  echo "  --set-env-vars=\"${JOINED_ENVS}\""
fi
echo "--------------------------------------------------"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[DRY RUN COMPLETE] Configuration verified. No Cloud Run changes were applied."
  exit 0
fi

# Live Execution Pre-flight Checks (Fail-Closed)
if [ -z "$SESSION_SECRET_SOURCE" ]; then
  echo ""
  echo "ERROR: SESSION_SECRET is required for production Cloud Run deployment."
  echo "To resolve:"
  echo "  1) Store in Secret Manager (Recommended):"
  echo "     gcloud secrets create ${SESSION_SECRET_NAME} --data-file=- <<< 'your-random-32+-char-secret' --project=${PROJECT_ID}"
  echo "  2) Or provide via environment variable:"
  echo "     export SESSION_SECRET='your-random-32+-char-secret'"
  exit 1
fi

if [ -z "$GEMINI_API_KEY_SOURCE" ]; then
  echo ""
  echo "ERROR: GEMINI_API_KEY is required for story generation and TTS synthesis."
  echo "To resolve:"
  echo "  1) Store in Secret Manager (Recommended):"
  echo "     gcloud secrets create ${GEMINI_API_KEY_NAME} --data-file=- <<< 'AIza...' --project=${PROJECT_ID}"
  echo "  2) Or provide via environment variable:"
  echo "     export GEMINI_API_KEY='AIza...'"
  exit 1
fi

echo ""
echo "Initiating Cloud Run deployment..."
exec gcloud run deploy "${DEPLOY_ARGS[@]}"
