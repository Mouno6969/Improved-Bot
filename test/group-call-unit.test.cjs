"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

async function loadParser() {
  const file = pathToFileURL(
    path.join(__dirname, "../src/domains/calls/join-command.ts")
  ).href;
  return import(file);
}

async function loadRtc() {
  const file = pathToFileURL(
    path.join(__dirname, "../src/domains/calls/parse-rtc.ts")
  ).href;
  return import(file);
}

async function loadTracker() {
  const file = pathToFileURL(
    path.join(__dirname, "../src/domains/calls/call-tracker.ts")
  ).href;
  return import(file);
}

async function main() {
  const { parseCallCommand, parseJoinCommand } = await loadParser();
  const { formatRtcMessage, formatCallLogEvent } = await loadRtc();
  const { applyGroupCallEvent, getTrackedCall, dropTrackedCall } = await loadTracker();

  assert.deepStrictEqual(parseJoinCommand("/join"), {
    kind: "join",
    isVideo: false,
    mute: true,
    startIfMissing: true
  });
  assert.deepStrictEqual(parseJoinCommand("/join video unmute"), {
    kind: "join",
    isVideo: true,
    mute: false,
    startIfMissing: true
  });
  assert.strictEqual(parseJoinCommand("hello"), null);
  assert.strictEqual(parseCallCommand("/leave").kind, "leave");
  assert.strictEqual(parseCallCommand("/hangup").kind, "leave");
  assert.strictEqual(parseCallCommand("/call").kind, "status");
  assert.strictEqual(parseCallCommand("!join", "!").kind, "join");

  const rtc = formatRtcMessage("/rtc_multi", {
    type: "join",
    from: "111",
    thread_id: "999",
    call_id: "c1",
    participants: [{ id: "111" }, { id: "222" }]
  });
  assert.strictEqual(rtc.type, "group_call");
  assert.strictEqual(rtc.threadID, "999");
  assert.strictEqual(rtc.callId, "c1");
  assert.strictEqual(rtc.status, "join");
  assert.deepStrictEqual(rtc.participants, ["111", "222"]);

  const logEvent = formatCallLogEvent({
    logMessageType: "log:thread-call",
    threadID: "999",
    author: "111",
    logMessageData: { event: "participant_joined_group_call", call_id: "c1" },
    participantIDs: ["111", "222"]
  });
  assert.ok(logEvent);
  assert.strictEqual(logEvent.status, "join");

  const ctx = { userID: "bot" };
  applyGroupCallEvent(ctx, rtc);
  const tracked = getTrackedCall(ctx, "999");
  assert.ok(tracked);
  assert.strictEqual(tracked.callId, "c1");
  dropTrackedCall(ctx, "999");
  assert.strictEqual(getTrackedCall(ctx, "999"), null);

  console.log("PASS group-call-unit");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
