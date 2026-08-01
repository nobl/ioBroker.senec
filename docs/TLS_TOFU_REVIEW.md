# TLS trust for the local connector — decision record

**Decision: the current certificate-acceptance behaviour is retained deliberately.** This
document exists so the reasoning is on record and so the behaviour is not mistaken for
something stronger than it is. No code change follows from it.

## What the local connector does

`negotiateLocalTls` (`main.js`) works down a waterfall and records the outcome in
`_local.tls.mode`:

| Mode | Verification |
|------|--------------|
| `user` | Chain validated against the CA the user uploaded, in `_local.tls.userCaPem` |
| `cached` | Chain validated against a CA fetched from mein-senec.de, in `_local.tls.cachedCaPem` |
| `tofu` | No chain validation. `rejectUnauthorized: false`, plus a SHA-256 fingerprint comparison |
| `none` | The device could not be probed at all; no agent is swapped in |

No CA is bundled with the adapter — SENEC distributes `SenecGui-Root` behind a login, so it is
either uploaded by the user or fetched from the portal. `tofu` is the fallback for appliances
neither can validate, which is why it exists at all rather than being a shortcut.

## What TOFU mode is, precisely

It is **continuity monitoring with automatic acceptance after a detected change.**

On first contact the appliance's certificate fingerprint is recorded. On every later poll it is
compared. When it differs, `verifyTofuFingerprint` logs a warning, **stores the new fingerprint
and continues**. The dashboard log proxy (`lib/web.js`) behaves the same way.

It is deliberately **not**:

- **Certificate pinning.** A pin refuses a changed key. This accepts every change and adopts it.
- **Fail-closed identity verification.** Nothing stops on a mismatch.
- **Protection against an active man-in-the-middle on the LAN.** An attacker who can intercept
  the connection is accepted; the only trace is one warning line. Both checks also run on the
  *response*, so by the time the fingerprint is compared the request has already been sent and
  the reply already read.

What it does give: a record that the peer changed, which is useful for diagnosis and visible to
an operator who reads their logs.

## Why this is the right trade-off here

The maintainer's decision, recorded verbatim in substance:

- The appliance is a local machine inside the user's own network.
- Availability and unattended recovery matter more for this connector than strict pinning.
- A legitimate certificate change must not stop polling until someone intervenes by hand.
- There is no reliable notification path that guarantees a user notices an ioBroker log warning
  promptly. Requiring manual acknowledgement could leave the adapter disconnected for weeks.
- The support and availability cost is disproportionate to the comparatively low likelihood of
  an active MITM inside the user's LAN.

Certificate rotation behaviour on firmware updates is not established from evidence in this
repository, which reinforces the decision: a fail-closed design whose breakage frequency is
unknown is not one to adopt on a device users expect to poll unattended for years.

## What remains true, and is not a defect

- TOFU mode connects with `rejectUnauthorized: false`. That is intentional and is why the
  fingerprint comparison exists at all.
- The log proxy holds its fingerprint in a process-local variable, so its "first observation"
  recurs whenever the `web` adapter restarts.
- The proxy's fallback path connects without a fingerprint when the adapter's TLS state has not
  resolved yet.

These follow from the accepted design. They are listed so nobody rediscovers them as findings.

## Guidance for documentation

Describe the fallback as *detecting and recording* a changed certificate, never as preventing
or blocking one. Wording that implies the adapter refuses an untrusted certificate, or that it
stops a LAN attacker, is inaccurate for `tofu` mode — it is accurate only for `user` and
`cached` mode, where the chain really is validated.

## Status

Reviewed; current behaviour intentionally retained. No production change.
