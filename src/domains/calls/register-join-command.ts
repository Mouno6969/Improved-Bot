import { parseCallCommand } from "./join-command";
import type { GroupCallState, JoinGroupCallOptions, JoinGroupCallResult, LeaveGroupCallResult } from "./call.types";

export interface JoinCommandApi {
  joinGroupCall: (
    threadID: string,
    options?: JoinGroupCallOptions
  ) => Promise<JoinGroupCallResult>;
  leaveGroupCall: (threadID: string) => Promise<LeaveGroupCallResult>;
  getGroupCall: (threadID: string) => Promise<GroupCallState | null>;
  sendMessage: (message: string, threadID: string) => Loose;
}

export interface JoinCommandHandlerOptions {
  prefix?: string;
  /** Called instead of sendMessage when set. */
  reply?: (threadID: string, text: string) => Loose | Promise<Loose>;
}

function describeCall(state: GroupCallState | null): string {
  if (!state) {
    return "No active group call in this chat.";
  }
  const n = state.participants.length;
  const media = state.isVideo ? "video" : "audio";
  const seat = state.botJoined ? "I am in the call." : "I am not in the call yet. Send /join.";
  return `Active ${media} group call (${n} participant${n === 1 ? "" : "s"}). ${seat}`;
}

/**
 * Classic listenMqtt helper: if the event is `/join`, `/leave`, or `/call`,
 * run the matching action and reply. Returns true when a command was handled.
 */
export function createJoinCommandHandler(
  api: JoinCommandApi,
  options: JoinCommandHandlerOptions = {}
) {
  const prefix = options.prefix || "/";

  return async function handleJoinCommand(event: {
    type?: string;
    body?: string;
    threadID?: string | number;
  }): Promise<boolean> {
    if (event?.type !== "message" && event?.type !== "message_reply") {
      return false;
    }
    const parsed = parseCallCommand(event.body || "", prefix);
    if (!parsed) {
      return false;
    }
    const threadID = event.threadID == null ? "" : String(event.threadID);
    if (!threadID) {
      return false;
    }

    const reply = async (text: string) => {
      if (options.reply) {
        await options.reply(threadID, text);
        return;
      }
      await api.sendMessage(text, threadID);
    };

    try {
      if (parsed.kind === "join") {
        const result = await api.joinGroupCall(threadID, {
          isVideo: parsed.isVideo,
          mute: parsed.mute,
          startIfMissing: parsed.startIfMissing
        });
        const media = result.isVideo ? "video" : "audio";
        await reply(
          result.started
            ? `Started a ${media} group call and joined.`
            : `Joined the ${media} group call.`
        );
        return true;
      }
      if (parsed.kind === "leave") {
        await api.leaveGroupCall(threadID);
        await reply("Left the group call.");
        return true;
      }
      const state = await api.getGroupCall(threadID);
      await reply(describeCall(state));
      return true;
    } catch (error) {
      const message = error && (error as Error).message ? (error as Error).message : String(error);
      await reply(`Could not handle the call command: ${message}`);
      return true;
    }
  };
}
