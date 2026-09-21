#!/usr/bin/env node
/**
 * Messenger group-call payload probe.
 * ---------------------------------------------------------------------------
 * PURPOSE
 *   The library (src/transport/realtime/topics.ts) subscribes to the call
 *   signalling topics /webrtc, /rtc_multi, /onevc and /webrtc_response, but
 *   src/transport/realtime/connect-mqtt.ts has no handler for them, so those
 *   payloads are parsed and discarded.
 *
 *   This probe attaches a second listener directly onto ctx.mqttClient and
 *   records EVERY topic it can see, plus every normalised event the library
 *   emits. It answers empirically: what does Messenger actually send about
 *   group calls, and is any duration/participant data recoverable?
 *
 * SAFETY
 *   - Read-only. It never sends a message, reaction, or presence update.
 *   - Credential-shaped fields are redacted before anything is written.
 *   - Output goes to a local, git-ignored capture/ directory.
 *
 * USAGE
 *   node tools/call-probe/probe.js --thread <groupThreadID>
 *   node tools/call-probe/probe.js --thread <id> --hours 2 --raw
 *   node tools/call-probe/probe.js --thread <id> --backfill 300
 *
 *   Then, after the call:
 *   node tools/call-probe/analyze.js capture/<file>.jsonl
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "capture");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS_WITH_VALUES = new Set([
  "appstate",
  "thread",
  "out",
  "hours",
  "backfill",
  "max-mb",
  "max-payload-kb"
]);

const FLAGS_BOOLEAN = new Set(["raw", "all-threads", "verbose", "help"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    let key = token.slice(2);
    let inlineValue;
    const eq = key.indexOf("=");
    if (eq !== -1) {
      inlineValue = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (FLAGS_BOOLEAN.has(key)) {
      args[key] = true;
      continue;
    }
    if (FLAGS_WITH_VALUES.has(key)) {
      const value = inlineValue !== undefined ? inlineValue : argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for --${key}`);
      }
      args[key] = value;
      continue;
    }
    throw new Error(`Unknown flag --${key}`);
  }
  return args;
}

function printHelp() {
  process.stdout.write(`
Messenger group-call payload probe (read-only)

  --appstate <path>      appstate JSON file (default: ./appstate.json)
  --thread <id>          only record events for this thread ID
  --all-threads          record every thread (overrides --thread filter)
  --out <dir>            output directory (default: ./capture)
  --hours <n>            stop automatically after n hours
  --backfill <n>         also fetch the last n thread-history messages and
                         record any call-log entries found
  --raw                  record full payloads, not just call-related ones
  --max-mb <n>           stop writing when a file passes n MB (default: 64)
  --max-payload-kb <n>   truncate a single payload at n KB (default: 256)
  --verbose              print every captured record to stdout
  --help                 show this message
`);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_KEY_RE =
  /(token|dtsg|session|cookie|password|secret|jazoest|lsd|authorization|signature|nonce|csrf)/i;

const REDACTED = "[REDACTED]";
const MAX_STRING = 4000;

function redactValue(value, depth, seen) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "number" || t === "boolean") return value;
  if (t === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (t !== "object") return String(value);
  if (depth > 12) return "[depth-limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.slice(0, 500).map((v) => redactValue(v, depth + 1, seen));
    if (value.length > 500) out.push(`[+${value.length - 500} more]`);
    return out;
  }

  const out = {};
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactValue(value[key], depth + 1, seen);
  }
  return out;
}

function redact(value) {
  return redactValue(value, 0, new WeakSet());
}

// ---------------------------------------------------------------------------
// Call-related classification
// ---------------------------------------------------------------------------

const CALL_TOPIC_RE = /webrtc|rtc|onevc|call|voip/i;
const CALL_LOG_TYPE_RE = /thread-call|call_log|call_ended|call_started|group_call/i;
const CALL_KEY_RE =
  /call|webrtc|rtc|onevc|voip|conference|participant_joined|server_info_data/i;

function isCallTopic(topic) {
  return CALL_TOPIC_RE.test(String(topic || ""));
}

/**
 * Decide whether a normalised library event is call-related. Returns a short
 * reason string, or null.
 */
function classifyEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.logMessageType && CALL_LOG_TYPE_RE.test(String(event.logMessageType))) {
    return `logMessageType=${event.logMessageType}`;
  }
  if (event.eventType && /call/i.test(String(event.eventType))) {
    return `eventType=${event.eventType}`;
  }
  const haystack = [];
  if (event.logMessageData && typeof event.logMessageData === "object") {
    haystack.push(...Object.keys(event.logMessageData));
  }
  if (event.eventData && typeof event.eventData === "object") {
    haystack.push(...Object.keys(event.eventData));
  }
  const hit = haystack.find((k) => CALL_KEY_RE.test(k));
  if (hit) return `logMessageData.${hit}`;
  return null;
}

const DURATION_KEY_RE = /duration|elapsed|length_in|call_length|seconds|talk_time|ended_at|started_at|join_time|leave_time/i;

/** Walk an object and collect any key that smells like a time/duration field. */
function findTimingFields(value, prefix, found, depth, seen) {
  if (!value || typeof value !== "object" || depth > 12) return found;
  if (seen.has(value)) return found;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    const label = prefix ? `${prefix}.${key}` : key;
    if (DURATION_KEY_RE.test(key)) {
      found.push({ path: label, value: typeof child === "object" ? "[object]" : child });
    }
    if (child && typeof child === "object") {
      findTimingFields(child, label, found, depth + 1, seen);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Capture writer
// ---------------------------------------------------------------------------

function createWriter(outDir, maxBytes, log) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `call-probe-${stamp}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: "a" });

  let bytes = 0;
  let records = 0;
  let truncated = false;

  function write(record) {
    if (truncated) return;
    if (bytes >= maxBytes) {
      truncated = true;
      stream.write(
        `${JSON.stringify({
          capturedAt: new Date().toISOString(),
          channel: "probe",
          note: `Max size (${maxBytes} bytes) reached; further records dropped.`
        })}\n`
      );
      log(`max capture size reached — no longer writing to ${file}`, "warn");
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    bytes += Buffer.byteLength(line);
    records++;
    stream.write(line);
  }

  return {
    file,
    write,
    get records() {
      return records;
    },
    get bytes() {
      return bytes;
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const log = (message, level = "info") => {
    const time = new Date().toISOString().slice(11, 19);
    const prefix = level === "warn" ? "!" : level === "error" ? "x" : "-";
    process.stdout.write(`${time} ${prefix} ${message}\n`);
  };

  const appstatePath = path.resolve(
    args.appstate || process.env.FCA_APPSTATE || path.join(process.cwd(), "appstate.json")
  );
  if (!fs.existsSync(appstatePath)) {
    log(`appstate file not found: ${appstatePath}`, "error");
    log("Export your session cookies as appstate.json, or pass --appstate <path>.", "info");
    log("See tools/call-probe/README.md for how to obtain it.", "info");
    return 2;
  }

  let appstate;
  try {
    appstate = JSON.parse(fs.readFileSync(appstatePath, "utf8"));
  } catch (err) {
    log(`could not parse appstate JSON: ${err.message}`, "error");
    return 2;
  }
  if (!Array.isArray(appstate) || appstate.length === 0) {
    log("appstate must be a non-empty array of {key, value} cookie objects.", "error");
    return 2;
  }

  const outDir = path.resolve(args.out || DEFAULT_OUT_DIR);
  const maxBytes = (Number(args["max-mb"]) || 64) * 1024 * 1024;
  const maxPayload = (Number(args["max-payload-kb"]) || 256) * 1024;

  const threadFilter = args["all-threads"] ? null : args.thread ? String(args.thread) : null;
  if (!threadFilter && !args["all-threads"]) {
    log("no --thread given: capturing call-related traffic from ALL threads.", "warn");
    log("pass --thread <groupID> to keep the capture focused.", "info");
  }

  const writer = createWriter(outDir, maxBytes, log);
  log(`capturing to ${writer.file}`);

  // Lazy-require so a missing install produces a clear message.
  let loginAsync;
  try {
    // eslint-disable-next-line global-require
    const fca = require(path.join(REPO_ROOT, "dist", "cjs.cjs"));
    loginAsync = fca.loginAsync || (fca.default && fca.default.loginAsync);
  } catch (err) {
    log(`could not load the library: ${err.message}`, "error");
    log("Run `npm install` in the repo root first.", "info");
    return 2;
  }
  if (typeof loginAsync !== "function") {
    log("dist/cjs.cjs does not export loginAsync — run `npm run build`.", "error");
    return 2;
  }

  const stats = {
    startedAt: new Date().toISOString(),
    rawMessages: 0,
    relatedMessages: 0,
    emittedEvents: 0,
    callEvents: 0,
    topics: new Map(),
    callTopics: new Map(),
    timingFields: new Map()
  };

  log("logging in…");
  const ctx = await loginAsync(
    { appstate },
    {
      listenEvents: true,
      selfListen: true,
      selfListenEvent: true,
      listenTyping: true,
      autoReconnect: true,
      emitReady: true,
      updatePresence: false,
      online: false,
      autoMarkRead: false
    }
  );
  log(`logged in as ${ctx.fbid || ctx.userID || "unknown"}`);

  // -- Raw MQTT tap ---------------------------------------------------------
  // ctx.mqttClient is replaced on every reconnect cycle, so re-attach whenever a
  // new client instance shows up.
  const tapped = new WeakSet();

  function attachTap(client) {
    if (!client || typeof client.on !== "function" || tapped.has(client)) return;
    tapped.add(client);
    client.on("message", (topic, message) => {
      stats.rawMessages++;
      stats.topics.set(topic, (stats.topics.get(topic) || 0) + 1);
      if (isCallTopic(topic)) {
        stats.callTopics.set(topic, (stats.callTopics.get(topic) || 0) + 1);
      }

      let text;
      try {
        text = Buffer.isBuffer(message) ? message.toString("utf8") : String(message);
      } catch {
        text = "[unreadable]";
      }
      // MQTT payloads are raw and may be binary (thrift/protobuf).
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      const callTopic = isCallTopic(topic);
      if (!args.raw && !callTopic) return;

      stats.relatedMessages++;

      const timings = parsed
        ? findTimingFields(parsed, "", [], 0, new WeakSet())
        : [];
      for (const t of timings) {
        stats.timingFields.set(t.path, (stats.timingFields.get(t.path) || 0) + 1);
      }

      const record = {
        capturedAt: new Date().toISOString(),
        channel: "raw-mqtt",
        topic,
        callTopic,
        parsedOk: parsed !== null,
        byteLength: Buffer.byteLength(text),
        timingFields: timings,
        payload: parsed !== null ? redact(parsed) : redact(text.slice(0, maxPayload))
      };
      if (parsed === null && text.length > maxPayload) {
        record.payloadTruncated = true;
      }
      writer.write(record);

      if (args.verbose || callTopic) {
        log(`[raw] ${topic} (${record.byteLength}B) parsed=${record.parsedOk}`);
        if (timings.length) {
          for (const t of timings) log(`        timing: ${t.path} = ${t.value}`);
        }
      }
    });
    log("raw MQTT tap attached");
  }

  const tapTimer = setInterval(() => attachTap(ctx.mqttClient), 2000);
  attachTap(ctx.mqttClient);

  // -- Normalised event tap -------------------------------------------------
  const emitter = ctx.api.listenMqtt((err, event) => {
    if (err) {
      log(`mqtt error: ${err && (err.error || err.message || err)}`, "error");
      return;
    }
    stats.emittedEvents++;
    if (event && event.type === "ready") {
      log("mqtt ready");
      return;
    }
    if (event && event.type === "presence" && !args.verbose) return;

    const reason = classifyEvent(event);
    const inScope =
      !threadFilter || String(event && event.threadID) === threadFilter;

    if (!reason || !inScope) {
      if (args.verbose) {
        writer.write({
          capturedAt: new Date().toISOString(),
          channel: "event",
          threadFilter,
          inScope,
          callRelated: false,
          event: redact(event)
        });
      }
      return;
    }

    stats.callEvents++;
    const timings = findTimingFields(event, "", [], 0, new WeakSet());
    for (const t of timings) {
      stats.timingFields.set(t.path, (stats.timingFields.get(t.path) || 0) + 1);
    }

    writer.write({
      capturedAt: new Date().toISOString(),
      channel: "event",
      threadFilter,
      inScope: true,
      callRelated: true,
      callReason: reason,
      timingFields: timings,
      event: redact(event)
    });

    log(`[call] ${reason} thread=${event.threadID || "?"} author=${event.author || event.senderID || "?"}`);
    if (event.logMessageData) {
      log(`       logMessageData: ${JSON.stringify(redact(event.logMessageData)).slice(0, 500)}`);
    }
    if (event.logMessageBody) {
      log(`       logMessageBody: ${String(event.logMessageBody).slice(0, 300)}`);
    }
    if (timings.length) {
      for (const t of timings) log(`       timing: ${t.path} = ${t.value}`);
    }
  });

  emitter.on("error", (err) => {
    log(`emitter error: ${err && (err.error || err.message || err)}`, "error");
  });

  // -- Optional history backfill -------------------------------------------
  if (args.backfill && threadFilter) {
    const amount = Math.max(1, Math.min(5000, Number(args.backfill) || 100));
    log(`backfilling last ${amount} messages of thread ${threadFilter}…`);
    try {
      const history = await new Promise((resolve, reject) => {
        ctx.api.getThreadHistory(threadFilter, amount, undefined, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      const entries = Array.isArray(history) ? history : [];
      let found = 0;
      for (const entry of entries) {
        const reason = classifyEvent(entry);
        if (!reason) continue;
        found++;
        writer.write({
          capturedAt: new Date().toISOString(),
          channel: "history",
          threadFilter,
          callRelated: true,
          callReason: reason,
          timingFields: findTimingFields(entry, "", [], 0, new WeakSet()),
          event: redact(entry)
        });
        log(`[history] ${reason} at ${entry.timestamp ? new Date(entry.timestamp).toISOString() : "?"}`);
        log(`          ${JSON.stringify(redact(entry.eventData || entry.logMessageData || {})).slice(0, 500)}`);
      }
      log(`backfill done: ${entries.length} messages scanned, ${found} call-related`);
    } catch (err) {
      log(`backfill failed: ${err && (err.message || err)}`, "error");
      log("check that the thread ID is correct and the account is still a member.", "info");
    }
  }

  // -- Summary / shutdown ---------------------------------------------------
  function summarize() {
    const topTopics = [...stats.topics.entries()].sort((a, b) => b[1] - a[1]);
    log("");
    log("================ capture summary ================");
    log(`started:            ${stats.startedAt}`);
    log(`stopped:            ${new Date().toISOString()}`);
    log(`raw MQTT messages:  ${stats.rawMessages}`);
    log(`call-related emits: ${stats.callEvents}`);
    log(`emitted events:     ${stats.emittedEvents}`);
    log(`records written:    ${writer.records}`);
    log("");
    log("topics seen:");
    for (const [topic, count] of topTopics) {
      const flag = isCallTopic(topic) ? "  <-- CALL TOPIC" : "";
      log(`  ${String(count).padStart(8)}  ${topic}${flag}`);
    }
    if (stats.callTopics.size === 0) {
      log("  (no call-signalling topics received during this window)");
    }
    if (stats.timingFields.size > 0) {
      log("");
      log("time/duration-like fields observed:");
      for (const [field, count] of [...stats.timingFields.entries()].sort((a, b) => b[1] - a[1])) {
        log(`  ${String(count).padStart(8)}  ${field}`);
      }
    } else {
      log("");
      log("no duration/elapsed fields found in any payload.");
    }
    log("");
    log(`file: ${writer.file}`);
    log("next: node tools/call-probe/analyze.js " + path.relative(process.cwd(), writer.file));
    log("================================================");
  }

  let shuttingDown = false;
  async function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(tapTimer);
    summarize();
    try {
      await new Promise((resolve) => {
        const done = () => resolve();
        const maybe = emitter.stopListeningAsync ? emitter.stopListeningAsync() : null;
        if (maybe && typeof maybe.then === "function") maybe.then(done).catch(done);
        else {
          emitter.stopListening?.();
          setTimeout(done, 500);
        }
      });
    } catch { }
    await writer.close();
    process.exit(code);
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("unhandledRejection", (err) => {
    log(`unhandled rejection: ${err && (err.message || err)}`, "error");
  });

  if (args.hours) {
    const ms = Math.max(1, Number(args.hours)) * 3600 * 1000;
    log(`will stop automatically in ${args.hours} hour(s)`);
    setTimeout(() => void shutdown(0), ms);
  }

  const hb = setInterval(() => {
    log(
      `heartbeat — raw=${stats.rawMessages} callEvents=${stats.callEvents} records=${writer.records}`
    );
  }, 5 * 60 * 1000);
  hb.unref?.();

  log("listening. Start or join the group call now. Press Ctrl+C to stop.");
  return new Promise(() => { });
}

main()
  .then((code) => {
    // While listening, main() returns a never-settling promise, so this only
    // runs for early-exit paths (bad args, missing appstate, load failure).
    process.exit(typeof code === "number" ? code : 0);
  })
  .catch((err) => {
    process.stderr.write(`probe failed: ${err && (err.stack || err.message || err)}\n`);
    process.exit(1);
  });
