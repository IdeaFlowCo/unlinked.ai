# Browser navigation latency

The canonical standalone runtime collects first-party browser timings by default.
`UNLINKED_BROWSER_PERFORMANCE=off` disables the collector and page script on the
next runtime start. This does not enable agent request diagnostics or change
nginx/Docker logging. Existing iOS analytics exclusion remains in force.

Measurements distinguish:

- `content_ready`: DOMContentLoaded plus two animation frames. For a same-tab
  internal link or form, timing starts at its click/submit, including server wait.
  Otherwise it starts at navigation. This is a paint opportunity after the DOM
  exists, not a claim that every asynchronous widget is ready, or an LCP/INP metric.
- `page_load`: the native load event, including the document's dependent resources.
- `filter` / `connections_filter`: enhanced People/profile-connection request to
  replaced content plus two animation frames; failed and superseded requests are
  recorded as error/cancelled. The latest click/input timestamp is retained briefly so input debounce is included.
- `bfcache`: Back/Forward cache restoration to a paint opportunity, kept separate
  from network navigation. Other Back/Forward navigations use start=history.

TTFB and time after responseEnd help distinguish server/network delay from browser
rendering. Redirects within the same route family retain the original click time;
other-family redirects fall back to navigation timing. Only route family, metric,
start type, outcome, bounded durations, server receipt time and server release
version persist. A tab-local timestamp/route-family pair bridges page navigation,
expires after two minutes and is removed when consumed. No full URL, query,
profile/list ID, name, account, email, cookie or IP enters the records.

The same-origin JSON receiver `/api/browser-performance` has a 2 KiB body bound
and an independent 600 requests/minute cap. The recorder accepts at most 300
measurements/minute; client pages emit at most 120. These are client-reported
measurements, not trusted security/audit events. Collection cannot block a user
transition. Hidden tabs, blocked/lost beacons, external/new-tab links and browser
error pages without our script are not measured. Durations above 120 seconds are
capped and explicitly counted; corresponding percentiles are lower bounds.

The private bounded store is `audit/browser-performance/`: mode-700 directory,
mode-600 files, seven-day retention, 8 MiB/day and at most 128 queued writes.
Rate/sink drops are reported on the next retained record, so absent records or
zero reported drops do not establish complete coverage. Restart never means
historical observations exist; report first/last receipt times.

From the existing production runtime operator context:

```sh
node scripts/read-browser-performance.mjs \
  --directory /srv/unlinked-private-guest-pilot-20261001/audit/browser-performance \
  --since 2026-11-06T00:00:00Z
```

This reads all bounded retained files and reports per-release/page-type/metric/
start-kind counts, success p50/p95/p99/max, over-two-second counts, TTFB/render p95,
errors, cancellations, capped durations and observed time coverage. HTTP error pages and typed People fallback states (including HTTP 200) count as errors. Failed enhanced searches preserve the previous result set and offer a native retry. Failures are
not mixed into successful-load percentiles. No public diagnostics endpoint exists.
The script validates ownership, permissions, symlinks, hard links and file bounds.
