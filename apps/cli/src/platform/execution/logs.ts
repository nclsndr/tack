import { StringDecoder } from "node:string_decoder";
import {
  executionLimits,
  type OperatorRunResult,
  type RunLog,
} from "../../domain/execution/execution-schema.ts";

/**
 * Merges host-observed sources into one bounded sequence and mirrors each retained event to stderr.
 * A script log record is one line, so its mirror ends with a newline; raw stream chunks are mirrored
 * as they arrived. `now` reads the current time in epoch milliseconds for each event's timestamp.
 */
export const makeRunLogs = (mirror: (content: string) => void, now: () => number) => {
  const logs: RunLog[] = [];
  const reasons = new Set<string>();
  let observedBytes = 0;
  let observedEvents = 0;
  let retainedBytes = 0;
  return {
    add: (source: RunLog["source"], content: string) => {
      const bytes = Buffer.from(content);
      observedBytes += bytes.length;
      observedEvents += 1;
      if (logs.length >= executionLimits.logEvents) {
        reasons.add("event_count");
        return;
      }
      if (retainedBytes >= executionLimits.logBytes) {
        reasons.add("total_bytes");
        return;
      }
      if (bytes.length > executionLimits.eventBytes) reasons.add("event_bytes");
      if (bytes.length > executionLimits.logBytes - retainedBytes) reasons.add("total_bytes");
      const retained = bytes.subarray(
        0,
        Math.min(executionLimits.eventBytes, executionLimits.logBytes - retainedBytes),
      );
      retainedBytes += retained.length;
      const text = new StringDecoder("utf8").write(retained);
      logs.push({
        source,
        sequence: logs.length + 1,
        timestamp: new Date(now()).toISOString(),
        content: text,
      });
      mirror(source === "script" && text.endsWith("\n") === false ? `${text}\n` : text);
    },
    truncate: (reason: string) => reasons.add(reason),
    snapshot: (): Pick<OperatorRunResult, "logs" | "logTruncation"> => ({
      logs,
      logTruncation: {
        truncated: reasons.size > 0,
        observedBytes,
        observedEvents,
        reasons: [...reasons],
      },
    }),
  };
};
