# The local OpenAPI on port 4424 — findings record

The appliance serves a second local HTTPS interface, on **TCP port 4424**, independent of
`lala.cgi` on 443. The adapter now reads it, through a **read-only connector**
(`lib/openapi-client.js`), and this document is the measured basis for that connector: it
records what the interface offers and what it refuses, so the question does not have to be
re-investigated from scratch, and so nobody builds a control feature on an assumption it cannot
carry. The constraints the connector obeys are collected at the end, each one traced back to a
measurement above it.

**Measured on:** SENEC.Home V3 hybrid LFP, 2026-10-25, with a token registered and approved
for this test. Every result below was observed against that appliance unless marked
otherwise.

## What it is

A small HTTP/2 service answering REST-style GETs. Responses are JSON; errors are
`text/plain`. The 404 and 405 bodies are `404 page not found` and `Method Not Allowed`,
which are Go's `net/http` defaults, so it is a Go binary distinct from the CGI behind
`lala.cgi`.

Authentication is a token in an **`X-Auth-Token`** header. A client obtains one by posting
its own name to the appliance and then having that registration **approved by the account
holder in the portal** — the approval page is not linked from the portal's navigation and is
reached by URL:

```
https://mein-senec.de/endkunde/#/{plant number}/senec-open-api
```

The plant number is the same index the mein-senec.de connector uses, so an account holding
more than one system (after an MCU replacement, for instance) needs `#/1/` rather than
`#/0/`.

The interface is not new and not ours to discover: it is documented publicly only as a
pairing step in a third-party heating-element manual
([ASKOMA, 26.10.2023](https://faq.askoma.com/index_html_files/SENEC_V2_V3.pdf)), which gives
firmware 4.4.0 as the minimum and describes the same register-then-approve flow. That
manual is a pairing guide, not an API specification; no schema for the interface has been
published by SENEC.

## Route inventory

Probed without a token. A route that exists answers `401 Incorrect token`; anything
unrouted answers `404`. This distinguishes the two cleanly, so the list is complete for the
names tried.

| Route | No token | Approved token | Content |
|-------|----------|----------------|---------|
| `/v1/battery` | 401 | **200** | `state`, `stateOfCharge`, `power`, `voltage`, `current` |
| `/v1/meter` | 401 | **200** | `gridPower`, `consumption`, `production`, `powerSurplus`, `fullRangePowerSurplus` |
| `/v1/bess` | 401 | **200** | `apparentPower`, `activePower`, `reactivePower`, `voltage`, `current`, `acRelayConnected` |
| `/v1/bess/nameplate` | 401 | **200** | `manufacturer`, `model`, `serialNumber`, `designCapacity`, `ratedPower` |
| `/v1/evse` | 401 | **200** | `devices[]` with `id`, `evConnected`, `evCharging`, `limitationStatus`, `chargingPower` |
| `/v1/battery/limits` | 401 | **403** | never returned anything — see below |
| `/v1/bess/setpoint` | 401 | **403** | never returned anything — see below |
| `/v1/register` | 405 for GET, 400 for POST | — | registration, POST-only, validates its body |

Registration answers `202 Accepted` with a bare UUID as the body — that string is the token.
It is inert until approved, and the whole exchange is `text/plain`.

### The appliance cannot be asked about a registration — the portal can

Nothing **on the appliance** enumerates registrations, pending or approved. Every plausible
name answers 404: `/v1/devices`, `/v1/registrations`, `/v1/clients`, `/v1/register/status`,
`/v1/tokens`, `/v1/me`, `/v1/auth`, `/v1/device`. The only observable from the appliance is
the ladder below, on a token one already holds.

**The portal does enumerate them**, through the endpoint behind the approval page, reachable
with an ordinary customer session:

```
GET https://mein-senec.de/endkunde/api/senec-open-api/tokens?anlageNummer={plant}

[{"tokenValue":"<uuid>","tokenState":"PENDING",
  "deviceName":"ioBroker","deviceVendorName":"ioBroker.Senec",
  "creationDate":1792931031229}]
```

Two things matter. The listing carries **`tokenValue` itself**, so a client holding a token
can identify its own entry exactly rather than inferring it from the device name — which is
what would make it safe to act on one entry among several. And `tokenState` is one of
`PENDING`, `GRANTED`, `REVOKED`, `DENIED` or `UNKNOWN`, a finer picture than the appliance
gives.

Acting on an entry is one request per action, with the token in the query string rather than
a body:

```
POST .../endkunde/api/senec-open-api/tokens/revoke?anlageNummer={plant}&token={tokenValue}
POST .../endkunde/api/senec-open-api/tokens/grant?anlageNummer={plant}&token={tokenValue}
```

`revoke` was observed as a POST. `grant` was observed only as a URL; POST is inferred from
the identical shape and the same controller. The page's third action is `reject`, presumably
the same again, unobserved.

The plant number is part of the call, not merely of the page URL — so a client acting on this
has to know which plant holds the appliance, not just that it has one.

**Revocation reaches the appliance within about a minute, but not instantly.** Measured: a
token revoked in the portal still answered `200` locally on the first check immediately
afterwards, and flipped to `401 Incorrect token` roughly half a minute later. So the
withdrawal travels through the cloud to the appliance rather than being enforced locally at
once.

**Not measured: how long a grant takes to reach the appliance.** The half-minute above is the
only propagation timing on record and it was measured for revocation — approval propagation was
never timed separately, so a figure for it is an inference from this one, not a measurement.

The practical consequence for a client: do not treat "still 200 right after revoking" as a
failed revocation, and do not retry the revoke on that basis. Give it a minute, then check.

Note also that the navigation model reports `senecOpenApiVisible: false` for a plant whose
appliance serves the interface perfectly well — the menu entry is suppressed, which is why
the page is reachable only by URL.

Two consequences for anything built on this, both of which the adapter's connector obeys:

- **Registering twice is irreversible confusion.** Each `POST /v1/register` mints another
  pending entry in the portal, entries are identified by the device name the client chose, and
  nothing can list or distinguish them afterwards. So registration must happen only when no
  token is stored, only one registration at a time across every path that can start one, and
  discarding a stored token has to be a deliberate separate step. The portal's own
  `tokens/revoke` makes that step tidy where an account session is available — the connector
  withdraws the entry it is discarding — but a client that cannot reach the portal must say so
  and leave the entry to the user, and must not register again on top of an entry it could not
  confirm was gone.
- **A revoked token is indistinguishable from a wrong one.** After the account holder revokes
  a registration in the portal, its token answers `401 Incorrect token`, exactly as an
  unknown token does. There is no "was valid, now withdrawn" signal, so a client cannot
  safely treat 401 as "re-register" on its own — it must stop and say so, or it will mint a
  new portal entry on every poll.

### What the data actually looks like

Observed on the appliance above with an approved token, so these are real shapes rather than
inferred ones:

```jsonc
// /v1/battery
{"state":1,"stateOfCharge":47,"power":-850.8078,"voltage":52.2,"current":-16.299}

// /v1/meter
{"gridPower":91,"consumption":1181,"production":244,"powerSurplus":0,"fullRangePowerSurplus":0}

// /v1/bess — activePower and reactivePower are null, not zero
{"apparentPower":-237,"activePower":null,"reactivePower":null,
 "voltage":79,"current":-3,"acRelayConnected":true}

// /v1/bess/nameplate — ratedPower is populated here
{"manufacturer":"SENEC GmbH","model":"SENEC.Home V3 hybrid LFP",
 "serialNumber":"S<device id>","designCapacity":5000,
 "ratedPower":{"activeChargePower":2500,"activeDischargePower":4600,
               "reactiveChargePower":1500,"reactiveDischargePower":2760}}

// /v1/evse — four slots are always reported, whether or not a wallbox exists
{"devices":[{"id":1,"evConnected":false,"evCharging":false,"limitationStatus":0,"chargingPower":0},
            {"id":2, …},{"id":3, …},{"id":4, …}]}
```

Points worth knowing before trusting any of it:

- **`/v1/bess` is partly unimplemented.** `activePower` and `reactivePower` come back `null`,
  not `0`, so any consumer has to handle nulls. `apparentPower`, `voltage` and `current` do
  carry values, but `voltage: 79` against the battery's own `52.2` suggests they describe a
  different measurement point than `/v1/battery` does.
- **`/v1/evse` always reports four slots.** All four appear with `evConnected: false` on an
  appliance with no wallbox at all, so the array length says nothing about how many wallboxes
  exist. Presence has to be inferred from the values, not the count.
- **`nameplate.serialNumber` equals the CN of the TLS certificate** on 4424 (see below), and
  equals `FACTORY.DEVICE_ID` from `lala.cgi` with `st_` replaced by `S`. Three independent
  spellings of the same identifier.
- **`ratedPower` is populated on this appliance** — charge 2500 W, discharge 4600 W — where
  it has been reported elsewhere as all zeros. So it is sometimes meaningful and sometimes
  not; treat zeros as "not reported" rather than "cannot charge".
- `designCapacity` is in **watt-hours**, and per the SENEC.Connect schema for the same field
  it is meant to include sibling units — so `5000` reads as 5 kWh for the whole pack. Whether
  the local listener honours the "includes siblings" part is unverified.
- **`state` must not be mapped through the SENEC.Connect enum.** That API documents the
  battery `state` field as `0 = OK, 1 = error`. This appliance reports `state: 1` while
  discharging normally at 850 W with a healthy SoC, and a second, unrelated V3 has been
  observed reporting `1` as well. Two healthy systems both reporting the "error" value means
  the local field almost certainly carries different semantics — most likely something like
  "running" — and its enum is unknown. Do not translate it until it is decoded.

Everything else tried answered 404: `/`, `/v1`, `/openapi.json`, `/v1/openapi.json`,
`/swagger.json`, `/v3/api-docs`, `/v1/system`, `/v1/wallbox`, `/v1/inverter`, `/v1/pv`,
`/v1/grid`, `/v1/devices`, `/v1/status`, `/v1/info`, `/v1/peakshaving`, `/v1/sgready`.
There is no discovery or schema endpoint.

## The two privileged routes

`/v1/battery/limits` and `/v1/bess/setpoint` are the two that matter, because a battery
charge/discharge setpoint is what a discharge block would need. They are gated, and the
method routing shows the gate is structural rather than incidental:

| Route | GET | POST | PUT | PATCH | DELETE | OPTIONS |
|-------|-----|------|-----|-------|--------|---------|
| `/v1/battery` | 401 | **405** | **405** | **405** | **405** | **405** |
| `/v1/battery/limits` | 401 | 401 | 401 | 401 | 401 | 401 |
| `/v1/bess/setpoint` | 401 | 401 | 401 | 401 | 401 | 401 |

On an ordinary data route the router matches the method first, so an unrouted verb gets a
405 before authentication is ever consulted. On these two, **every** verb answers 401 —
authentication runs ahead of method dispatch. They sit behind separate middleware, which
means the set of methods they accept cannot be read off from outside and that the
distinction between them and the data routes is deliberate.

An arbitrary token answers `401 Incorrect token`, identical to no token at all, so the
interface leaks nothing about which tokens exist.

A token issued by `/v1/register` but **not yet approved in the portal** separates the two
route classes further:

| Route | No token | Registered, pending | Approved | Revoked |
|-------|----------|---------------------|----------|---------|
| `/v1/battery` | `401 Incorrect token` | `511 Token activation pending` | `200` + data | `401 Incorrect token` |
| `/v1/bess/setpoint` | `401 Incorrect token` | **`403 Forbidden`** | **`403 Forbidden`** | `401 Incorrect token` |

The data route moves through all three states honestly: unrecognised, recognised but waiting
for the account holder, then serving. The privileged routes answer `403` from the moment a
parseable token is presented and **keep answering `403` after approval** — on `GET`, `HEAD`
and `OPTIONS` alike. Approval changes nothing for them.

So `403` here is not "authenticated but lacking a privilege" that approval might grant: the
answer is identical before and after approval, and it is returned without the activation
state ever being consulted. Combined with the method-routing result above, the reading is
that a portal-registered client is simply not a principal these two routes accept. There is
no indication that any approval an end customer can give would change that.

Writes were deliberately not attempted. A `POST` or `PUT` that unexpectedly succeeded would
command a real battery setpoint on a live appliance, and the three safe verbs already
establish the refusal. If anyone does test a write, do it knowing that.

Corroborating evidence that the mechanism behind them is real and active in V3 firmware: the
appliance's own log carries lines of the form

```
[I|External Charge Control] OpenApi: Set target power to <n>W charging
```

So the firmware has an *External Charge Control* path that takes a signed target power and
is driven over this interface. The power values in those lines are frequently nonsense when
read as decimals but resolve as 32-bit words to unrelated internal data — the NPU image
version, the appliance's own IPv4 address — so that log field is corrupted in transit and
its values must not be trusted as measurements.

## It is the device-side twin of SENEC.Connect

This is the most useful thing to know about the interface, and it explains both its shape and
its limits. SENEC.Connect's published schema returns exactly the four objects this listener
serves — `battery`, `bessNameplate`, `meter`, `evse` — under one path with an `include=`
filter, where the local listener splits them across separate paths. The same data model, in
two deployments: one in Azure API Management behind a subscription key, one on the appliance
behind a portal-approved token.

| | SENEC.Connect | Local 4424 |
|---|---|---|
| Path | one, `/v1/systems/device-data/general?include=…` | one per object |
| Naming | `snake_case` | `camelCase` |
| Auth | `Ocp-Apim-Subscription-Key` header | `X-Auth-Token` header |
| `battery` | `state`, `state_of_charge`, `power`, `voltage`, `current` | identical set |
| `meter` | `grid_power`, `consumption`, `production` | **plus** `powerSurplus`, `fullRangePowerSurplus` |
| `bessNameplate` | flat `active_charge_power`, `active_discharge_power` | nested `ratedPower`, **plus** reactive charge/discharge |
| `evse[]` | `id` is a string (`"WB-01"`), no limitation field | `id` is an int (four fixed slots), **plus** `limitationStatus` |
| `/v1/bess` | no counterpart | present, partly null |
| Writes | **none — the schema has one path and no write operation** | `403` |

Two conclusions follow.

**The local listener is a superset on data.** The extra `meter` surplus fields are what a
surplus-consuming appliance needs, which fits its documented role as the pairing interface
for a heating element. `limitationStatus` and the reactive power ratings have no cloud
counterpart at all.

**There is no customer-facing write capability anywhere in SENEC's API surface.** The
Connect schema defines a single `GET` and nothing else — no setpoint, no limits, no control
of any kind. The local listener has routes for exactly those things and answers `403` to an
approved token. So `/v1/battery/limits` and `/v1/bess/setpoint` are not a gated corner of the
customer product; they have no place in the customer product. That is consistent with the
`External Charge Control` log line: the mechanism exists for SENEC, or for a partner holding
a different kind of credential, and the published surface does not reach it.

A useful side effect of the comparison: the SENEC.Connect schema is the better reference for
**units and semantics** of the shared fields, since the local listener ships no schema at
all. It is where `charging_power` is specified in **VA** rather than watts, `design_capacity`
in **Wh including siblings**, and `consumption` as the house total **excluding wallbox load**.

## TLS

The 4424 listener has **its own certificate and its own issuer**, unrelated to the chain the
local connector negotiates against on 443:

| | Subject | Issuer | Validity |
|---|---------|--------|----------|
| 4424 | `C=DE, ST=Sachsen, L=Leipzig, O=Senec GmbH, CN=S<device id>` | `CN=openapi` | 2025-11-21 → 2035-11-22 |
| 443 | `C=DE, ST=Saxony, L=Leipzig, O=SENEC GmbH, CN=senecGuiSelf` | `CN=SenecGui-Root` | 2026-09-30 → 2036-09-27 |

Two things follow. The CN on 4424 is the appliance's own `FACTORY.DEVICE_ID`, prefixed `S` —
so this certificate identifies the individual appliance and can be pinned exactly, which the
`senecGuiSelf` certificate on 443 cannot. And the CA that signs it is `openapi`, not
`SenecGui-Root`, so the CA fetched from the portal for the local connector
(`_local.tls.cachedCaPem`) would not validate this listener. A connector built on 4424 needs
its own trust path; it cannot reuse `negotiateLocalTls`. See
[TLS_TOFU_REVIEW.md](TLS_TOFU_REVIEW.md).

Note also that the issuer spells the state `Sachsen` where every other SENEC certificate
spells it `Saxony` — a small sign this listener was built by a different team or at a
different time from the GUI.

## Which systems have it

- **V3** — present. Measured here.
- **V2 / V2.1** — expected, on the strength of the ASKOMA manual covering them, with
  firmware 4.4.0 or later. Not measured.
- **V4 / P4 / E4** — **absent.** Two independent reports describe 4424 as actively refusing
  connections, one backed by a full 1–65535 port scan finding only 80 and 111 open, and
  confirming the `/v1/*` paths are not served on 80 either. The portal's OpenAPI page renders
  for those systems but stays empty, since nothing can register.

**There is no known appliance that serves 4424 but not `lala.cgi`.** The two go together on
V2 and V3, and the systems that have dropped `lala.cgi` — V4, P4, E4 — are exactly the ones
that do not open 4424. So this interface is not a route into the newer systems, which is the
thing one would most want it for. It is a second way into the systems that are already
reachable.

That said, a user may well run **only** this connector and leave the local one switched off,
and the connector has to work in that state: the appliance identity then comes from the
certificate rather than from `FACTORY.DEVICE_ID`, which is what
`openapiIdentifyFromCertificate` exists for.

## What this means for the adapter — the constraints the connector obeys

The connector is built inside the four limits the measurements above establish. They are
constraints on what it can be asked to do, not details of how it happens to be written today:

1. **It is optional and off by default, because it adds no data the adapter does not already
   have.** Every field on the five readable routes is already polled from `lala.cgi`, at an
   interval we control. On a V3 this interface is a second way to read the same values — and, as
   the comparison above shows, a near-duplicate of what the SENEC.Connect connector already
   reads from the cloud. So it earns its keep as a second opinion on the same quantities, or as
   the only local connector on an installation that leaves `lala.cgi` switched off — the case
   just above, which is what `openapiIdentifyFromCertificate` serves — and not as something to
   switch on for everybody.
2. **It cannot be offered to V4/P4 owners**, who are the ones with no local alternative. So it
   is a V2/V3 feature, and the generations that most need a local route are exactly the ones it
   will never reach.
3. **It is read-only, because the one thing it would add — a charge/discharge setpoint — is
   closed to us.** This is now measured rather than assumed: a fully approved token gets `403`
   on `/v1/bess/setpoint` and `/v1/battery/limits`, exactly as it does before approval. A
   control feature built on them would be a switch that returns 403, so the connector issues no
   writes at all, and nothing may be added to it that does.
4. **It needs its own TLS trust path**, per the certificate chain above — the connector cannot
   reuse `negotiateLocalTls` or the CA the local connector caches from the portal. It identifies
   the appliance by the CN of the 4424 certificate and pins the certificate itself on first
   sight instead — see [TLS_TOFU_REVIEW.md](TLS_TOFU_REVIEW.md).

If a way is found to pass the gate on `/v1/bess/setpoint`, that changes: it would be the
first sanctioned route to a real discharge block, and the one reason to give this connector a
write path. On the evidence above that is not a privilege an end customer can be granted — the
capability is absent from the published API surface entirely, not merely withheld.
See also [issue #543](https://github.com/nobl/ioBroker.senec/issues/543).

## Reproducing the probes

No token required; none of these can change anything, since authentication fails first.

```bash
# Is the listener there at all?
curl -sk -i https://<appliance ip>:4424/v1/battery          # expect 401 Incorrect token

# Route inventory — 401 means the route exists, 404 means it does not
for p in /v1/battery /v1/meter /v1/bess /v1/bess/nameplate /v1/evse \
         /v1/battery/limits /v1/bess/setpoint; do
  printf '%-22s %s\n' "$p" \
    "$(curl -sk -o /dev/null -w '%{http_code}' https://<appliance ip>:4424$p)"
done

# Method routing — 405 means the router rejected the verb, 401 means auth ran first
for m in GET POST PUT PATCH DELETE OPTIONS; do
  printf '%-8s %s\n' "$m" \
    "$(curl -sk -o /dev/null -w '%{http_code}' -X $m \
        https://<appliance ip>:4424/v1/bess/setpoint)"
done

# Certificate
echo | openssl s_client -connect <appliance ip>:4424 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```
