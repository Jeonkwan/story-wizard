---
name: gcp-secret-manager-keys
description: Authoritative guide and operational playbooks for rotating, updating, and managing AI model API keys (Gemini API keys / AI credits) in Google Secret Manager and Cloud Run with zero downtime.
---

# Google Secret Manager AI Key Management Skill

This skill provides step-by-step procedures for updating, rotating, and managing the Gemini API Key (`GEMINI_API_KEY`) used for story drafting, voice direction, and TTS synthesis in Storyteller Studio.

---

## 1. Secret Architecture Overview

- **Cloud Run Secret Binding:**
  Storyteller Studio is configured to bind Secret Manager secrets directly into container environment variables at runtime:
  ```text
  GEMINI_API_KEY  <---  projects/mokamaker-gcp/secrets/storyteller-gemini-api-key:latest
  SESSION_SECRET  <---  projects/mokamaker-gcp/secrets/storyteller-session-secret:latest
  ```
- **Zero Downtime Automatic Pick-up:**
  Because the Cloud Run service references the `:latest` alias, adding a new secret version in Secret Manager allows newly started container instances to immediately pick up the new key without breaking running tasks.

---

## 2. Operational Playbooks

### Playbook A: Check Current Secret Status & Versions

To list secret versions without exposing the raw secret value:
```bash
gcloud secrets versions list storyteller-gemini-api-key \
  --project=mokamaker-gcp
```

To view the current active secret value (for inspection):
```bash
gcloud secrets versions access latest \
  --secret=storyteller-gemini-api-key \
  --project=mokamaker-gcp
```

---

### Playbook B: Update / Rotate the Gemini API Key

When you generate a new Gemini API key from Google AI Studio / GCP (e.g., when adding billing credits or cycling credentials):

```bash
# 1. Add the new key as the latest version in Secret Manager
gcloud secrets versions add storyteller-gemini-api-key \
  --data-file=- \
  --project=mokamaker-gcp <<< "PASTE_YOUR_NEW_GEMINI_KEY_HERE"

# 2. Trigger an immediate zero-downtime revision on Cloud Run to activate it
gcloud run services update storyteller-studio \
  --region=asia-southeast1 \
  --project=mokamaker-gcp
```

*Note: Passing the key via standard input (`<<< "KEY"`) avoids saving the key in your terminal history.*

---

### Playbook C: Rollback to an Earlier Secret Version

If a newly added key is invalid or lacks quota, you can instantly roll back to version 1:

```bash
# Option 1: Re-bind Cloud Run directly to a specific version number
gcloud run services update storyteller-studio \
  --region=asia-southeast1 \
  --project=mokamaker-gcp \
  --update-secrets="GEMINI_API_KEY=storyteller-gemini-api-key:1"

# Option 2: Destroy or disable the faulty latest version in Secret Manager
gcloud secrets versions disable <FAULTY_VERSION_NUMBER> \
  --secret=storyteller-gemini-api-key \
  --project=mokamaker-gcp
```

---

### Playbook D: Ensure Service Account Permissions

If Cloud Run reports permission errors when accessing Secret Manager, ensure the Cloud Run default compute service account has the `Secret Manager Secret Accessor` role:

```bash
PROJECT_NUM="1038663876987"

gcloud secrets add-iam-policy-binding storyteller-gemini-api-key \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=mokamaker-gcp
```

---

### Playbook E: Update Local Development Key (`.env`)

For local testing in WSL / Windows:
1. Open `.env`:
   ```env
   GEMINI_API_KEY=your_new_gemini_api_key
   ```
2. Run smoke tests to verify the key works:
   ```bash
   npm run test:live
   ```

---

## 3. Verification Checklist

After rotating the Gemini API key:
1. Check that the new version is enabled:
   ```bash
   gcloud secrets versions list storyteller-gemini-api-key --project=mokamaker-gcp
   ```
2. Open the live app at `https://storyteller-studio-1038663876987.asia-southeast1.run.app/admin`.
3. Log in with your admin account.
4. Test voice audition: click **"Audition"** on any voice in the Voice Studio. A 5-second sample should play cleanly using `gemini-3.8-flash-lite-tts`.
5. Test story drafting: generate a 1-turn test draft. If generation succeeds, the new AI credit key is 100% active.
