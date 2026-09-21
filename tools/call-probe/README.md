# Messenger group-call payload probe

**Read-only diagnostic tool.** It answers one question before you commit to
building anything:

> When a group call happens in our Messenger group, what does the protocol
> actually send us — and is any per-person duration data in there?

## Why this exists

The library subscribes to the call-signalling MQTT topics

```ts
// src/transport/realtime/topics.ts
"/webrtc", "/rtc_multi", "/onevc", "/webrtc_response"
```

but `src/transport/realtime/connect-mqtt.ts` only has handlers for
`/t_ms`, `/thread_typing`, `/orca_typing_notifications`, `/orca_presence` and
`/ls_resp`. Everything on the call topics is parsed and **silently dropped**.

`probe.js` attaches a second listener directly onto `ctx.mqttClient`, so it can
see those payloads before the library discards them. It does **not** modify the
library and does **not** write anything to Facebook — it never sends a message,
reaction, or presence update.

## Setup

```bash
npm install          # once, in the repo root
npm run build        # if dist/ is stale
```

You need an `appstate.json` — the session cookies of the account that will
observe the group.

### Getting appstate.json

Use a browser extension that exports Facebook cookies as JSON (commonly
"c3c-fbstate" or similar), while logged in as the **observer account**, then
save the array to `appstate.json` in the repo root.

> `appstate.json` is already in `.gitignore`. Never commit it, never paste it
> into a chat, and never share it — it is a full live session for that account.

### Which account should observe?

- The account **must already be a member of the group** — a non-member receives
  no thread events at all.
- Prefer a **secondary account**, not your main one. The README of this library
  warns that this usage pattern can get an account restricted or banned.
- Keep it logged in on the machine running the probe for the whole call.

## Run it

```bash
# focused capture on one group, prints call hits live
node tools/call-probe/probe.js --thread 1234567890

# also scan the last 300 messages for call-log entries (great for a quick test)
node tools/call-probe/probe.js --thread 1234567890 --backfill 300

# capture everything for 2 hours, auto-stop
node tools/call-probe/probe.js --thread 1234567890 --hours 2

# full firehose (noisier, useful when you don't know the thread ID yet)
node tools/call-probe/probe.js --raw --verbose
```

Press **Ctrl+C** to stop — it prints a summary of every topic seen and every
duration-like field it found.

### Options

| Flag | Meaning |
|---|---|
| `--appstate <path>` | appstate file (default `./appstate.json`, or `$FCA_APPSTATE`) |
| `--thread <id>` | only record events for this thread |
| `--all-threads` | record every thread |
| `--out <dir>` | output directory (default `./capture`) |
| `--hours <n>` | auto-stop after n hours |
| `--backfill <n>` | scan the last n history messages for call logs |
| `--raw` | record all payloads, not just call-related |
| `--max-mb <n>` | stop writing past n MB (default 64) |
| `--max-payload-kb <n>` | truncate one payload at n KB (default 256) |
| `--verbose` | print every captured record |

The easiest way to find your group's thread ID: run with `--raw --verbose`,
send a message in the group, and read the `threadID` off the printed event.

## Analyze the capture

```bash
node tools/call-probe/analyze.js capture/call-probe-*.jsonl --report capture/verdict.md
```

The analyzer reports which topics carried call traffic, inventories every field
in the call payloads, searches for join / leave / duration keys, and prints a
verdict on whether per-person durations are computable — with the supporting
evidence, not just an opinion.

## What to do with the result

Run a **controlled test**: start a call with two people, have one leave after
~60 seconds and the other after ~120, then stop the probe and analyze. That
gives a capture where the true durations are known, so you can check whether the
data supports recovering them.

- If the analyzer reports **durations computable = PARTIAL or better**, the
  tracker design in `docs/CALL_MONITORING_FEASIBILITY.md` (Option A) is worth
  building.
- If it reports **NONE** (which matches the current code reading), then accurate
  durations are not obtainable, and any report image would contain invented
  numbers. Reconsider the approach rather than building on it.

## Privacy and consent

A capture file contains the real names, Facebook IDs, message contents and
call metadata of everyone in the group.

- For a **class or study group**: tell the participants that call attendance is
  being recorded, and why. In many jurisdictions attendance monitoring of
  people requires their knowledge and consent.
- Keep `capture/` local. It is git-ignored — keep it that way.
- Delete captures when you are done with them.
- The account you use is subject to Meta's Terms of Service, which this library's
  own README states this usage may violate.
