// Run with: node --import tsx scripts/research/desktop-async-question-read.mjs THREAD_ID
// Read-only: prints counts/timing, never raw history/questions/credentials or answers.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopQuestionService } from "../../src/server/services/DesktopQuestionService.ts";

const threadId = process.argv[2];
if (!threadId) throw new Error("Supply the desktop conversation ID explicitly");
const service = new DesktopQuestionService(process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  join(tmpdir(), `desktop-read-only-${randomUUID()}.json`));
try {
  const started = performance.now();
  const state = await service.read(threadId);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), available: state.available,
    elapsedMs: Math.round(performance.now() - started), activeTurn: Boolean(state.turnId),
    pendingQuestions: state.questions.length, nativeReplySent: false, desktopStartupModified: false }, null, 2));
  if (!state.available) process.exitCode = 1;
} finally { service.dispose(); }
