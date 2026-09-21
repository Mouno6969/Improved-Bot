#!/usr/bin/env node
/**
 * Analyzer for call-probe captures.
 * ---------------------------------------------------------------------------
 * Reads a .jsonl capture produced by probe.js and answers, with evidence:
 *
 *   1. Which MQTT topics actually carried call traffic?
 *   2. What fields did the call payloads contain?
 *   3. Are participant identities recoverable (who joined)?
 *   4. Are join timestamps present?
 *   5. Are LEAVE events or DURATION fields present at all?
 *
 * The final section prints a verdict on whether per-person call durations are
 * computable from the captured data.
 *
 * USAGE
 *   node tools/call-probe/analyze.js capture/call-probe-*.jsonl
 *   node tools/call-probe/analyze.js capture/file.jsonl --report out.md
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DURATION_KEY_RE =
  /duration|elapsed|length_in|call_length|seconds|talk_time|ended_at|started_at|join_time|leave_time/i;
const LEAVE_KEY_RE = /left|leave|disconnect|hangup|hang_up|ended|participant_left|exit/i;
const JOIN_KEY_RE = /join|participant_joined|started|connect/i;
const CALL_TOPIC_RE = /webrtc|rtc|onevc|call|voip/i;
const ID_KEY_RE = /(^|[^a-z])(id|fbid|user|uid|participant|actor|sender|peer|callee|caller)/i;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [], report: null, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--report") args.report = argv[++i];
    else if (t === "--json") args.json = true;
    else if (t === "--verbose") args.verbose = true;
    else if (!t.startsWith("--")) args._.push(t);
  }
  return args;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, "utf8");
  const records = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

/** Collect every leaf path in an object, with the value's primitive preview. */
function collectPaths(value, prefix, out, depth, seen) {
  if (value === null || typeof value !== "object" || depth > 14) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    const label = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") {
      collectPaths(child, label, out, depth + 1, seen);
    } else {
      out.push({ path: label, value: child });
    }
  }
  return out;
}

const ANSWER_NONE = "NONE";
const ANSWER_PARTIAL = "PARTIAL";
const ANSWER_YES = "YES";

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    process.stderr.write("usage: analyze.js <capture.jsonl> [--report out.md]\n");
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`file not found: ${file}\n`);
    process.exit(2);
  }

  const { records, malformed } = readJsonl(file);

  const report = {
    file,
    generatedAt: new Date().toISOString(),
    totalRecords: records.length,
    malformedLines: malformed,
    channels: {},
    topics: {},
    callTopics: {},
    callEvents: [],
    rawCallRecords: [],
    fieldPaths: {},
    timingHits: [],
    leaveHits: [],
    joinHits: [],
    participantIdFields: {},
    eventWindows: []
  };

  for (const record of records) {
    const channel = record.channel || "unknown";
    report.channels[channel] = (report.channels[channel] || 0) + 1;

    if (channel === "raw-mqtt") {
      const topic = record.topic || "?";
      report.topics[topic] = (report.topics[topic] || 0) + 1;
      if (record.callTopic || CALL_TOPIC_RE.test(topic)) {
        report.callTopics[topic] = (report.callTopics[topic] || 0) + 1;
        report.rawCallRecords.push(record);
      }
    }

    if (record.callRelated || channel === "history") {
      report.callEvents.push(record);
    }
  }

  // ---- Field inventory across all call-related payloads -------------------
  const inspectTargets = [
    ...report.callEvents.map((r) => r.event).filter(Boolean),
    ...report.rawCallRecords.map((r) => r.payload).filter(Boolean)
  ];

  for (const target of inspectTargets) {
    const leaves = collectPaths(target, "", [], 0, new WeakSet());
    for (const { path: p, value } of leaves) {
      report.fieldPaths[p] = (report.fieldPaths[p] || 0) + 1;

      // Match on the key name AND on short string values, because the
      // interesting signal often lives in a value, e.g.
      //   logMessageData.type === "participant_joined_group_call"
      //   eventData.event       === "call_ended"
      const valueText =
        typeof value === "string" && value.length <= 160 ? value : "";
      const keyMatch = p;
      const isDuration = DURATION_KEY_RE.test(keyMatch) || DURATION_KEY_RE.test(valueText);
      const isLeave = LEAVE_KEY_RE.test(keyMatch) || LEAVE_KEY_RE.test(valueText);
      const isJoin = JOIN_KEY_RE.test(keyMatch) || JOIN_KEY_RE.test(valueText);

      if (isDuration) {
        report.timingHits.push({ path: p, value, file: path.basename(file) });
      }
      if (isLeave) {
        report.leaveHits.push({ path: p, value });
      }
      if (isJoin) {
        report.joinHits.push({ path: p, value });
      }
      if (ID_KEY_RE.test(path.basename(p)) && (typeof value === "string" || typeof value === "number")) {
        const str = String(value);
        if (/^\d{5,}$/.test(str)) {
          report.participantIdFields[p] = (report.participantIdFields[p] || 0) + 1;
        }
      }
    }
  }

  // ---- Time coverage ------------------------------------------------------
  const times = records
    .map((r) => r.capturedAt)
    .filter(Boolean)
    .map((t) => Date.parse(t))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  if (times.length) {
    report.eventWindows = [
      new Date(times[0]).toISOString(),
      new Date(times[times.length - 1]).toISOString()
    ];
    report.windowMs = times[times.length - 1] - times[0];
  }

  // ---- Verdict ------------------------------------------------------------
  const distinctCallPayloads = inspectTargets.length;
  const hasJoin = report.joinHits.length > 0 || report.callEvents.length > 0;
  const hasLeave = report.leaveHits.length > 0;
  const hasDuration = report.timingHits.length > 0;
  const distinctParticipants = Object.keys(report.participantIdFields).length;

  report.verdict = {
    callTrafficCaptured: distinctCallPayloads > 0,
    distinctCallPayloads,
    joinSignal: hasJoin ? (report.callEvents.length > 0 ? ANSWER_YES : ANSWER_PARTIAL) : ANSWER_NONE,
    leaveSignal: hasLeave ? ANSWER_PARTIAL : ANSWER_NONE,
    durationField: hasDuration ? ANSWER_PARTIAL : ANSWER_NONE,
    participantIds: distinctParticipants > 0 ? ANSWER_PARTIAL : ANSWER_NONE,
    durationsComputable:
      hasJoin && hasLeave ? ANSWER_PARTIAL : ANSWER_NONE,
    note:
      hasJoin && hasLeave
        ? "Both join and leave signals exist — per-person durations can be DERIVED (not read), subject to connection gaps."
        : "Without both a join AND a leave signal, per-person durations cannot be computed. Any figure would be fabricated."
  };

  // ---- Console output -----------------------------------------------------
  const W = (s) => process.stdout.write(`${s}\n`);
  W("");
  W("=========================================================");
  W(" CALL-PROBE ANALYSIS");
  W("=========================================================");
  W(`file:            ${file}`);
  W(`records:         ${report.totalRecords} (${malformed} malformed lines)`);
  W(`channels:        ${JSON.stringify(report.channels)}`);
  if (report.eventWindows.length === 2) {
    W(`capture window:  ${report.eventWindows[0]}  ->  ${report.eventWindows[1]}`);
    W(`                 (${Math.round((report.windowMs || 0) / 1000)}s)`);
  }

  W("");
  W("--- MQTT topics seen ---");
  const topics = Object.entries(report.topics).sort((a, b) => b[1] - a[1]);
  if (!topics.length) W("  (none)");
  for (const [topic, count] of topics) {
    const flag = CALL_TOPIC_RE.test(topic) ? "   <== CALL TOPIC" : "";
    W(`  ${String(count).padStart(8)}  ${topic}${flag}`);
  }

  W("");
  W("--- call-signalling topics with payloads ---");
  const callTopics = Object.entries(report.callTopics).sort((a, b) => b[1] - a[1]);
  if (!callTopics.length) {
    W("  NONE — no /webrtc, /rtc_multi, /onevc or /webrtc_response traffic arrived.");
  }
  for (const [topic, count] of callTopics) W(`  ${String(count).padStart(8)}  ${topic}`);

  W("");
  W("--- call-related normalised events ---");
  W(`  count: ${report.callEvents.length}`);
  for (const rec of report.callEvents.slice(0, 25)) {
    const ev = rec.event || {};
    W(`  [${rec.channel}] ${rec.callReason || ev.logMessageType || ev.eventType || "?"}`);
    W(`      thread=${ev.threadID || "?"} at=${rec.capturedAt}`);
    if (ev.logMessageData) {
      W(`      logMessageData keys: ${Object.keys(ev.logMessageData).join(", ") || "(empty)"}`);
    }
    if (ev.eventData) {
      W(`      eventData keys: ${Object.keys(ev.eventData).join(", ") || "(empty)"}`);
    }
  }
  if (report.callEvents.length > 25) {
    W(`  …and ${report.callEvents.length - 25} more (see --report output)`);
  }

  W("");
  W("--- field inventory (call payloads) ---");
  const fields = Object.entries(report.fieldPaths).sort((a, b) => b[1] - a[1]);
  if (!fields.length) W("  (no call payloads to inspect)");
  for (const [p, count] of fields.slice(0, 60)) W(`  ${String(count).padStart(6)}  ${p}`);
  if (fields.length > 60) W(`  …and ${fields.length - 60} more`);

  W("");
  W("--- signal search ---");
  W(`  join-like keys:     ${report.joinHits.length ? report.joinHits.slice(0, 8).map((h) => h.path).join(", ") : "NONE"}`);
  W(`  leave-like keys:    ${report.leaveHits.length ? report.leaveHits.slice(0, 8).map((h) => h.path).join(", ") : "NONE"}`);
  W(`  duration-like keys: ${report.timingHits.length ? report.timingHits.slice(0, 8).map((h) => `${h.path}=${h.value}`).join(", ") : "NONE"}`);
  W(`  participant-ID fields: ${distinctParticipants ? Object.keys(report.participantIdFields).slice(0, 8).join(", ") : "NONE"}`);

  W("");
  W("=========================================================");
  W(" VERDICT");
  W("=========================================================");
  W(`  Call traffic captured?      ${report.verdict.callTrafficCaptured ? "YES" : "NO"}`);
  W(`  Who joined recoverable?     ${report.verdict.joinSignal}`);
  W(`  Who LEFT recoverable?       ${report.verdict.leaveSignal}`);
  W(`  Duration field present?     ${report.verdict.durationField}`);
  W(`  Per-person durations?       ${report.verdict.durationsComputable}`);
  W("");
  W(`  ${report.verdict.note}`);
  W("=========================================================");
  W("");

  // ---- Markdown report ----------------------------------------------------
  if (args.report) {
    const lines = [];
    lines.push("# Call-probe analysis");
    lines.push("");
    lines.push(`- **Capture:** \`${file}\``);
    lines.push(`- **Generated:** ${report.generatedAt}`);
    lines.push(`- **Records:** ${report.totalRecords} (${malformed} malformed)`);
    if (report.eventWindows.length === 2) {
      lines.push(`- **Window:** ${report.eventWindows[0]} → ${report.eventWindows[1]}`);
    }
    lines.push("");
    lines.push("## Verdict");
    lines.push("");
    lines.push("| Question | Result |");
    lines.push("|---|---|");
    lines.push(`| Call traffic captured | ${report.verdict.callTrafficCaptured ? "YES" : "NO"} |`);
    lines.push(`| Who joined recoverable | ${report.verdict.joinSignal} |`);
    lines.push(`| Who left recoverable | ${report.verdict.leaveSignal} |`);
    lines.push(`| Duration field present | ${report.verdict.durationField} |`);
    lines.push(`| **Per-person durations computable** | **${report.verdict.durationsComputable}** |`);
    lines.push("");
    lines.push(`> ${report.verdict.note}`);
    lines.push("");
    lines.push("## MQTT topics seen");
    lines.push("");
    lines.push("| Count | Topic | Call topic |");
    lines.push("|---|---|---|");
    for (const [topic, count] of topics) {
      lines.push(`| ${count} | \`${topic}\` | ${CALL_TOPIC_RE.test(topic) ? "yes" : ""} |`);
    }
    lines.push("");
    lines.push("## Call-related events");
    lines.push("");
    if (!report.callEvents.length) {
      lines.push("_None captured._");
    } else {
      lines.push("| Channel | Reason | Thread | Captured at |");
      lines.push("|---|---|---|---|");
      for (const rec of report.callEvents) {
        const ev = rec.event || {};
        lines.push(
          `| ${rec.channel} | ${rec.callReason || ev.logMessageType || ev.eventType || "?"} | ${
            ev.threadID || "?"
          } | ${rec.capturedAt} |`
        );
      }
    }
    lines.push("");
    lines.push("## Field inventory");
    lines.push("");
    lines.push("| Count | Path |");
    lines.push("|---|---|");
    for (const [p, count] of fields) lines.push(`| ${count} | \`${p}\` |`);
    lines.push("");
    lines.push("## Signal search");
    lines.push("");
    lines.push(`- **join-like keys:** ${report.joinHits.length ? report.joinHits.map((h) => `\`${h.path}\``).join(", ") : "NONE"}`);
    lines.push(`- **leave-like keys:** ${report.leaveHits.length ? report.leaveHits.map((h) => `\`${h.path}\``).join(", ") : "NONE"}`);
    lines.push(`- **duration-like keys:** ${report.timingHits.length ? report.timingHits.map((h) => `\`${h.path}\` = ${h.value}`).join(", ") : "NONE"}`);
    lines.push("");
    const reportPath = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${lines.join("\n")}\n`);
    W(`markdown report written to ${reportPath}`);
  }

  if (args.json) {
    // Keep generated reports out of tracked directories: default to the same
    // directory as --report, otherwise a local capture/ folder.
    const baseDir = args.report
      ? path.dirname(path.resolve(args.report))
      : path.join(__dirname, "..", "..", "capture");
    fs.mkdirSync(baseDir, { recursive: true });
    const jsonPath = path.join(
      baseDir,
      `${path.basename(file).replace(/\.jsonl$/, "")}.analysis.json`
    );
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    W(`json report written to ${jsonPath}`);
  }

  return 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`analyze failed: ${err && (err.stack || err.message || err)}\n`);
  process.exit(1);
}
