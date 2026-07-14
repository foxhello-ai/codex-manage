import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSessionParser } from "./JsonlSessionParser";

function jsonl(records: unknown[]): string {
  return records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n") + "\n";
}


describe("JsonlSessionParser", () => {
  it("parses exec_command calls and outputs for a session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-jsonl-parser-"));
    const nested = join(dir, "2026", "07", "14");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "session.jsonl"),
      jsonl([
        { type: "session_meta", timestamp: "2026-07-14T00:00:00Z", payload: { id: "thread-1", session_id: "session-1" } },
        {
          type: "response_item",
          timestamp: "2026-07-14T00:00:01Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            arguments: JSON.stringify({
              cmd: "npm test",
              workdir: "/workspace/app",
              sandbox_permissions: "require_escalated",
              justification: "run tests",
              prefix_rule: ["npm", "test"],
              yield_time_ms: 30000,
              max_output_tokens: 12000
            })
          }
        },
        {
          type: "response_item",
          timestamp: "2026-07-14T00:00:02Z",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "passed",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" }
          }
        },
        {
          type: "response_item",
          timestamp: "2026-07-14T00:00:03Z",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-2",
            arguments: JSON.stringify({ cmd: "long task", workdir: "/workspace/app", yield_time_ms: 1, max_output_tokens: 1 })
          }
        },
        "not json"
      ])
    );

    const result = await new JsonlSessionParser(dir).listCommands("thread-1");

    expect(result.diagnostics).toEqual({
      scannedFiles: 1,
      parsedLines: 4,
      parseErrors: 1,
      matchedSessionFile: true
    });
    expect(result.commands).toMatchObject([
      {
        callId: "call-1",
        turnId: "turn-1",
        status: "completed",
        cmd: "npm test",
        workdir: "/workspace/app",
        sandboxPermissions: "require_escalated",
        justification: "run tests",
        prefixRule: ["npm", "test"],
        output: "passed",
        outputLength: 6
      },
      {
        callId: "call-2",
        status: "running",
        output: null,
        outputLength: 0
      }
    ]);
  });

  it("returns empty commands when no session file matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-jsonl-parser-empty-"));
    await writeFile(join(dir, "session.jsonl"), jsonl([{ type: "session_meta", payload: { id: "other" } }]));

    await expect(new JsonlSessionParser(dir).listCommands("thread-1")).resolves.toMatchObject({
      commands: [],
      diagnostics: {
        scannedFiles: 1,
        matchedSessionFile: false
      }
    });
  });
});
