import { createLegacyPromise } from "../../../compat/legacy-promise";
import type { NodeStyleCallback } from "../../../compat/callbackify";
import type { FcaContext } from "../../../core/state";
import { postGraphql } from "../../../transport/http/graphql";
import { publishRealtimeMessage } from "../../../transport/realtime/publish";
import type { JoinGroupCallOptions, JoinGroupCallResult } from "../call.types";
import { getTrackedCall, upsertTrackedCall } from "../call-tracker";

export interface JoinGroupCallCommandDeps {
  defaultFuncs: {
    post: (url: string, jar: Loose, form?: Record<string, Loose>) => Promise<Loose>;
  };
  ctx: FcaContext & { jar: Loose };
  generateOfflineThreadingID: () => string;
  logError?: (scope: string, error: Loose) => void;
}

const JOIN_MUTATIONS = [
  { friendly: "MWChatJoinGroupRtcCallMutation", docId: "6809212842473473" },
  { friendly: "useMWChatJoinGroupCallMutation", docId: "5482483941852490" },
  { friendly: "MWPJoinCallMutation", docId: "24125901657718026" }
];

const START_MUTATIONS = [
  { friendly: "MWChatStartGroupRtcCallMutation", docId: "6162019117222410" },
  { friendly: "MWChatAudioOrVideoCallCreateMutation", docId: "4736058473123668" }
];

function actorId(ctx: FcaContext): string {
  return String(ctx.i_userID || ctx.userID || "");
}

function mutationForm(
  ctx: FcaContext,
  spec: { friendly: string; docId: string },
  variables: Record<string, Loose>
) {
  return {
    av: actorId(ctx),
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: spec.friendly,
    server_timestamps: true,
    doc_id: spec.docId,
    variables: JSON.stringify(variables)
  };
}

function graphqlLooksOk(response: Loose): boolean {
  if (!response) {
    return false;
  }
  if (Array.isArray(response.errors) && response.errors.length) {
    return false;
  }
  if (response.error || response.errorSummary) {
    return false;
  }
  return true;
}

async function tryMutations(
  deps: JoinGroupCallCommandDeps,
  specs: Array<{ friendly: string; docId: string }>,
  variables: Record<string, Loose>
): Promise<boolean> {
  for (const spec of specs) {
    try {
      const response = await postGraphql({
        defaultFuncs: deps.defaultFuncs,
        ctx: deps.ctx,
        jar: deps.ctx.jar,
        form: mutationForm(deps.ctx, spec, variables)
      });
      if (graphqlLooksOk(response)) {
        return true;
      }
    } catch (error) {
      deps.logError?.(`joinGroupCall:${spec.friendly}`, error);
    }
  }
  return false;
}

async function publishRtcJoin(
  deps: JoinGroupCallCommandDeps,
  threadID: string,
  callId: string,
  options: Required<Pick<JoinGroupCallOptions, "isVideo" | "mute">>
): Promise<boolean> {
  if (!deps.ctx.mqttClient) {
    return false;
  }
  const body = {
    type: "join",
    from: actorId(deps.ctx),
    thread_id: threadID,
    call_id: callId,
    msg_id: deps.generateOfflineThreadingID(),
    version: 1,
    payload: {
      capabilities: { audio: !options.mute, video: options.isVideo },
      join_muted: options.mute,
      video: options.isVideo
    }
  };
  await publishRealtimeMessage({
    client: deps.ctx.mqttClient as Loose,
    topic: "/rtc_multi",
    payload: body
  });
  try {
    await publishRealtimeMessage({
      client: deps.ctx.mqttClient as Loose,
      topic: "/webrtc",
      payload: { ...body, type: "accept" }
    });
  } catch {
    /* optional 1:1 topic */
  }
  return true;
}

async function publishLsJoin(
  deps: JoinGroupCallCommandDeps,
  threadID: string,
  callId: string,
  options: Required<Pick<JoinGroupCallOptions, "isVideo" | "mute">>
): Promise<boolean> {
  if (!deps.ctx.mqttClient) {
    return false;
  }
  if (typeof deps.ctx.wsReqNumber !== "number") {
    deps.ctx.wsReqNumber = 0;
  }
  const requestId = ++deps.ctx.wsReqNumber;
  await publishRealtimeMessage({
    client: deps.ctx.mqttClient as Loose,
    topic: "/ls_req",
    payload: {
      app_id: "2220391788200892",
      payload: JSON.stringify({
        epoch_id: deps.generateOfflineThreadingID(),
        tasks: [
          {
            failure_count: null,
            label: "130",
            payload: JSON.stringify({
              thread_key: threadID,
              call_id: callId,
              video_enabled: options.isVideo,
              audio_enabled: !options.mute,
              join_muted: options.mute,
              sync_group: 1
            }),
            queue_name: `rtc_join_${threadID}`,
            task_id: requestId
          }
        ],
        version_id: "34195258046739157"
      }),
      request_id: requestId,
      type: 3
    }
  });
  return true;
}

export function createJoinGroupCallCommand(deps: JoinGroupCallCommandDeps) {
  const { ctx, logError } = deps;

  return function joinGroupCall(
    threadID: string | number,
    options?: JoinGroupCallOptions | NodeStyleCallback<JoinGroupCallResult>,
    callback?: NodeStyleCallback<JoinGroupCallResult>
  ) {
    let opts: JoinGroupCallOptions = {};
    let cbArg = callback;
    if (typeof options === "function") {
      cbArg = options;
    } else if (options) {
      opts = options;
    }

    const { callback: cb, promise } = createLegacyPromise<JoinGroupCallResult>(cbArg);
    const id = String(threadID);
    const isVideo = Boolean(opts.isVideo);
    const mute = opts.mute !== false;
    const startIfMissing = opts.startIfMissing !== false;
    const selfId = actorId(ctx);

    void (async () => {
      try {
        if (!id) {
          throw new Error("joinGroupCall: threadID is required");
        }

        const existing = getTrackedCall(ctx, id);
        if (existing?.botJoined && existing.status !== "ended") {
          cb(null, { ...existing, success: true, joined: true });
          return;
        }

        let callId = existing?.callId || deps.generateOfflineThreadingID();
        let started = false;
        const attempts: string[] = [];

        if (!existing && startIfMissing) {
          const startedOk = await tryMutations(deps, START_MUTATIONS, {
            input: {
              actor_id: selfId,
              client_mutation_id: Date.now().toString(),
              thread_id: id,
              video: isVideo,
              audio: true,
              is_video: isVideo
            }
          });
          started = startedOk;
          attempts.push(startedOk ? "graphql:start" : "graphql:start-miss");
        } else if (!existing && !startIfMissing) {
          throw new Error("No active group call in this thread. Start one first, or use /join to create it.");
        }

        const joinVars = {
          input: {
            actor_id: selfId,
            client_mutation_id: Date.now().toString(),
            thread_id: id,
            call_id: callId,
            video_enabled: isVideo,
            audio_enabled: !mute,
            is_video: isVideo,
            video: isVideo,
            mute_audio: mute
          }
        };

        const graphqlJoined = await tryMutations(deps, JOIN_MUTATIONS, joinVars);
        attempts.push(graphqlJoined ? "graphql:join" : "graphql:join-miss");

        let mqttJoined = false;
        try {
          mqttJoined = await publishRtcJoin(deps, id, callId, { isVideo, mute });
          attempts.push("mqtt:rtc_multi");
        } catch (error) {
          logError?.("joinGroupCall:mqtt", error);
          attempts.push("mqtt:rtc_multi-miss");
        }

        try {
          await publishLsJoin(deps, id, callId, { isVideo, mute });
          attempts.push("mqtt:ls");
        } catch (error) {
          logError?.("joinGroupCall:ls", error);
        }

        if (!graphqlJoined && !mqttJoined && !started) {
          throw new Error(
            `Failed to join group call (MQTT may be offline). Tried: ${attempts.join(", ")}`
          );
        }

        const participants = unique([
          ...(existing?.participants || []),
          selfId
        ]);

        const state = upsertTrackedCall(ctx, {
          threadID: id,
          callId,
          isVideo,
          mute,
          status: "active",
          participants,
          botJoined: true,
          started,
          source: "command"
        });

        cb(null, { ...state, success: true, joined: true });
      } catch (error) {
        logError?.("joinGroupCall", error);
        cb(error);
      }
    })();

    return promise;
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
