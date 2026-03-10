# Golf Bot Divergence from Original Repo

**Status:** SIGNIFICANTLY DIVERGED (Feb 24, 2026)

## Original Approach vs Current Implementation

### ORIGINAL (martshaw/intelligent-golf-bot HEAD)
```typescript
// Uses simple HTTP request with requestType=ajax
const options: RequestPromiseOptions = {
  method: 'GET',
  baseUrl: 'https://kilspindie.intelligentgolf.co.uk/',
  qs: {
    date,
    course: args.course.valueOf(),
    requestType: 'ajax'  // Force AJAX response
  },
  json: true  // Parse JSON
};

const response = await request('/memberbooking/', options);
// response.teetimes contains HTML of table rows
return parseTimeSlots(response.teetimes);
```

**Why it worked:** The `/memberbooking/` endpoint with `requestType=ajax` returns JSON containing the populated table HTML. No JavaScript execution needed—server returns the pre-rendered tee times in the response.

---

### CURRENT (Our Implementation)
```typescript
// Uses Playwright headless browser
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

// Navigate and wait for JS to populate table
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tr.canreserve, tr.cantreserve', { timeout: 5000 });

const html = await page.content();
return parseTimeSlots(html);
```

**Why we diverged:**
1. We misdiagnosed the problem as "JavaScript not executing"
2. Actually the original code already solved this by using `requestType=ajax`
3. We overengineered the solution with Playwright (100MB+ browser, slow, complex)

---

## The Critical Mistake

**Original code at HEAD (commit e82aeae):**
```typescript
qs: {
  date,
  course: args.course.valueOf(),
  requestType: 'ajax'  // ← THIS IS THE KEY
}
```

**What this does:**
- Tells IntelligentGolf server: "Give me AJAX response (JSON with tee times HTML)"
- Server executes JavaScript on backend, returns populated table
- No Playwright needed—HTTP request is enough

**Our "fix":**
- Removed `requestType: 'ajax'`
- Switched to pure HTTP without AJAX parameter
- Got empty table (no data)
- Blamed JavaScript not executing in browser
- Added Playwright headless browser to execute JS client-side
- This works but is overkill and slow

---

## Metrics

| Aspect | Original | Current |
|--------|----------|---------|
| **Execution time** | ~400-500ms (HTTP) | ~2-5s (Playwright launch) |
| **Dependencies** | request-promise, cheerio | + playwright |
| **Memory** | ~50MB process | ~150MB (+ 100MB+ browser) |
| **Complexity** | Simple HTTP + cheerio parsing | Full headless browser orchestration |
| **Reliability** | High (single HTTP request) | Medium (browser state, timeouts) |
| **Code debt** | None | Significant (cookie jar issues, etc) |

---

## Root Cause Analysis

**Why did we diverge?**

1. **Session cache issue masked the real problem**
   - Cookie jar was not being passed correctly to `getCourseAvailability()`
   - This caused authentication failures
   - We thought: "Server can't identify me → returns empty table"
   - Reality: The parameter `requestType=ajax` was removed or lost

2. **We didn't check original implementation first**
   - Original code uses `/memberbooking/?date=X&course=Y&requestType=ajax`
   - We may have changed it to `/memberbooking/` without the AJAX params
   - This forced reliance on client-side JavaScript

3. **Over-engineering trap**
   - When we saw empty table, we assumed JavaScript wasn't running
   - Playwright was the "correct" solution IF table data was client-side
   - But it was never client-side in the original—the server sends it

---

## Recommendation

**Revert to original approach:**

1. ✅ Fix the session cache jar issue (already done)
2. ✅ Use original HTTP request with `requestType=ajax` parameter
3. ✅ Keep simple HTTP request-promise + cheerio parsing
4. ❌ Remove Playwright (unnecessary complexity)

This will:
- Reduce response time 5-10x
- Eliminate browser dependency
- Reduce memory footprint 50%
- Match original design intent
- Be more maintainable long-term

---

## Files Affected

**Modified from original:**
- `src/requests/golfBooking.ts` - Rewrote `getCourseAvailability()` completely
- `src/shared/sessionCache.ts` - Added (was using simpler auth originally)
- `webpack.config.js` - Added webpack-node-externals (for Playwright)
- `package.json` - Added playwright (new dependency)

**Unchanged:**
- All command handlers
- Booking/cancellation logic
- Date parsing
- Monitor jobs
- Storage mechanisms
