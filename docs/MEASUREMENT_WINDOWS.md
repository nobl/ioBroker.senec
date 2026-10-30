# Cloud measurement windows — measured behaviour

This records how the SENEC cloud measurements endpoint
(`senec-app-measurements-proxy…/v1/systems/{id}/measurements`) treats the `from`/`to` window for
different `resolution` values. The adapter's request windows and storage logic depend on this,
and it cannot be derived from the endpoint's documentation — there isn't any.

**Measured on:** adapter debug log, 2026-10-29, against a live account whose plant and
js-controller host both run Europe/Berlin — see the caveat below.

## MONTH is anchored to the plant's local calendar month

A request for `resolution=MONTH&from=2025-12-31T23:00:00.000Z` (local midnight on 1 January,
CET being UTC+1) returns a single bucket dated `2025-12-31T23:00:00Z` with
`durationInSeconds:2678400`.

The bucket date alone is ambiguous — it equals the requested `from` either way — but the duration
is not. 2678400 s is exactly 31 days, local midnight to local midnight: a whole calendar January.
Had the endpoint instead anchored the bucket to the UTC month and merely clipped it to the
request's start, the same request would have ended at the next UTC month boundary
(2026-02-01T00:00:00Z) and measured 2682000 s. The observed duration rules that out: the endpoint
bucketed by the calendar month containing `from`, in local time.

That local time is the **plant's**, not necessarily the requester's. SENEC has no way to know
what timezone the caller runs in; it buckets by where the system is installed. On the system
these logs came from, plant and js-controller host are both Europe/Berlin, so the two happen to
agree — which is the only reason the observed values line up, and exactly why this is easy to
miss on other installations.

## YEAR performs no anchoring

A request for `resolution=YEAR&from=2026-01-01T00:00:00.000Z` (UTC year start) returns one bucket
dated `2026-01-01T00:00:00Z` with `durationInSeconds:26082591`. The same request with
`from=2025-12-31T23:00:00.000Z` (local midnight) returns a bucket dated `2025-12-31T23:00:00Z`
with `durationInSeconds:26078613`. Both durations run exactly from the request's `from` to its
`to` (a few hundred milliseconds of request jitter aside) — about 302 days, nowhere near a full
year. `resolution=YEAR` snaps to no calendar boundary at all; it aggregates whatever `from..to`
is sent and dates the single bucket at `from`.

## Consequences

- A request window built from local calendar dates is correct for every resolution — MONTH needs
  it to land on the right month, and YEAR has no boundary of its own to get wrong.
- Where a response is stored must be decided by the **requested** period, never by the returned
  bucket's date. Deriving storage from the payload is what once filed a whole year under the
  neighbouring year.
- The adapter builds request windows, and reads bucket dates back, in the **js-controller host's**
  timezone — nothing in the adapter reads a plant timezone. This agrees with the plant only when
  the host happens to be configured to the plant's zone, and nothing verifies or enforces that.
  A host whose zone differs from the plant's will bucket measurements wrongly. This is a known
  limitation.
- A plant-side offset is available on installations running the local connector: the appliance
  publishes `RTC.UTC_OFFSET` (`lib/state_attr.js:576`). This is noted as a source that exists and
  is currently unused by the measurement windows — not as something the adapter already applies.

## Unmeasured: the local interface

The appliance's own local interface (`lala.cgi`) is reported by the maintainer to use UTC in
places. That is a different surface from the cloud measurements endpoint described above, and
`lib/local-client.js` was checked and contains no date arithmetic and no reference to the
measurement subtrees at all — so that surface is genuinely independent of these windows. The
UTC behaviour itself is carried here unmeasured, so it is not mistaken for a finding.
