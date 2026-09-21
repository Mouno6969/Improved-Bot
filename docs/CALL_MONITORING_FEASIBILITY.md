# Feasibility: Messenger Group Call Monitoring ("who joined, for how long")

**Repo:** `Mouno6969/Improved-Bot` — branch `arena/01a0c436-improved-bot`
**Code reviewed at commit:** `c2d1f0e`
**Library:** `@dongdev/fca-unofficial` v4.0.3 (unofficial Facebook Messenger API, TypeScript)
**Verdict:** ❌ **Not possible as requested, out of the box.** Partial presence signals exist; accurate per-person call durations do not, and no report image is generated at all.

---

## 1. What this repository actually is

Despite the repo name, there is no "bot" application here. It is the **library** itself:

| Fact | Evidence |
|---|---|
| Unofficial Messenger API client, emulates a logged-in browser session | `README.md` disclaimer; `package.json` name/description |
| Speaks Facebook's HTTP/GraphQL + MQTT protocols | `src/transport/http/*`, `src/transport/realtime/*` |
| Public surface = message/thread/user/account commands | `src/domains/*/commands`, `src/domains/*/queries` |
| Ships as a reusable package (`"files": ["dist/", ...]`) | `package.json` |

It gives you an authenticated `api` object for sending messages, reading threads, and receiving realtime events. It is **not** a monitoring system, and it has no notion of a "call session".

---

## 2. Call-related capability that DOES exist

I found exactly six touchpoints. All of them are *signals about calls*, none are *call accounting*.

| # | Location | What it does |
|---|---|---|
| 1 | `src/transport/realtime/topics.ts:11-13,26` | Subscribes to the real call-signalling MQTT topics: `/webrtc`, `/rtc_multi`, `/onevc`, `/webrtc_response` |
| 2 | `src/domains/realtime/parse-delta.ts:270-272` | Recognises `AdminTextMessage` types `messenger_call_log`, `participant_joined_group_call`, `rtc_call_log` |
| 3 | `src/utils/format/delta.ts:28-30` | Maps `messenger_call_log` + `participant_joined_group_call` → `logMessageType: "log:thread-call"` |
| 4 | `src/utils/format/delta.ts:46` | Call payload is passed through **raw and unparsed** as `logMessageData = m.untypedData` |
| 5 | `src/domains/threads/queries/get-thread-history.ts:255-259` | Maps `RtcCallLogExtensibleMessageAdminText` → `{ event, is_video_call, server_info_data }` |
| 6 | `src/domains/threads/queries/get-thread-history.ts:451-473` | Maps `VideoCallMessage` / `VoiceCallMessage` → `eventType: "video_call"` / `"voice_call"` |

So a bot built on this library **can** be notified that *a call happened*, and *that someone joined a group call*. That is the whole of it.

---

## 3. Blockers for "who attended for how long"

### 🔴 Blocker 1 — No duration data exists anywhere

A full-text search for `duration`, `call_duration`, `seconds`, `elapsed`, `attendance` across `src/` returns **only** `playable_duration_in_ms` — the length of audio/video **attachments**:

- `src/domains/threads/queries/get-thread-history.ts:81,110,173`
- `src/domains/messages/queries/get-message.ts:64`

There is no call duration field in the library, and no call-log duration is parsed from the raw payloads.

### 🔴 Blocker 2 — There is no "left the call" event

`participant_joined_group_call` is handled (`parse-delta.ts:271`). The symmetric `participant_left_group_call` / `call_ended` case **does not exist anywhere in the repo**. Messenger's admin-text call logs do not emit a per-participant leave event either.

**Consequence:** you can observe a join but not a departure. Without both timestamps, *duration is mathematically unobtainable from events*. Any number you printed would be a guess.

### 🔴 Blocker 3 — The topics where real call state lives are subscribed and then thrown away

`topics.ts` subscribes to `/webrtc`, `/rtc_multi`, `/onevc`, `/webrtc_response` — but `src/transport/realtime/connect-mqtt.ts:279-308` only has handlers for:

```
jewel_requests_add / jewel_requests_remove_old
/t_ms            → deltas (messages, admin texts, reactions)
/thread_typing, /orca_typing_notifications
/orca_presence   → online/offline presence
/ls_resp         → task responses
```

Every message on `/webrtc`, `/rtc_multi`, `/onevc`, `/webrtc_response` is JSON-parsed and **silently discarded** — no `else` branch, no logging. This is where actual call participant telemetry lives, and the library does not decode it.

### 🔴 Blocker 4 — The call payloads that are kept are opaque blobs

`server_info_data` (`get-thread-history.ts:258`) and `untypedData` (`format/delta.ts:46`) are passed through as raw values. No schema, no decoder, no protobuf/thrift definitions anywhere in the repo. Extracting attendees from them requires reverse-engineering an undocumented Meta payload that can change without notice.

### 🔴 Blocker 5 — Presence ≠ attendance

`/orca_presence` (`connect-mqtt.ts:301`) reports whether a user is *online on Messenger*. That has no relationship to being in a specific call, and must not be used as a proxy for it.

### 🔴 Blocker 6 — MQTT is not reliable enough for time accounting

| Behaviour | Location | Consequence for duration accuracy |
|---|---|---|
| Forced reconnect cycle every 60 min | `listener.ts:3` `CYCLE_MS_DEFAULT = 60 * 60 * 1000` | Any join during the cycle window is missed |
| Reconnect delay 2 s + jitter | `listener.ts:4` `RECONNECT_DELAY_MS_DEFAULT = 2000` | Gaps become under-counted durations |
| `lastSeqId` reset on re-listen | `listener.ts` `listenRealtime` (`if (!ctx.firstListen) ctx.lastSeqId = null`) | Events are re-fetched or lost across restarts |
| Process restart / machine sleep | — | State lost unless persisted |

The bot must run **24/7, uninterrupted** to even *attempt* session tracking. Any gap silently produces wrong numbers with no warning to the user.

### 🔴 Blocker 7 — No report-image capability whatsoever

`package.json` has **no** image dependency — no `sharp`, `canvas`, `jimp`, `pureimage`. Nothing in `src/` renders an image. The "photo at the end of the session" must be built from zero and a rendering dependency added.

### 🔴 Blocker 8 — No call-session concept

There is no state machine that groups joins into a "call session", no session start/end detection, no per-user accumulator. `src/domains/scheduler` is a generic task scheduler, not call tracking. The entire domain would be new code.

---

## 4. Risk and compliance

1. **ToS / account ban.** The README states plainly that emulating a logged-in browser session *"may violate Facebook / Meta's Terms of Service and could result in account restrictions or bans."* A dedicated monitoring account parked in a group 24/7 is exactly the pattern Meta's abuse detection targets.
2. **Consent.** Producing a per-person attendance-and-duration report about other people is processing personal data. Depending on your jurisdiction this needs informed consent and a lawful basis (GDPR-style rules; additional duties for employee monitoring). **Covert attendance monitoring is illegal in many places.**
3. **Data you cannot get anyway.** Meta exposes no official API for Messenger call attendance or durations — not even to the call's host. So this is not a case of "use the official endpoint instead"; the data simply is not published.

---

## 5. Verdict

| Question | Answer |
|---|---|
| Can this library tell me a group call happened? | ✅ Yes — `log:thread-call` / call-log admin texts |
| Can it tell me someone **joined** a group call? | ⚠️ Partially — `participant_joined_group_call`, subject to connection gaps |
| Can it tell me who **attended** reliably (full roster)? | ❌ No — no leave events, roster not exposed |
| Can it tell me **how long** each person stayed? | ❌ **No — no duration data exists in the library or the delivery path** |
| Can it generate a report image at session end? | ❌ No — must be built from scratch, and it would render guesses |

**A "total call monitoring system" with accurate durations is not achievable with this repository.** What is achievable is a *best-effort join-signal logger* with explicitly-fuzzy durations — which is a materially different product and should be labelled as approximate to its users.

---

## 6. Options

**Option A — Best-effort tracker (honest approximation).**
Add a `calls` domain that hooks `log:thread-call` / `rtc_call_log` / `messenger_call_log` / `participant_joined_group_call`, runs a session state machine, infers departures from the next-best signal (leaving it visibly uncertain), persists to the existing Sequelize/SQLite store (`src/database/`), and renders a PNG summary with `@napi-rs/canvas`. Every figure labelled approximate, every connection gap logged as a data-quality caveat.

**Option B — Live capture probe first.**
Run a short listener on *your* group thread to record the raw `untypedData` / `server_info_data` payloads Messenger actually sends, so we know empirically what is extractable before committing to a design. Requires you to supply an appstate and run it locally.

**Option C — Use a platform that actually provides attendance data.**
If this is a work meeting or a class, Zoom / Teams / Google Meet publish per-participant join, leave, and duration reports through official APIs, and they do it lawfully with consent. For Messenger, no such thing exists.

---

## 7. Recommendation

Do not promise anyone a "total call monitoring system" on this stack. If the goal is real attendance accountability, **Option C** is the only path that yields trustworthy numbers. If the goal is best-effort awareness of *who showed up* (with durations clearly marked approximate) and you accept the ban risk and handle consent properly, **Option A** is buildable — starting with **Option B** to confirm what the payloads contain.

---

## 8. Step 1 delivered: the payload probe (Option B)

`tools/call-probe/` implements the empirical test this document asks for. It is
**read-only** — it never sends a message, reaction, or presence update.

| File | Role |
|---|---|
| `tools/call-probe/probe.js` | Attaches a second listener onto `ctx.mqttClient` to capture payloads on `/webrtc`, `/rtc_multi`, `/onevc`, `/webrtc_response` **before** `connect-mqtt.ts` discards them. Also captures normalised events and optional thread-history call logs. Writes redacted JSONL to a git-ignored `capture/` folder. |
| `tools/call-probe/analyze.js` | Inventories every field in the capture, searches for join / leave / duration signals, and prints a verdict on whether per-person durations are computable — every finding backed by evidence. |
| `tools/call-probe/README.md` | Setup, appstate instructions, flag reference, privacy and consent notes. |
| `tools/call-probe/__fixtures__/sample-capture.jsonl` | Synthetic capture so the analyzer can be tested without real data. Contains no personal information. |

### Run a controlled test

```bash
npm install && npm run build
node tools/call-probe/probe.js --thread <groupID> --backfill 300
#   start a call, one person leaves at ~60s, the other at ~120s, then Ctrl+C
node tools/call-probe/analyze.js capture/call-probe-*.jsonl --report capture/verdict.md
```

Because the true durations are known, this reveals definitively whether the data
supports recovering them. Per §3 the expected result is
**"per-person durations: NONE"** — but the capture will have proved it, and it
also shows what *is* available for Option A.

**Decision gate:** if the analyzer reports durations as obtainable, proceed to
Option A. If it reports `NONE`, do not build the report image — it would contain
fabricated numbers.
