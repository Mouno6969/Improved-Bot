import { createLegacyPromise } from "../../../compat/legacy-promise";
import type { NodeStyleCallback } from "../../../compat/callbackify";
import type { FcaContext } from "../../../core/state";
import { postGraphql } from "../../../transport/http/graphql";
import { publishRealtimeMessage } from "../../../transport/realtime/publish";
import type { LeaveGroupCallResult } from "../call.types";
import { dropTrackedCall, getTrackedCall } from "../call-tracker";

export interface LeaveGroupCallCommandDeps {
  defaultFuncs: {
    post: (url: string, jar: Loose, form?: Record<string, Loose>) => Promise<Loose>;
  };
  ctx: FcaContext & { jar: Loose };
  generateOfflineThreadingID: () => string;
  logError?: (scope: string, error: Loose) => void;
}

export function createLeaveGroupCallCommand(deps: LeaveGroupCallCommandDeps) {
  const { defaultFuncs, ctx, generateOfflineThreadingID, logError } = deps;

  return function leaveGroupCall(
    threadID: string | number,
    callback?: NodeStyleCallback<LeaveGroupCallResult>
  ) {
    const { callback: cb, promise } = createLegacyPromise<LeaveGroupCallResult>(callback);
    const id = String(threadID);

    void (async () => {
      try {
        const current = getTrackedCall(ctx, id);
        const callId = current?.callId || generateOfflineThreadingID();
        const actor = String(ctx.i_userID || ctx.userID || "");

        try {
          await postGraphql({
            defaultFuncs,
            ctx,
            jar: ctx.jar,
            form: {
              av: actor,
              fb_api_caller_class: "RelayModern",
              fb_api_req_friendly_name: "MWChatLeaveGroupRtcCallMutation",
              server_timestamps: true,
              doc_id: "4736058473123669",
              variables: JSON.stringify({
                input: {
                  actor_id: actor,
                  client_mutation_id: Date.now().toString(),
                  thread_id: id,
                  call_id: callId
                }
              })
            }
          });
        } catch (error) {
          logError?.("leaveGroupCall:graphql", error);
        }

        if (ctx.mqttClient) {
          await publishRealtimeMessage({
            client: ctx.mqttClient as Loose,
            topic: "/rtc_multi",
            payload: {
              type: "leave",
              from: actor,
              thread_id: id,
              call_id: callId,
              msg_id: generateOfflineThreadingID(),
              version: 1
            }
          });
        }

        dropTrackedCall(ctx, id);
        cb(null, { success: true, threadID: id, callId, left: true });
      } catch (error) {
        logError?.("leaveGroupCall", error);
        cb(error);
      }
    })();

    return promise;
  };
}
