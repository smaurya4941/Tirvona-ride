import type { SharedRideView } from "./share-ride-view";

/**
 * The read-only page a share link opens. Rendered on the server from the
 * same sanitized view as the JSON endpoint, with no JavaScript (it passes
 * the API's strict Content-Security-Policy): while the ride is live the
 * browser simply reloads it every 20 seconds.
 */

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const mapsLink = (latitude: number, longitude: number): string =>
  `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`;

const time = (value: Date | undefined, timeZone: string): string =>
  value
    ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone }).format(value)
    : "";

const STYLE = `
  :root { color-scheme: light; --ink:#1B2A4A; --muted:#5B6475; --accent:#F28C28; --ok:#15803D; --bg:#FBF7F0; --card:#FFFFFF; --line:#E7DFD3; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width: 480px; margin: 0 auto; padding: 20px 16px 32px; }
  header { display:flex; align-items:center; gap:10px; margin-bottom:16px; }
  .brand { font-weight:800; font-size:18px; }
  .brand span { color: var(--accent); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:12px; }
  .status { font-size:22px; font-weight:800; margin:0 0 4px; }
  .live { display:inline-block; font-size:12px; font-weight:700; color:var(--ok); background:#DCFCE7; border-radius:999px; padding:2px 10px; margin-bottom:8px; }
  .ended { color:var(--muted); background:#EEF0F3; }
  .muted { color:var(--muted); font-size:14px; margin:0; }
  .label { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 2px; }
  .value { margin:0 0 12px; font-weight:600; }
  .plate { display:inline-block; font-weight:800; letter-spacing:1px; border:1px solid var(--line); background:#FFF8EE; border-radius:6px; padding:2px 8px; }
  a.button { display:block; text-align:center; text-decoration:none; background:var(--ink); color:#fff; font-weight:700; border-radius:12px; padding:12px; margin-top:8px; }
  a.link { color:var(--ink); font-weight:600; }
  footer { text-align:center; color:var(--muted); font-size:12px; margin-top:20px; }
`;

function layout(title: string, body: string, refreshSeconds?: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${escapeHtml(title)} · Tirvona Rides</title>
<style>${STYLE}</style>
</head>
<body><main>
<header><div class="brand">Tirvona <span>Rides</span></div></header>
${body}
<footer>Read-only ride status shared by a Tirvona rider. This link stops working shortly after the ride ends.</footer>
</main></body>
</html>`;
}

export function renderSharedRidePage(view: SharedRideView, timeZone: string): string {
  const driver = view.driver
    ? `<p class="label">Driver</p><p class="value">${escapeHtml(view.driver.firstName)}${
        view.driver.ratingAverage ? ` · ★ ${view.driver.ratingAverage.toFixed(1)}` : ""
      }</p>`
    : "";
  const vehicle = view.vehicle
    ? `<p class="label">Vehicle</p><p class="value">${escapeHtml(view.vehicle.type)} · <span class="plate">${escapeHtml(
        view.vehicle.registrationNumber,
      )}</span>${view.vehicle.description ? `<br><span class="muted">${escapeHtml(view.vehicle.description)}</span>` : ""}</p>`
    : "";
  const location = view.driverLocation
    ? `<a class="button" href="${escapeHtml(mapsLink(view.driverLocation.latitude, view.driverLocation.longitude))}" rel="noopener noreferrer" target="_blank">See vehicle on map</a>
       <p class="muted" style="text-align:center;margin-top:6px">Position at ${escapeHtml(time(view.driverLocation.updatedAt, timeZone))}</p>`
    : "";
  const body = `
<section class="card">
  <span class="live ${view.isLive ? "" : "ended"}">${view.isLive ? "● LIVE" : "ENDED"}</span>
  <h1 class="status">${escapeHtml(view.statusLabel)}</h1>
  <p class="muted">${escapeHtml(view.statusMessage)}</p>
  ${location}
</section>
<section class="card">
  ${driver}
  ${vehicle}
  <p class="label">Pickup</p>
  <p class="value"><a class="link" href="${escapeHtml(mapsLink(view.pickup.latitude, view.pickup.longitude))}" rel="noopener noreferrer" target="_blank">${escapeHtml(view.pickup.address)}</a></p>
  <p class="label">Destination</p>
  <p class="value" style="margin-bottom:0"><a class="link" href="${escapeHtml(mapsLink(view.destination.latitude, view.destination.longitude))}" rel="noopener noreferrer" target="_blank">${escapeHtml(view.destination.address)}</a></p>
</section>
<p class="muted" style="text-align:center">Last updated ${escapeHtml(time(view.lastUpdatedAt, timeZone))}${
    view.isLive ? " · refreshes automatically" : ""
  }</p>`;
  return layout(view.statusLabel, body, view.isLive ? 20 : undefined);
}

export function renderShareErrorPage(expired: boolean): string {
  const title = expired ? "This ride link has expired" : "Ride link not found";
  const message = expired
    ? "The ride has ended, so its live status is no longer shared."
    : "Check that you opened the full link, or ask the rider to share it again.";
  return layout(title, `<section class="card"><h1 class="status">${title}</h1><p class="muted">${message}</p></section>`);
}
