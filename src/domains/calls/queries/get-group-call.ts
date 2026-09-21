import { createLegacyPromise } from "../../../compat/legacy-promise";
import type { NodeStyleCallback } from "../../../compat/callbackify";
import type { FcaContext } from "../../../core/state";
import { postGraphql } from "../../../transport/http/graphql";
import type { GroupCallState } from "../call.types";
import { getTrackedCall, upsertTrackedCall } from "../call-tracker";

export interface GetGroupCallQueryDeps {
  defaultFuncs: {
    post: (url: string, jar: Loose, form?: Record<string, Loose>) => Promise<Loose>;
  };
  ctx: FcaContext & { jar: Loose };
  logError?: (scope: string, error: Loose) => void;
}

function readOngoingCall(payload: Loose): Partial<GroupCallState> | null {
  const thread =
    payload?.data?.message_thread ||
    payload?.data?.node ||
    payload?.data?.viewer?.message_thread ||
    payload?.data;
  const ongoing =
    thread?.ongoing_group_call ||
    thread?.ongoing_call ||
    thread?.group_call ||
    thread?.rtc_call ||
    payload?.data?.ongoing_group_call;
  if (!ongoing) {
    return null;
  }
  const participants = Array.isArray(ongoing.participants)
    ? ongoing.participants.map((entry: Loose) =>
        String(entry?.id || entry?.user_id || entry || "")
      ).filter(Boolean)
    : [];
  return {
    callId: ongoing.id ? String(ongoing.id) : ongoing.call_id ? String(ongoing.call_id) : null,
    isVideo: Boolean(ongoing.is_video || ongoing.video_enabled),
    participants,
    status: "active"
  };
}

export function createGetGroupCallQuery(deps: GetGroupCallQueryDeps) {
  const { defaultFuncs, ctx, logError } = deps;

  return function getGroupCall(
    threadID: string | number,
    callback?: NodeStyleCallback<GroupCallState | null>
  ) {
    const { callback: cb, promise } = createLegacyPromise<GroupCallState | null>(callback);
    const id = String(threadID);

    const tracked = getTrackedCall(ctx, id);
    const form = {
      av: ctx.i_userID || ctx.userID,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "MWChatOngoingGroupCallQuery",
      server_timestamps: true,
      doc_id: "3814968451839732",
      variables: JSON.stringify({
        id,
        thread_id: id,
        threadID: id
      })
    };

    postGraphql({ defaultFuncs, ctx, jar: ctx.jar, form })
      .then((response: Loose) => {
        const ongoing = readOngoingCall(response);
        if (!ongoing) {
          cb(null, tracked);
          return;
        }
        const next = upsertTrackedCall(ctx, {
          threadID: id,
          callId: ongoing.callId ?? tracked?.callId ?? null,
          isVideo: ongoing.isVideo,
          participants: ongoing.participants,
          status: "active",
          source: "graphql"
        });
        cb(null, next);
      })
      .catch((error: Loose) => {
        logError?.("getGroupCall", error);
        cb(null, tracked);
      });

    return promise;
  };
}
