export type GroupCallStatus = "ringing" | "active" | "ended";
export type GroupCallSource = "mqtt" | "graphql" | "event" | "command";

export interface JoinGroupCallOptions {
  /** Join with camera advertised. The bot still does not stream media. */
  isVideo?: boolean;
  /** Join muted (default true). */
  mute?: boolean;
  /** Start a group call in this thread if none is active (default true for /join). */
  startIfMissing?: boolean;
}

export interface GroupCallState {
  threadID: string;
  callId: string | null;
  isVideo: boolean;
  mute: boolean;
  status: GroupCallStatus;
  participants: string[];
  botJoined: boolean;
  started: boolean;
  startedAt: number;
  updatedAt: number;
  source: GroupCallSource;
}

export interface GroupCallEvent {
  type: "group_call";
  threadID: string;
  callId: string | null;
  callerID?: string;
  isVideo: boolean;
  isGroup: boolean;
  status: GroupCallStatus | "join" | "leave" | "update";
  participants: string[];
  raw?: Loose;
  timestamp: number;
}

export interface JoinGroupCallResult extends GroupCallState {
  success: true;
  joined: boolean;
}

export interface LeaveGroupCallResult {
  success: true;
  threadID: string;
  callId: string | null;
  left: boolean;
}

export interface ParsedJoinCommand {
  kind: "join";
  isVideo: boolean;
  mute: boolean;
  startIfMissing: boolean;
}

export interface ParsedLeaveCommand {
  kind: "leave";
}

export interface ParsedCallStatusCommand {
  kind: "status";
}

export type ParsedCallCommand =
  | ParsedJoinCommand
  | ParsedLeaveCommand
  | ParsedCallStatusCommand;
