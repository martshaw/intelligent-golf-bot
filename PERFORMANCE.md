# Performance and bottlenecks

Recommendations to speed up the bot and reduce perceived latency.

## Implemented

- **Faster failure**: Session/login timeout reduced from 15s to 10s so slow or down club sites fail faster.
- **Immediate feedback**: `/availabletimes` and `/bookings` send a short “Checking…” / “Fetching…” message first so the user sees a response immediately while the club API is called.
- **Bookings in one message**: `/bookings` now returns a single message with all bookings and one Delete button per booking instead of 1 + N messages and N Telegram API calls.
- **Logins load**: First read uses a single `readFile` and handles missing file with ENOENT; no separate `fs.access` call.
- **Logins preload**: `preloadLogins()` runs at startup so the first user command does not trigger a disk read for `logins.json`.

## Session and network (main bottlenecks)

- **Session cache**: Already reuses the same cookie-jar request for 30 minutes per user. The only way to go faster after a cold session is to make the club site respond faster (we can’t change that) or fail faster (we did: 10s timeout).
- **Login**: One POST per cache miss. No way to avoid it; we already reuse the session.
- **Club API**: All slowness after “Checking…” is from the Intelligent Golf server. Consider measuring with the “Fetched in Xms” you already show and, if needed, raising the issue with the club or Intelligent Golf.

## Optional improvements (if you need more speed)

1. **Connection reuse / keepalive**
   `request` / `request-promise` do not reuse TCP connections by default. Switching to `axios` or `undici` with keepAlive would reuse connections to the club domain and can shave 100–300 ms per request after the first. Requires refactoring the request layer.

2. **Bookings: fewer detail requests**
   `/bookings` does 1 request for the list + N requests for `getBookingDetails` (one per booking). If the list HTML ever contained enough for a short summary (e.g. date, time, course name), you could show that first and optionally fetch details on demand or in the background. Right now the UI needs details, so this would need a small UX change.

3. **Less logging in hot paths**
   `console.log` in session cache and storage runs on every command. For production, use a logger that can be disabled or reduced (e.g. only in development) to avoid extra I/O.

4. **Chrono date parsing**
   `chrono-node` for “tomorrow” / “next Friday” is already fast. Only consider replacing if profiling shows it as a measurable cost.

5. **Scheduled monitors**
   `scheduledAutoBookingsMonitor` and `scheduledRecurringBookingsMonitor` run on their own schedule and don’t block user commands. No change needed unless you see CPU or memory spikes when they run.

## Measuring

- **availabletimes**: You already report “Fetched in Xms” so users see backend time.
- **bookings**: Duration is shown in the header (e.g. “— 1234ms”).
- To see where time is spent in code, add a simple timer around `getOrCreateSession`, `getCourseAvailability`, and `getBookings`/`getBookingDetails` and log or expose via a `/debug` command.
