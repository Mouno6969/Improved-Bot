import type { GroupCallEvent, GroupCallStatus } from "./call.types";

function asRecord(value: Loose): Record<string, Loose> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Loose>)
    : null;
}

function pickString(...values: Loose[]): string | null {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    return String(value);
  }
  return null;
}

function pickIds(...groups: Loose[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const entry of group) {
      const record = asRecord(entry);
      const id = record
        ? pickString(
            record.id,
            record.user_id,
            record.userId,
            record.participant_id,
            record.fbid
          )
        : pickString(entry);
      if (id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function normalizeStatus(raw: Loose): GroupCallEvent["status"] {
  const value = String(raw || "").toLowerCase();
  if (/(end|hangup|hang_up|terminate|dismiss)/.test(value)) {
    return "ended";
  }
  if (/(leave|left|exit)/.test(value)) {
    return "leave";
  }
  if (/(join|joined|accept|answer)/.test(value)) {
    return "join";
  }
  if (/(ring|incoming|offer|invite)/.test(value)) {
    return "ringing";
  }
  if (/(update|ice|candidate|state)/.test(value)) {
    return "update";
  }
  return "active";
}

/**
 * Normalize MQTT payloads from /webrtc, /rtc_multi, /onevc, /webrtc_response.
 */
export function formatRtcMessage(
  topic: string,
  payload: Loose,
  ctx?: { userID?: string; i_userID?: string }
): GroupCallEvent | null {
  const root = asRecord(payload);
  if (!root) {
    return null;
  }

  const nested = asRecord(root.payload) || asRecord(root.data) || asRecord(root.message) || {};
  const threadID = pickString(
    root.thread_id,
    root.threadID,
    root.thread_fbid,
    root.to,
    nested.thread_id,
    nested.threadID,
    nested.thread_key,
    nested.threadKey?.threadFbId,
    nested.threadKey?.thread_fbid
  );
  const callId = pickString(
    root.call_id,
    root.callId,
    root.conference_name,
    nested.call_id,
    nested.callId,
    nested.server_info_data
  );
  const callerID = pickString(
    root.from,
    root.caller_id,
    root.sender,
    nested.from,
    nested.caller_id,
    nested.initiator_id
  );

  if (!threadID && !callId && !callerID) {
    return null;
  }

  const typeToken = pickString(root.type, root.event, root.action, nested.type, topic) || "";
  const participants = [...new Set(pickIds(
    root.participants,
    nested.participants,
    root.users,
    nested.users,
    callerID ? [callerID] : []
  ))];

  const isVideo = Boolean(
    root.video ??
      root.is_video ??
      root.has_video ??
      nested.video ??
      nested.is_video ??
      /video/i.test(typeToken)
  );

  const resolvedThread = String(threadID || callerID || "");
  if (!resolvedThread) {
    return null;
  }

  const selfId = String(ctx?.i_userID || ctx?.userID || "");
  const isGroup = resolvedThread !== selfId && resolvedThread !== callerID;

  return {
    type: "group_call",
    threadID: resolvedThread,
    callId,
    callerID: callerID || undefined,
    isVideo,
    isGroup,
    status: normalizeStatus(typeToken) as GroupCallStatus | "join" | "leave" | "update",
    participants,
    raw: payload,
    timestamp: Date.now()
  };
}

export function formatCallLogEvent(fmtMsg: Loose): GroupCallEvent | null {
  if (!fmtMsg || fmtMsg.logMessageType !== "log:thread-call") {
    return null;
  }

  const data = asRecord(fmtMsg.logMessageData) || {};
  const threadID = pickString(fmtMsg.threadID);
  if (!threadID) {
    return null;
  }

  const eventType = pickString(data.event, data.type, fmtMsg.eventType, data.call_type);
  const participants = pickIds(
    data.participant_ids,
    data.participants,
    data.added_participants,
    fmtMsg.participantIDs,
    fmtMsg.author ? [fmtMsg.author] : []
  );

  return {
    type: "group_call",
    threadID,
    callId: pickString(data.call_id, data.callId, data.server_info_data),
    callerID: pickString(fmtMsg.author, data.caller_id),
    isVideo: /video/i.test(String(eventType || data.video || "")),
    isGroup: true,
    status: normalizeStatus(eventType || data.event),
    participants,
    raw: fmtMsg,
    timestamp: Number(fmtMsg.timestamp) || Date.now()
  };
}
