import type { ParsedCallCommand } from "./call.types";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandBody(text: string, prefix: string, name: string): string | null {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const re = new RegExp(`^${escapeRegex(prefix)}${escapeRegex(name)}(?:\\s+|$)(.*)$`, "i");
  const match = source.match(re);
  return match ? String(match[1] || "").trim() : null;
}

/**
 * Parse `/join`, `/leave` / `/hangup`, and `/call` from a message body.
 * Returns null when the text is not a call command.
 */
export function parseCallCommand(
  text: string,
  prefix = "/"
): ParsedCallCommand | null {
  const joinArgs = commandBody(text, prefix, "join");
  if (joinArgs !== null) {
    const args = joinArgs.toLowerCase();
    return {
      kind: "join",
      isVideo: /\bvideo\b/.test(args),
      mute: !/\bunmute\b/.test(args),
      startIfMissing: !/\bno-?start\b/.test(args)
    };
  }

  if (commandBody(text, prefix, "leave") !== null || commandBody(text, prefix, "hangup") !== null) {
    return { kind: "leave" };
  }

  if (commandBody(text, prefix, "call") !== null) {
    return { kind: "status" };
  }

  return null;
}

export function parseJoinCommand(text: string, prefix = "/") {
  const parsed = parseCallCommand(text, prefix);
  return parsed && parsed.kind === "join" ? parsed : null;
}
