import { createJoinGroupCallCommand, type JoinGroupCallCommandDeps } from "./commands/join-group-call";
import { createLeaveGroupCallCommand, type LeaveGroupCallCommandDeps } from "./commands/leave-group-call";
import { createGetGroupCallQuery, type GetGroupCallQueryDeps } from "./queries/get-group-call";
import { getTrackedCall, listTrackedCalls } from "./call-tracker";
import type { FcaContext } from "../../core/state";

export interface CallsDomainDeps {
  join: JoinGroupCallCommandDeps;
  leave: LeaveGroupCallCommandDeps;
  get: GetGroupCallQueryDeps;
}

function compactNamespace(namespace: Record<string, Loose>) {
  return Object.fromEntries(
    Object.entries(namespace).filter(([, value]) => value !== undefined)
  );
}

export function createCallsDomain(deps: CallsDomainDeps) {
  const ctx = deps.join.ctx as FcaContext;
  return compactNamespace({
    join: createJoinGroupCallCommand(deps.join),
    leave: createLeaveGroupCallCommand(deps.leave),
    get: createGetGroupCallQuery(deps.get),
    getActive: (threadID: string | number) => getTrackedCall(ctx, String(threadID)),
    listActive: () => listTrackedCalls(ctx)
  });
}

export * from "./call.types";
export * from "./call-tracker";
export * from "./join-command";
export * from "./parse-rtc";
export * from "./register-join-command";
export * from "./commands/join-group-call";
export * from "./commands/leave-group-call";
export * from "./queries/get-group-call";
