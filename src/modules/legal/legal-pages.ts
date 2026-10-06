/**
 * Public legal pages: the URLs Google Play asks for (privacy policy and
 * "delete your account" web link) and the terms the app links to.
 *
 * Plain server-rendered HTML with no JavaScript, like the share-ride page, so
 * it passes the API's Content-Security-Policy. Wording describes what the
 * apps really do (docs/account-deletion/README.md keeps the two in step).
 * It is a working draft: the owner must have it reviewed before publishing.
 */

export interface LegalContext {
  entityName: string;
  supportEmail: string;
  supportPhone: string;
  /** Public origin of the API, used for cross-links between the pages. */
  baseUrl: string;
}

/** Bump when the wording changes in substance. */
export const LEGAL_LAST_UPDATED = "7 October 2026";

export const LEGAL_PATHS = {
  privacy: "/api/v1/legal/privacy",
  terms: "/api/v1/legal/terms",
  deleteAccount: "/api/v1/legal/delete-account",
} as const;

export const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
  :root { color-scheme: light; --ink:#1B2A4A; --muted:#5B6475; --accent:#F28C28; --bg:#FBF7F0; --card:#FFFFFF; --line:#E7DFD3; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); line-height:1.6; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  .brand { font-weight:800; font-size:20px; margin-bottom:12px; }
  .brand span { color: var(--accent); }
  article { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:24px 20px; }
  h1 { font-size:26px; margin:0 0 4px; }
  h2 { font-size:18px; margin:28px 0 6px; }
  p, li { font-size:15px; }
  ul, ol { padding-left:20px; }
  .muted { color:var(--muted); font-size:13px; }
  table { border-collapse:collapse; width:100%; margin:8px 0; font-size:14px; }
  th, td { border:1px solid var(--line); padding:8px; text-align:left; vertical-align:top; }
  th { background:#FFF8EE; }
  a { color:var(--ink); font-weight:600; }
  nav { margin-top:16px; font-size:13px; }
  nav a { margin-right:14px; }
`;

function layout(title: string, body: string, ctx: LegalContext): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Tirvona Rides</title>
<style>${STYLE}</style>
</head>
<body><main>
<div class="brand">Tirvona <span>Rides</span></div>
<article>
${body}
</article>
<nav>
<a href="${escapeHtml(ctx.baseUrl + LEGAL_PATHS.privacy)}">Privacy policy</a>
<a href="${escapeHtml(ctx.baseUrl + LEGAL_PATHS.terms)}">Terms of use</a>
<a href="${escapeHtml(ctx.baseUrl + LEGAL_PATHS.deleteAccount)}">Delete your account</a>
</nav>
</main></body>
</html>`;
}

const contact = (ctx: LegalContext): string => {
  const parts = [`<a href="mailto:${escapeHtml(ctx.supportEmail)}">${escapeHtml(ctx.supportEmail)}</a>`];
  if (ctx.supportPhone) parts.push(escapeHtml(ctx.supportPhone));
  return ctx.supportEmail ? parts.join(" · ") : "the support contact shown in the app";
};

export function renderPrivacyPolicy(ctx: LegalContext): string {
  const who = escapeHtml(ctx.entityName);
  return layout(
    "Privacy policy",
    `<h1>Privacy policy</h1>
<p class="muted">Last updated ${LEGAL_LAST_UPDATED}</p>
<p>This policy explains what ${who} ("we") collects through the Tirvona Rides app (for riders and drivers), why, who receives it, and the choices you have. Tirvona Rides is a ride-booking service for pilgrimage and city travel.</p>

<h2>1. What we collect</h2>
<table>
<tr><th>Data</th><th>Why</th></tr>
<tr><td>Name, mobile number, email (optional), password (stored only as a one-way hash)</td><td>To create your account, sign you in and verify your number with a WhatsApp code.</td></tr>
<tr><td>Date of birth and gender (optional), profile photo (optional)</td><td>Your profile; drivers' date of birth also for licence verification.</td></tr>
<tr><td>Precise location: riders when you search, book or track a ride; drivers while they are online, including while the app is in the background with an ongoing notification</td><td>To find nearby drivers, show pickup and route, calculate fares and keep trips safe. We do not collect location when a driver is offline or when a rider is not using the app.</td></tr>
<tr><td>Ride history: pickup and destination, route, time, fare, status, ratings you give or receive</td><td>To run the ride, show your history and receipts, handle disputes and improve safety.</td></tr>
<tr><td>Payment records: amount, method, status and Razorpay references. We never see or store your card, UPI or bank credentials; Razorpay handles them.</td><td>To take payments, issue refunds and pay drivers.</td></tr>
<tr><td>Driver documents: driving licence, vehicle registration, insurance and similar documents and their numbers; vehicle details</td><td>To verify that drivers and vehicles are allowed to operate.</td></tr>
<tr><td>Emergency contacts you add (name and number of another person)</td><td>To message them if you press SOS or share a ride. Please add only people who agree to this.</td></tr>
<tr><td>Voice search</td><td>If you tap the microphone, your device's speech service turns what you say into text for the destination search. We do not record or store audio.</td></tr>
<tr><td>Device and notification data: push token, device type, app version, IP address, security logs</td><td>To deliver ride alerts, keep your account secure and prevent abuse.</td></tr>
<tr><td>Messages you send to support and complaints you file</td><td>To resolve your request.</td></tr>
</table>

<h2>2. Who receives it</h2>
<ul>
<li><b>Riders and drivers on the same trip:</b> a rider sees the driver's first name, photo, rating, vehicle and live location; a driver sees the rider's first name, pickup and destination. Phone calls go through your phone's dialler once a ride is accepted.</li>
<li><b>Service providers</b> that process data for us: Google (Maps, Places, Routes and Firebase Cloud Messaging), Razorpay (payments), Meta (WhatsApp Cloud API: sign-in codes and SOS messages), and our cloud and database hosting provider.</li>
<li><b>People you choose:</b> your emergency contacts receive an SOS message and a live tracking link; anyone you send a share-ride link to can see that ride's status until it ends.</li>
<li><b>Authorities</b> when the law requires it or to protect someone's safety.</li>
</ul>
<p>We do not sell your personal data and do not use it for third-party advertising.</p>

<h2>3. Security</h2>
<p>Data travels over HTTPS. Passwords are hashed, access tokens are short-lived and stored in the device's secure storage, and staff access is limited and logged.</p>

<h2>4. How long we keep it</h2>
<p>We keep your account data while your account is open. When you delete your account (see below) we erase your personal data immediately. Ride, payment, refund, earning and payout records stay without your name or contact details because tax, accounting and safety law requires us to keep transaction records (generally up to 8 years) and the other person on a trip needs theirs. Safety (SOS) incident records are kept for the same reason.</p>

<h2>5. Your choices and rights</h2>
<ul>
<li><b>Edit</b> your name, email, photo, saved places and emergency contacts in the app under Account.</li>
<li><b>Permissions</b> (location, notifications, microphone) can be changed in your phone settings; some features then stop working.</li>
<li><b>Delete your account</b> in the app: Account → Settings → Delete account. If you cannot open the app, use the steps on our <a href="${escapeHtml(ctx.baseUrl + LEGAL_PATHS.deleteAccount)}">account deletion page</a>.</li>
<li><b>Ask</b> for a copy of your data or a correction by contacting us.</li>
</ul>

<h2>6. Children</h2>
<p>The service is for people aged 18 and over. We do not knowingly collect data from children.</p>

<h2>7. Changes</h2>
<p>If we change this policy in a meaningful way we will update the date above and, where required, notify you in the app.</p>

<h2>8. Contact</h2>
<p>${who}. Questions or requests: ${contact(ctx)}.</p>`,
    ctx,
  );
}

export function renderTerms(ctx: LegalContext): string {
  const who = escapeHtml(ctx.entityName);
  return layout(
    "Terms of use",
    `<h1>Terms of use</h1>
<p class="muted">Last updated ${LEGAL_LAST_UPDATED}</p>
<p>These terms govern your use of the Tirvona Rides app provided by ${who}. By creating an account or using the app you agree to them.</p>

<h2>1. The service</h2>
<p>Tirvona Rides connects riders with independent drivers. Drivers are not employees of ${who}. Availability, pickup times and fares shown in the app are estimates until a trip completes.</p>

<h2>2. Your account</h2>
<ul>
<li>You must be 18 or older, give accurate information and keep your password private.</li>
<li>One person, one account. You are responsible for activity on it.</li>
<li>We may suspend or block accounts that break these terms, endanger others or misuse promotions.</li>
</ul>

<h2>3. Riders</h2>
<ul>
<li>Pay the fare shown for your trip, plus any tolls or fees disclosed in the app, by the payment method you choose (online or cash where offered).</li>
<li>Cancelling after a driver is assigned may carry a fee. Any fee is shown before you cancel.</li>
<li>Treat drivers and vehicles with respect. Do not carry anything unlawful.</li>
</ul>

<h2>4. Drivers</h2>
<ul>
<li>Keep a valid licence, registration and insurance, and keep them current in the app. Documents must be genuine.</li>
<li>Follow traffic law and drive safely. Do not use the app while driving.</li>
<li>Commission is deducted from fares at the rate in force when the ride completes, and earnings are paid out as described in the app.</li>
</ul>

<h2>5. Safety</h2>
<p>The SOS button messages your emergency contacts and alerts our team. It does not replace calling emergency services; in an emergency dial 112.</p>

<h2>6. Payments and refunds</h2>
<p>Online payments are processed by Razorpay. Refunds, where due, go back to the original payment method. Disputes can be raised from the ride in the app or by contacting support.</p>

<h2>7. Liability, devices and insurance</h2>
<ul>
<li>${who} is not responsible or liable for any damage or loss, whether personal, financial or of any other kind, during, before or after a ride.</li>
<li>${who} is not responsible or liable for any damage to the hardware or software of the mobile phone or other electronic device you use to book or drive.</li>
<li>All insurance is independently covered by the rider or customer (and by the driver for the vehicle and driving). ${who} does not provide any insurance or damage compensation of any kind.</li>
<li>${who} is also not responsible for the conduct of riders or drivers beyond what the law requires.</li>
</ul>
<p>These limits apply to the extent the law allows. Nothing here limits liability that cannot be limited by law.</p>

<h2>8. Ending your account</h2>
<p>You can delete your account at any time from the app (see our <a href="${escapeHtml(ctx.baseUrl + LEGAL_PATHS.deleteAccount)}">account deletion page</a>). Deleting does not cancel amounts already owed.</p>

<h2>9. Changes and law</h2>
<p>We may update these terms; continued use after an update means you accept it. These terms are governed by the laws of India.</p>

<h2>10. Contact</h2>
<p>${contact(ctx)}</p>`,
    ctx,
  );
}

export function renderDeleteAccount(ctx: LegalContext): string {
  const who = escapeHtml(ctx.entityName);
  return layout(
    "Delete your account",
    `<h1>Delete your Tirvona Rides account</h1>
<p class="muted">Last updated ${LEGAL_LAST_UPDATED}</p>

<h2>In the app (fastest)</h2>
<ol>
<li>Open Tirvona Rides and sign in.</li>
<li>Go to <b>Account → Settings → Delete account</b>.</li>
<li>Enter your password and confirm.</li>
</ol>
<p>Your account is deleted immediately and you are signed out on every device.</p>

<h2>If you cannot use the app</h2>
<p>Email ${contact(ctx)} from the email address on your account, or tell us the mobile number registered to it, with the subject "Delete my Tirvona account". We confirm that the request is yours and delete the account within 30 days.</p>

<h2>What is deleted</h2>
<ul>
<li>Your name, mobile number, email, password, date of birth, gender and profile photo</li>
<li>Saved places, emergency contacts, notifications, push tokens and sign-in sessions</li>
<li>Drivers only: licence details, uploaded documents and vehicle details</li>
</ul>

<h2>What is kept</h2>
<p>Trip, payment, refund, earning and payout records, ratings, support tickets and safety incident records are kept <b>without your name or contact details</b> for up to 8 years, because tax, accounting and safety rules require it and the other person on a trip needs their own record. After that they are removed.</p>

<h2>When deletion is held</h2>
<p>We cannot delete while you have a ride in progress, an unpaid cancellation fee, or (for drivers) earnings that are not yet paid out. The app tells you which one; finish or settle it, or contact support, then delete again.</p>

<p class="muted">Operated by ${who}.</p>`,
    ctx,
  );
}
