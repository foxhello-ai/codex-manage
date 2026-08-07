import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("parses only the rollout file whose filename matches the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-jsonl-parser-index-"));
    const targetId = "019fda14-8295-7252-be38-ed0795e6502f";
    const otherId = "019fda14-8295-7252-be38-ed0795e65030";
    await writeFile(join(dir, `rollout-2026-08-07T10-36-45-${targetId}.jsonl`), jsonl([
      { type: "session_meta", payload: { id: targetId } },
      {
        type: "response_item",
        timestamp: "2026-08-07T10:36:46Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "target-call",
          arguments: JSON.stringify({ cmd: "npm test", workdir: "/target" })
        }
      }
    ]));
    await writeFile(join(dir, `rollout-2026-08-07T10-36-45-${otherId}.jsonl`), jsonl([
      { type: "session_meta", payload: { id: otherId } },
      "not json",
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "other-call",
          arguments: JSON.stringify({ cmd: "should not parse", workdir: "/other" })
        }
      }
    ]));

    await expect(new JsonlSessionParser(dir).listCommands(targetId)).resolves.toMatchObject({
      commands: [{ callId: "target-call" }],
      diagnostics: {
        scannedFiles: 1,
        parsedLines: 2,
        parseErrors: 0,
        matchedSessionFile: true
      }
    });
  });

  it("reads the last historical model state with malformed-line tolerance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-jsonl-model-state-"));
    await writeFile(join(dir, "session.jsonl"), jsonl([
      {
        type: "session_meta",
        timestamp: "2026-07-19T00:00:00Z",
        payload: { id: "thread-1", model_provider: "custom" }
      },
      {
        type: "turn_context",
        timestamp: "2026-07-19T00:01:00Z",
        payload: { model: "old-model", reasoning_effort: "medium" }
      },
      "not json",
      {
        type: "turn_context",
        timestamp: "2026-07-19T00:02:00Z",
        payload: {
          collaboration_mode: { settings: { model: "gpt-5.6-sol", reasoning_effort: "high" } }
        }
      },
      {
        type: "event_msg",
        timestamp: "2026-07-19T00:03:00Z",
        payload: {
          type: "thread_settings_applied",
          threadSettings: { model: "gpt-5.6-sol", modelProvider: "openai", effort: "xhigh" }
        }
      }
    ]));

    await expect(new JsonlSessionParser(dir).readModelState("thread-1")).resolves.toEqual({
      state: {
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        reasoningEffort: "xhigh",
        updatedAt: "2026-07-19T00:03:00Z"
      },
      diagnostics: {
        scannedFiles: 1,
        parsedLines: 4,
        parseErrors: 1,
        matchedSessionFile: true
      }
    });
  });

  it("returns null model state for a non-matching session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-jsonl-model-empty-"));
    await writeFile(join(dir, "session.jsonl"), jsonl([
      { type: "session_meta", payload: { id: "other" } },
      { type: "turn_context", payload: { model: "other-model" } }
    ]));

    await expect(new JsonlSessionParser(dir).readModelState("thread-1")).resolves.toMatchObject({
      state: { model: null, modelProvider: null, reasoningEffort: null, updatedAt: null },
      diagnostics: { matchedSessionFile: false }
    });
  });

  it("invalidates the model cache when the rollout file grows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-jsonl-model-cache-"));
    const sessionId = "019fda14-8295-7252-be38-ed0795e6502f";
    const file = join(dir, `rollout-2026-08-07T10-36-45-${sessionId}.jsonl`);
    await writeFile(file, jsonl([
      { type: "session_meta", payload: { id: sessionId, model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-5.1", reasoning_effort: "medium" } }
    ]));
    const parser = new JsonlSessionParser(dir);

    await expect(parser.readModelState(sessionId)).resolves.toMatchObject({
      state: { model: "gpt-5.1", reasoningEffort: "medium" }
    });

    await appendFile(file, jsonl([
      { type: "turn_context", payload: { model: "gpt-5.2", reasoning_effort: "high" } }
    ]));

    await expect(parser.readModelState(sessionId)).resolves.toMatchObject({
      state: { model: "gpt-5.2", reasoningEffort: "high" },
      diagnostics: { parsedLines: 3 }
    });
  });

});
