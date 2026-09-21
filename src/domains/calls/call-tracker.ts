import type { FcaContext } from "../../core/state";
import type { GroupCallEvent, GroupCallState } from "./call.types";

const TRACKER_KEY = "_groupCalls";

function now(): number {
  return Date.now();
}

export function getCallTracker(ctx: FcaContext): Map<string, GroupCallState> {
  const existing = ctx[TRACKER_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, GroupCallState>;
  }
  const created = new Map<string, GroupCallState>();
  ctx[TRACKER_KEY] = created;
  return created;
}

export function getTrackedCall(ctx: FcaContext, threadID: string): GroupCallState | null {
  return getCallTracker(ctx).get(String(threadID)) || null;
}

export function upsertTrackedCall(
  ctx: FcaContext,
  patch: Partial<GroupCallState> & { threadID: string }
): GroupCallState {
  const tracker = getCallTracker(ctx);
  const key = String(patch.threadID);
  const previous = tracker.get(key);
  const next: GroupCallState = {
    threadID: key,
    callId: patch.callId ?? previous?.callId ?? null,
    isVideo: patch.isVideo ?? previous?.isVideo ?? false,
    mute: patch.mute ?? previous?.mute ?? true,
    status: patch.status ?? previous?.status ?? "active",
    participants: uniqueIds(patch.participants ?? previous?.participants ?? []),
    botJoined: patch.botJoined ?? previous?.botJoined ?? false,
    started: patch.started ?? previous?.started ?? false,
    startedAt: previous?.startedAt ?? now(),
    updatedAt: now(),
    source: patch.source ?? previous?.source ?? "event"
  };
  tracker.set(key, next);
  return next;
}

export function dropTrackedCall(ctx: FcaContext, threadID: string): GroupCallState | null {
  const tracker = getCallTracker(ctx);
  const key = String(threadID);
  const previous = tracker.get(key) || null;
  if (previous) {
    tracker.delete(key);
  }
  return previous;
}

export function listTrackedCalls(ctx: FcaContext): GroupCallState[] {
  return [...getCallTracker(ctx).values()].filter((call) => call.status !== "ended");
}

export function applyGroupCallEvent(ctx: FcaContext, event: GroupCallEvent): GroupCallState | null {
  if (!event?.threadID) {
    return null;
  }

  const botId = String(ctx.i_userID || ctx.userID || "");
  const participants = uniqueIds(event.participants || []);
  const botJoined = botId ? participants.includes(botId) : false;

  if (event.status === "ended" || event.status === "leave") {
    const current = getTrackedCall(ctx, event.threadID);
    if (!current) {
      return null;
    }
    if (event.status === "ended") {
      return dropTrackedCall(ctx, event.threadID);
    }
    return upsertTrackedCall(ctx, {
      threadID: event.threadID,
      callId: event.callId,
      isVideo: event.isVideo,
      participants,
      botJoined,
      status: current.status === "ringing" ? "ringing" : "active",
      source: "mqtt"
    });
  }

  return upsertTrackedCall(ctx, {
    threadID: event.threadID,
    callId: event.callId,
    isVideo: event.isVideo,
    participants,
    botJoined,
    status: event.status === "join" || event.status === "update" ? "active" : event.status,
    source: "mqtt"
  });
}

function uniqueIds(values: Array<string | number | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }
    seen.add(String(value));
  }
  return [...seen];
}
