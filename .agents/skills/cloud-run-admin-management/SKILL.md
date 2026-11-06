---
name: cloud-run-admin-management
description: Authoritative guide and operational playbooks for viewing, adding, removing, or changing authorized administrator Google accounts on Storyteller Studio Cloud Run services.
---

# Cloud Run Admin Management Skill

This skill provides step-by-step procedures for managing authorized administrators for Storyteller Studio's `/admin` Director & Voice Studio.

---

## 1. How Administrator Authentication Works

- **Zero-Database Access Control:** Administrator access is gated strictly by Google Identity Services (GIS) ID tokens.
- **Environment Variable:** The server reads `ADMIN_GOOGLE_EMAIL`, which supports:
  - A single email: `jeonkwan@gmail.com`
  - Multiple comma-separated emails: `jeonkwan@gmail.com, partner@example.com, collaborator@domain.com`
- **Verification Rule:** When any user signs in with Google, the server verifies `payload.email_verified === true` and asserts that the normalized lowercase email exists in `ADMIN_GOOGLE_EMAIL`.
- **Session:** Authorized logins receive an HMAC-SHA256 signed `story_admin_session` cookie valid for 7 days. Unauthorized emails receive `HTTP 403 Forbidden`.

---

## 2. Operational Playbooks

### Playbook A: View Current Authorized Admin(s)

To view the currently active admin email(s) on the Cloud Run service:
```bash
gcloud run services describe storyteller-studio \
  --region=asia-southeast1 \
  --project=mokamaker-gcp \
  --format="value(spec.template.spec.containers[0].env.filter(name:ADMIN_GOOGLE_EMAIL).value)"
```

Alternatively, query the live public API endpoint:
```bash
curl -s https://storyteller-studio-1038663876987.asia-southeast1.run.app/api/admin/me
```

---

### Playbook B: Add a Co-Admin (Keep Existing Admin)

To add a new admin while keeping the existing admin (`jeonkwan@gmail.com`):

```bash
# Example: Adding co-creator 'co-creator@gmail.com'
gcloud run services update storyteller-studio \
  --region=asia-southeast1 \
  --project=mokamaker-gcp \
  --update-env-vars=ADMIN_GOOGLE_EMAIL="jeonkwan@gmail.com,co-creator@gmail.com"
```

*Note: Spaces after commas are automatically trimmed by the backend.*

---

### Playbook C: Change / Replace the Primary Admin

To replace the admin with a completely different Google account:

```bash
# Example: Transferring admin to 'new-owner@gmail.com'
gcloud run services update storyteller-studio \
  --region=asia-southeast1 \
  --project=mokamaker-gcp \
  --update-env-vars=ADMIN_GOOGLE_EMAIL="new-owner@gmail.com"
```

---

### Playbook D: Remove an Admin

To revoke admin access for one person in a multi-admin setup:
```bash
# Simply update the variable with only the remaining allowed accounts:
gcloud run services update storyteller-studio \
  --region=asia-southeast1 \
  --project=mokamaker-gcp \
  --update-env-vars=ADMIN_GOOGLE_EMAIL="jeonkwan@gmail.com"
```
The revoked user's current session will fail on their next request or cookie expiration.

---

## 3. Local Development (`.env`)

For local development in WSL / Windows:
1. Edit `.env` in the repository root:
   ```env
   ADMIN_GOOGLE_EMAIL=jeonkwan@gmail.com,co-creator@gmail.com
   ```
2. Restart the dev server (`npm run dev` or `npm start`).

---

## 4. Verification Checklist

After updating the admin emails:
1. Verify Cloud Run revision updated successfully:
   ```bash
   gcloud run services describe storyteller-studio --region=asia-southeast1 --format="value(status.latestReadyRevisionName)"
   ```
2. Open `https://storyteller-studio-1038663876987.asia-southeast1.run.app/admin`.
3. Test signing in with the newly added email: should succeed and open Director Studio.
4. Test signing in with an unauthorized email: should receive `Access denied: account not authorized for admin access`.
