# Wallbox charging and the consumption figure

Whether a connector's consumption reading already contains the wallbox charging load decides
how the dashboard may present the two numbers. The four connectors do not answer it the same
way, and the one the dashboard depends on for the daily figure is not settled.

## What each connector does today

| Connector | Live wallbox power | Consumption reading | Relation |
| --- | --- | --- | --- |
| lala.cgi (local) | summed from `WALLBOX.APPARENT_CHARGING_POWER.0..3` | `GUI_HOUSE_POW` | assumed contained — the flow diagram branches the wallbox off the house node |
| Local OpenAPI (4424) | not used; `data.wallbox` is forced to `0` | `consumption` | not established either way, which is why the connector keeps the wallbox out of the flow maths entirely. [LOCAL_OPENAPI_4424.md](LOCAL_OPENAPI_4424.md) records that this listener publishes no schema at all; the `consumption`-excludes-wallbox definition it quotes belongs to the SENEC.Connect cloud schema, which shares field names but is a different interface. |
| mein-senec.de (web) | not provided; `data.wallbox` is forced to `0` | `consumption.now` | no wallbox figure exists, so the question does not arise |
| SENEC App API | `currently.wallboxInW`, daily `today.wallboxInWh` | `currently.powerConsumptionInW`, daily `today.powerConsumptionInWh` | assumed contained; **not confirmed against a payload** |

## The open question

Only the App API reports a daily wallbox figure, so it is the only connector whose totals list
can show the row at all. The dashboard treats that figure as part of consumption — it indents
the row beneath the consumption row, matching the flow diagram above it, which draws the
wallbox as a branch off the house node.

That is a reasonable reading of SENEC's own model, but it has not been checked against a real
response.

## The observation that settles it

It cannot be taken on an installation without a SENEC wallbox, which is why this is still
open: no wallbox means `today.wallboxInWh` never carries a figure and the balance below has
nothing to test. It needs a report from an installation that has one.

One App API Dashboard response for a day with substantial EV charging, with all seven figures:

```text
today.powerGenerationInWh
today.gridDrawInWh
today.batteryDischargeInWh
today.powerConsumptionInWh
today.gridFeedInInWh
today.batteryChargeInWh
today.wallboxInWh
```

Then test the balance:

```text
generation + gridDraw + batteryDischarge − gridFeedIn − batteryCharge ≈ powerConsumption
```

- If it closes as written, and `powerConsumption > wallbox`, consumption **contains** the
  charging load. The current presentation is right.
- If it only closes with `+ wallbox` added to the right-hand side, consumption **excludes** it,
  and the wallbox is a destination in its own right rather than a breakdown of consumption.

Record the outcome here when it is observed.
