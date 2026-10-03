# SOS → WhatsApp alert to emergency contacts

Tests: `test/sos-whatsapp.e2e-spec.ts` (the whole flow with a fake WhatsApp), `src/modules/whatsapp/meta-whatsapp.gateway.spec.ts` (the exact payload sent to Meta), Flutter `test/features/safety/sos_contacts_test.dart`.

## What happens
When a rider or driver presses **SOS**:
1. The safety team is alerted exactly as before. This never waits for WhatsApp.
2. In the background, every emergency contact the person has saved gets a **WhatsApp message** from Tirvona's business number:
   - a **map pin** with where the person was when they pressed SOS,
   - who it is (name, phone), the ride code, the vehicle and the SOS reference,
   - a **Track live** button that opens a public, read-only live page (the same page as "share my ride": ride status and the vehicle moving on a map, refreshing by itself).
3. While the alert stays open, the app sends its newer position every 60 s. The contacts get a **location update** message (a new pin plus the same button), at most every `SOS_CONTACT_UPDATE_MIN_SECONDS` (120) and at most `SOS_CONTACT_UPDATE_MAX` (8) times.
4. When the safety team resolves or closes the incident, the live link stops working.

The person who pressed SOS sees, on their SOS screen, each contact as *Sending… / Sent / Couldn't send. Call them*. The safety team sees the same on the admin SOS page, with every message listed and a **Send again to contacts not reached** button.

### What WhatsApp does and does not allow
The WhatsApp Cloud API **cannot start WhatsApp's own "share live location"** (the moving pin inside a chat). Business messages can carry a **location pin** (a fixed point) and **links**. Tirvona therefore sends the pin of where the person was and a link to a page that shows the live position. A contact who has the live page open follows the ride in real time; the update messages refresh the pin in the chat.

A business can only *start* a conversation with an **approved message template**. That is why two templates must exist before any message is delivered (below).

## What you must set up (one time)

### 1. Create the template `tirvona_sos_alert`
WhatsApp Manager → Message templates → Create template.

| Field | Value |
|---|---|
| Category | **Utility** |
| Name | `tirvona_sos_alert` |
| Language | English (`en`) |
| Header | **Location** (no sample needed; the app sends the pin) |
| Footer | `Tirvona Rides safety` (optional) |
| Button | **Call to action → Visit website**, type **Dynamic**, button text `Track live`, URL `https://YOUR-API-HOST/api/v1/shared-rides/view/{{1}}` (sample suffix: `abc123XYZ`) |

Body (copy exactly; the variables must be numbered `{{1}}` to `{{5}}` in this order):

```
🚨 Emergency alert from Tirvona Rides

{{1}} pressed the SOS button during a ride and may need help.

Phone: {{2}}
Ride: {{3}}
Vehicle: {{4}}
Reference: {{5}}

Their location is shown above. Tap "Track live" to follow the ride on a live map. If you cannot reach them, call 112.
```

Sample values for review: `{{1}}` Asha Verma · `{{2}}` +919876543210 · `{{3}}` TRMYXP9GBB · `{{4}}` UP16AB1234 · White Maruti Dzire · `{{5}}` SOS-RZ4H2Y.

### 2. Create the template `tirvona_sos_update` (recommended)
Same category, language, location header, footer and the same **Track live** button. Body:

```
📍 Location update for {{1}}'s SOS alert ({{2}}). Their latest position is shown above. Tap "Track live" to follow the ride. If you cannot reach them, call 112.
```

Samples: `{{1}}` Asha Verma · `{{2}}` SOS-RZ4H2Y.

Without this one the contacts get only the first alert (the live link still updates by itself).

### 3. The link host must be public
The **Track live** button URL must be the API's public address, and it must match `SHARE_RIDE_LINK_BASE_URL` (default: `<PUBLIC_BASE_URL>/api/v1/shared-rides/view`). Set `PUBLIC_BASE_URL` to your real HTTPS address (for example `https://tirvona-ride.onrender.com`). A `localhost` link is useless to a contact. Meta rejects the send if the button URL does not start with the prefix registered in the template.

### 4. Environment (API)
```
WHATSAPP_PROVIDER=meta                # already set for the signup OTP
SOS_CONTACT_WHATSAPP_ENABLED=true
WHATSAPP_SOS_TEMPLATE_NAME=tirvona_sos_alert
WHATSAPP_SOS_UPDATE_TEMPLATE_NAME=tirvona_sos_update   # empty = first alert only
WHATSAPP_SOS_TEMPLATE_LANGUAGE=en
SOS_CONTACT_UPDATE_MIN_SECONDS=120
SOS_CONTACT_UPDATE_MAX=8
SOS_CONTACT_RETRY_DELAY_MS=1500
```
The signup OTP credentials (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`) are reused.

### 5. Testing before go-live
- A Meta **test** sender can only message numbers on its allow-list (error 131030, reported as "not on WhatsApp"). Add the emergency contact's number to the allowed recipients first.
- Templates take minutes to hours to be approved. Until then a press records the contact as **Couldn't send** (the alert to the safety team is unaffected) and the API log shows `WhatsApp SOS ALERT rejected … [MISCONFIGURED]` with Meta's code (`132001` = template not found or not approved).
- Without WhatsApp configured (`WHATSAPP_PROVIDER=log`) the API prints `[DEV SOS ALERT] …` and records the contact as sent.

## Behaviour details
- **Failures.** A transient failure (WhatsApp unreachable or rate limited) is retried twice with a short pause. A number that is not on WhatsApp, or a template or credentials problem, is not retried. The outcome of every message is stored on the incident (`contactAlerts`), and `contactsNotification` is `SENT` if at least one contact was reached, `FAILED` if none, `NOT_SENT` if there were no contacts or messaging is off. Pressing SOS again retries a contact that was not reached.
- **Nobody is told twice.** One send round per incident runs at a time, and anything already tried is rate limited.
- **The link.** One link per incident (192-bit token, stored hashed on the token record; the raw value is kept on the incident for follow-up messages and never returned by any API). It belongs to the incident: the rider tapping "stop sharing" does not end it, resolving the incident does. It also expires like a share link (`SHARE_RIDE_MAX_HOURS`, and shortly after the ride ends).
- **What the contact can see:** the public ride page (status, pickup and destination addresses, driver first name, vehicle, the vehicle's live position). It is the page "share my ride" has always produced.
- **Privacy.** The other party in the ride is not told that SOS was pressed (unchanged). Numbers appear in logs masked.
- **Consent.** Contacts are people the user chose, and the app now tells the user, on the emergency-contacts screen and in the SOS confirmation, that those people will be messaged on WhatsApp. WhatsApp's policy expects recipients to have agreed to business messages; keep that text.
- **Cost.** Each message is a WhatsApp utility conversation charged to your Meta account: one per contact for the alert, plus up to `SOS_CONTACT_UPDATE_MAX` updates.
- **Several API servers.** The "one round at a time" bookkeeping is per process; the stored per-contact history and the rate limit are shared, so servers cannot flood a contact, but two servers could in theory send the first alert at the same moment.

## API
- `POST /rides/:id/sos` and `GET /rides/:id/sos` now include `contacts: [{ name, status: SENT | FAILED | PENDING, lastSentAt? }]` (no phone numbers).
- `GET /admin/sos/:id` adds `contactAlerts[]` (name, phone, kind ALERT or UPDATE, status, failure, attempts, at) and `trackingActive`.
- `POST /admin/sos/:id/notify-contacts`: send the alert again to contacts not reached yet (open incidents only).
