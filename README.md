# Cofiz FCM Relay (Cloudflare Worker)

Free push relay for Cofiz - no Google billing required. The app POSTs
notification payloads here; the worker reads the target user's `fcmToken`
from Firestore and sends the push via FCM HTTP v1.

## One-time setup

### 1. Firebase service account key

Firebase Console -> Project Settings -> Service Accounts ->
**Generate new private key**. Save the JSON; you need
`project_id`, `client_email`, `private_key`.

> Keep this file private. It grants server-level access to the project.

### 2. Deploy the worker

```bash
cd workers/fcm-relay
npm i -g wrangler   # once
wrangler login      # opens browser, no card needed

wrangler secret put FIREBASE_PROJECT_ID     # paste project_id
wrangler secret put FIREBASE_CLIENT_EMAIL   # paste client_email
wrangler secret put FIREBASE_PRIVATE_KEY    # paste private_key (with \n escapes)
wrangler secret put RELAY_SECRET            # any long random string

wrangler deploy
```

Note the printed URL, e.g. `https://cofiz-fcm-relay.<your-subdomain>.workers.dev`.

### 3. App config

Put the URL + the same RELAY_SECRET into
`app/lib/core/config/relay_config.dart` (`relayUrl`, `relaySecret`).
The sync executor posts every synced distribution/purchase there.

## Verify it works

```bash
curl -X POST https://cofiz-fcm-relay.<sub>.workers.dev/ \
  -H "Content-Type: application/json" \
  -H "X-Relay-Secret: <RELAY_SECRET>" \
  -d '{"targetUserId":"<some-uid-with-token>","title":"Test","body":"Hello"}'
```

Expect `{"sent":true}` and a push on the device.

## WhatsApp OTP login

Flow: app `POST /auth/whatsapp/start` `{phone, provider}` →
worker stores a hashed challenge in `OTP_KV`, sends a 6-digit code via the
Meta WhatsApp Cloud API template `cofiz_otp` (Utility, `en_US`) →
app `POST /auth/whatsapp/verify` `{phone, provider, challengeId, code}` →
worker checks the hash (5 attempts), enforces the `pending` role gate,
PATCHes `lastLoginAt`, and returns a Firebase `customToken`.
Resend: `POST /auth/whatsapp/resend` (60s cooldown, enforced in KV).

Setup (one-time):

1. Meta dashboard: create/locate a WhatsApp app, onboard the business phone
   number, and create a single-parameter template named exactly
   `cofiz_otp` (`en_US`). Note: `AUTHENTICATION`-category templates require
   a verified business plus messaging volume, which test accounts cannot
   meet — a `UTILITY` template (e.g. from the Template Library) works for
   development instead.
2. Worker secrets:
```bash
wrangler secret put WHATSAPP_PHONE_ID     # Meta phone_number_id (digits only)
wrangler secret put WHATSAPP_ACCESS_TOKEN # system-user token with whatsapp_messaging
```
3. Smoke test (use a registered phone; unregistered returns
   `phone_not_registered`, pending returns `pending_approval`):
```bash
curl -X POST https://cofiz.natanim.dev/auth/whatsapp/start \
  -H "Content-Type: application/json" \
  -H "X-Relay-Secret: <RELAY_SECRET>" \
  -d '{"phone":"+251911234567","provider":"whatsapp"}'
# Expect {"challengeId":"...","expiresIn":600} and a WhatsApp message.
```

Notes: the worker strips the leading `+` before calling Meta (`to` must be
digits only). Send failures return `whatsapp_send_failed` (502) and clear
the challenge so the user can retry immediately.
