import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SessionCommand = {
  id: string;
  callId: string;
  turnId: string | null;
  timestamp: string | null;
  status: "completed" | "running";
  cmd: string;
  workdir: string;
  sandboxPermissions: string | null;
  justification: string | null;
  prefixRule: string[] | null;
  tty: boolean | null;
  yieldTimeMs: number | null;
  maxOutputTokens: number | null;
  output: string | null;
  outputLength: number;
};

export type SessionCommandDiagnostics = {
  scannedFiles: number;
  parsedLines: number;
  parseErrors: number;
  matchedSessionFile: boolean;
};

export type SessionCommandsResult = {
  commands: SessionCommand[];
  diagnostics: SessionCommandDiagnostics;
};

type JsonlRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

type PendingCommand = Omit<SessionCommand, "status" | "output" | "outputLength">;

type CommandOutput = {
  output: string;
};

export class JsonlSessionParser {
  constructor(private readonly sessionsDir: string) {}

  async listCommands(sessionId: string): Promise<SessionCommandsResult> {
    const files = await this.walk(this.sessionsDir);
    const diagnostics: SessionCommandDiagnostics = {
      scannedFiles: files.length,
      parsedLines: 0,
      parseErrors: 0,
      matchedSessionFile: false
    };

    const allCommands: SessionCommand[] = [];

    for (const file of files) {
      const parsed = await this.parseFile(file, diagnostics);
      if (!parsed.sessionIds.has(sessionId)) continue;
      diagnostics.matchedSessionFile = true;
      allCommands.push(...parsed.commands);
    }

    return {
      commands: allCommands.sort((left, right) => compareNullableString(left.timestamp, right.timestamp)),
      diagnostics
    };
  }

  private async parseFile(filePath: string, diagnostics: SessionCommandDiagnostics) {
    const raw = await readFile(filePath, "utf8");
    const sessionIds = new Set<string>();
    const commands = new Map<string, PendingCommand>();
    const outputs = new Map<string, CommandOutput>();

    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;

      let record: JsonlRecord;
      try {
        record = JSON.parse(line) as JsonlRecord;
        diagnostics.parsedLines += 1;
      } catch {
        diagnostics.parseErrors += 1;
        continue;
      }

      const payload = record.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : null;
      const recordType = readString(record.type);
      const payloadType = readString(payload?.type);

      if (recordType === "session_meta" && payload) {
        for (const value of [payload.id, payload.session_id]) {
          const id = readString(value);
          if (id) sessionIds.add(id);
        }
      }

      if (recordType !== "response_item" || !payload) continue;

      if (payloadType === "function_call" && readString(payload.name) === "exec_command") {
        const callId = readString(payload.call_id);
        if (!callId) continue;
        const args = parseArguments(payload.arguments);
        commands.set(callId, {
          id: callId,
          callId,
          turnId: readTurnId(payload),
          timestamp: readString(record.timestamp),
          cmd: readString(args?.cmd) ?? "",
          workdir: readString(args?.workdir) ?? "",
          sandboxPermissions: readString(args?.sandbox_permissions),
          justification: readString(args?.justification),
          prefixRule: readStringArray(args?.prefix_rule),
          tty: readBoolean(args?.tty),
          yieldTimeMs: readNumber(args?.yield_time_ms),
          maxOutputTokens: readNumber(args?.max_output_tokens)
        });
      }

      if (payloadType === "function_call_output") {
        const callId = readString(payload.call_id);
        const output = readStringAllowEmpty(payload.output);
        if (callId && output !== null) {
          outputs.set(callId, { output });
        }
      }
    }

    return {
      sessionIds,
      commands: [...commands.values()].map((command) => {
        const output = outputs.get(command.callId)?.output ?? null;
        return {
          ...command,
          status: output === null ? "running" : "completed",
          output,
          outputLength: output?.length ?? 0
        } satisfies SessionCommand;
      })
    };
  }

  private async walk(dir: string, output: string[] = []): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return output;
      throw error;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(path, output);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        output.push(path);
      }
    }

    return output;
  }
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTurnId(payload: Record<string, unknown>): string | null {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object") return null;
  return readString((metadata as Record<string, unknown>).turn_id);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringAllowEmpty(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null;
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}
