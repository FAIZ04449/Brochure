# Trackable PDF Outreach Link Sender

A self-hosted, lightweight web application built with **Python (Flask)** and **SQLite** that lets you send trackable links to cold outreach prospects instead of raw PDF attachments. 

The tracking link loads a premium in-browser viewer that renders the original PDF byte-for-byte client-side using **Mozilla's PDF.js** (retaining design layout and hyperlinks, with no content alteration) while silently tracking opens, page durations, hyperlink clicks, and session heartbeats.

---

## Key Features

1. **Pixel-Perfect Viewer**: Renders PDFs client-side onto HTML5 `<canvas>` elements. Intercepts and parses PDF link annotations to trace click events.
2. **Active Time Telemetry**: Tracks actual focus/reading time per page. Pauses when the user is idle (>30 seconds) or tabs are blurred/hidden.
3. **Robust Beacon Ingestion**: Utilizes `navigator.sendBeacon` to reliably sync viewing times and clicks on page turns, tab switches, and window closures.
4. **Admin Dashboard**: Beautiful dark-themed interface built with vanilla JS and CSS variables:
   - **Metrics Overview**: Aggregate KPIs like total views, avg active reading durations, CTR.
   - **Link Generator**: Single and bulk CSV generators for outreach campaigns (Instantly, Lemlist, HubSpot).
   - **Access Logs**: Status boards (Active, Expired, Revoked, Never Opened) and action lists.
   - **Engagement Profiler**: Detailed per-recipient timelines, Chart.js page bar charts, and automated engagement scores.
5. **Rate Limiter & Expiration**: In-memory rate limiting against tracking API abuse, link expiration options, and manual revokes.

---

## Prerequisites

- **Python 3.8+**
- A sample PDF file (e.g. `pibit Brochure.pdf`) in the project root directory.

---

## Quick Start (Local Run)

### 1. Install Dependencies
Run from the workspace directory:
```bash
pip install -r requirements.txt
```
*(Only Flask is required; standard Python libraries are used for database operations, UUID tokens, and IP geolocation queries.)*

### 2. Run Database Seeding
Ensure your brochure `pibit Brochure.pdf` is in the root directory. Then execute the seed script:
```bash
python seed.py
```
This script will:
- Initialize the SQLite database schema (`analytics.db`).
- Copy the brochure into the `storage/` directory securely.
- Generate 3 test recipients (John Doe, Jane Smith, Bob Miller) and print their trackable links.

### 3. Start the Web Server
Launch Flask in debug mode:
```bash
python app.py
```
The server will boot on `http://localhost:5000`.

- **Admin Dashboard**: Open `http://localhost:5000/dashboard` (Default Password: `admin`).
- **Outreach Links**: Try opening one of the generated links from the seed output (e.g., `http://localhost:5000/v/<token>`).

---

## Configuration & Environment Variables

You can customize runtime behavior by declaring environment variables in your server setup or placing them in a `.env` file:

- `ADMIN_PASSWORD` (Default: `admin`): Sets the password required to access the admin dashboard.
- `SECRET_KEY` (Default: a fallback secret string): Sets Flask's session signing token. Change this in production to prevent cookie tampering.

---

## Production Deployment

### 1. Data Persistence
Ensure that both of the following files/directories are persistent across server restarts/deploys:
- `analytics.db`: The SQLite database file.
- `/storage/`: The folder containing original brochure PDF files.

*If deploying to containerized systems like Docker, Fly.io, or Render, mount a persistent volume mapping these locations.*

### 2. Free IP Geolocation
The app resolves location (city/country) from IP addresses via public JSON API queries to `ip-api.com` or `ipapi.co`. If deployed behind a reverse proxy (like Nginx, Cloudflare, or Fly.io), ensure standard headers like `X-Forwarded-For` are configured, so the correct client IP is evaluated instead of the proxy host.

### 3. HTTPS / SSL
`navigator.sendBeacon` and tracking sessions require secure contexts (HTTPS) in most modern browsers to fire beacons reliably during page unloading. Ensure SSL is enabled.
