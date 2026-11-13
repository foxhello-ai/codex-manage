import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DesktopIpcClient } from "./DesktopIpcClient";
import { ModelDomainError } from "../modelErrors";
import { encodeQuestionReply, nativeTurns, pendingDesktopQuestions, type DesktopQuestionsState, type DesktopHistoryPage } from "../../shared/desktopQuestions";
import { toTurn } from "./SessionService";

const LedgerRow = z.object({ threadId: z.string(), turnId: z.string(), questionId: z.string(), answer: z.string(),
  requestId: z.string(), status: z.enum(["accepted", "unknown"]) });
type Submission = z.infer<typeof LedgerRow>;
type Watch = { client: DesktopIpcClient; owner: string; state: Record<string, any> | null; revision: number;
  ready: Promise<void>; timer?: ReturnType<typeof setTimeout>; resyncing: boolean };

export class DesktopQuestionService {
  private watches = new Map<string, Watch>();
  private chains = new Map<string, Promise<unknown>>();
  private ledger: Submission[] = [];
  private loaded: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  constructor(private readonly codexHome: string, private readonly ledgerPath: string,
    private readonly createClient = (path: string) => new DesktopIpcClient(path)) {}

  async read(threadId: string): Promise<DesktopQuestionsState> {
    try {
      await this.load();
      const watch = await this.watch(threadId);
      return this.project(threadId, watch);
    } catch {
      return { available: false, turnId: null, questions: [], submissions: [], reason: "暂时无法连接此会话的桌面；请保持原会话打开。" };
    }
  }
  async readHistory(threadId: string, limit: number): Promise<DesktopHistoryPage | null> {
    try { return this.history(threadId, await this.watch(threadId), limit); }
    catch { return null; }
  }
  submit(threadId: string, turnId: string, questionId: string, answer: string): Promise<DesktopQuestionsState> {
    const prior = this.chains.get(threadId) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(() => this.submitOnce(threadId, turnId, questionId, answer));
    this.chains.set(threadId, result);
    void result.finally(() => { if (this.chains.get(threadId) === result) this.chains.delete(threadId); }).catch(() => {});
    return result;
  }
  dispose(): void { for (const id of [...this.watches.keys()]) this.drop(id); }

  private async submitOnce(threadId: string, turnId: string, questionId: string, answer: string): Promise<DesktopQuestionsState> {
    await this.load();
    const previous = this.ledger.find(row => row.threadId === threadId && row.questionId === questionId);
    if (previous) {
      if (previous.turnId !== turnId || previous.answer !== answer) throw new ModelDomainError("QUESTION_REPLY_CONFLICT", "此问题已经提交过其他答案，请在桌面核对", 409);
      // An uncertain write is never retried automatically, including after restart.
      return this.read(threadId);
    }
    let watch: Watch;
    try { watch = await this.watch(threadId); }
    catch { throw new ModelDomainError("DESKTOP_QUESTION_UNAVAILABLE", "未连接到原桌面，未发送回答", 409); }
    const current = this.project(threadId, watch);
    const question = current.questions.find(row => row.id === questionId);
    if (!question || current.turnId !== turnId) throw new ModelDomainError("DESKTOP_QUESTION_STALE", "问题已回答或已过期，请刷新后查看", 409);
    const requestId = "question-" + createHash("sha256").update(JSON.stringify([threadId, turnId, questionId])).digest("hex");
    const row: Submission = { threadId, turnId, questionId, answer, requestId, status: "unknown" };
    this.ledger.push(row);
    try { await this.save(); }
    catch (error) { this.ledger.splice(this.ledger.indexOf(row), 1); throw error; }
    const text = encodeQuestionReply({ questionItemId: questionId, question: question.title, answer });
    try {
      const response = await watch.client.request("thread-follower-steer-turn", {
        conversationId: threadId, clientUserMessageId: requestId,
        input: [{ type: "text", text, text_elements: [] }],
        restoreMessage: { id: requestId, cwd: watch.state?.cwd ?? null,
          context: { workspaceRoots: watch.state?.cwd ? [watch.state.cwd] : [] } }
      }, 1, watch.owner);
      if (response.resultType === "error") {
        // These are explicit pre-delivery rejections from the owner/router.
        if (/no-client-found|no active turn|not being streamed|not found|request-version-mismatch|no-handler-for-request/.test(response.error ?? "")) {
          this.ledger.splice(this.ledger.indexOf(row), 1); await this.save();
          throw new ModelDomainError("DESKTOP_QUESTION_STALE", "桌面未接受回答，请刷新问题后重试", 409);
        }
      } else if (response.method === "thread-follower-steer-turn" && response.handledByClientId === watch.owner
        && response.result?.result?.turnId === turnId) row.status = "accepted";
    } catch (error) {
      if (error instanceof ModelDomainError) throw error;
      // Transport failures may occur after delivery. Keep unknown; do not queue or replay.
    }
    await this.save();
    return this.project(threadId, watch);
  }
  private project(threadId: string, watch: Watch): DesktopQuestionsState {
    if (!watch.state) return { available: false, turnId: null, questions: [], submissions: [], reason: "正在重新同步桌面问题，请稍候。" };
    let changed = false;
    for (const turn of nativeTurns(watch.state)) for (const item of turn.items ?? []) {
      const accepted = item.type === "userMessage" || (item.type === "steeringUserMessage" && item.status === "accepted");
      const clientId = item.type === "userMessage" ? item.clientId : item.clientUserMessageId;
      if (!accepted || !clientId) continue;
      const row = this.ledger.find(row => row.threadId === threadId && row.requestId === clientId && row.status === "unknown");
      if (row) { row.status = "accepted"; changed = true; }
    }
    if (changed) void this.save().catch(() => {});
    const result = pendingDesktopQuestions(watch.state);
    const history = this.history(threadId, watch, 20);
    return { available: true, ...result,
      ...(history ? { history } : {}),
      submissions: this.ledger.filter(row => row.threadId === threadId && row.turnId === result.turnId)
        .map(row => ({ questionId: row.questionId, status: row.status })) };
  }
  private history(threadId: string, watch: Watch, limit: number): DesktopHistoryPage | null {
    const state = watch.state;
    if (!state || state.id !== threadId) return null;
    // Only a contiguous tail with a real app-server cursor is a history page.
    // Never bridge canonical history gaps or invent a cursor after truncation.
    const canonical = state.turnHistory?.kind === "canonical" ? state.turnHistory.history : null;
    const tail = canonical?.islands?.findLast((island: any) => island.newerBoundary?.status === "exhausted");
    const turns = canonical ? tail?.entries?.map((entry: any) => canonical.entitiesByKey?.[entry.value]) : state.turns;
    const older = canonical ? tail?.olderBoundary : null;
    const nextCursor = canonical ? older?.handle?.cursor : state.turnsPagination?.olderCursor;
    const exhausted = canonical ? older?.status === "exhausted" : state.turnsPagination?.hasLoadedOldest === true;
    if (!Array.isArray(turns) || !turns.length || turns.length > limit || turns.some(turn => !turn || typeof turn.turnId !== "string")
      || (!exhausted && (typeof nextCursor !== "string" || !nextCursor))) return null;
    return { version: `desktop:${watch.owner}:${watch.revision}`, nextCursor: exhausted ? null : nextCursor,
      turns: turns.map((turn, index) => toTurn({
        ...turn, id: turn.turnId.replace(/^turn:/, ""),
        startedAt: typeof turn.turnStartedAtMs === "number" ? turn.turnStartedAtMs / 1000 : null,
        completedAt: turn.status !== "inProgress" && typeof turn.turnStartedAtMs === "number" && typeof turn.durationMs === "number"
          ? (turn.turnStartedAtMs + turn.durationMs) / 1000 : null,
        items: (turn.items ?? []).flatMap((item: any) => {
          if (item.type !== "steeringUserMessage") return [item];
          return item.status === "accepted" ? [{ ...item, type: "userMessage", id: item.serverUserMessageId ?? item.id,
            clientId: item.clientUserMessageId, content: item.input }] : [];
        })
      }, index, threadId)) };
  }
  private async watch(threadId: string): Promise<Watch> {
    let watch = this.watches.get(threadId);
    if (watch) {
      this.touch(threadId, watch); await watch.ready; return watch;
    }
    if (this.watches.size >= 8) throw new Error("桌面订阅数量达到限制");
    const client = this.createClient(join(this.codexHome, "ipc", "ipc.sock"));
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // Attach immediately so an early socket failure cannot become an unhandled rejection.
    void ready.catch(() => {});
    watch = { client, owner: "", state: null, revision: -1, ready, resyncing: false };
    this.watches.set(threadId, watch);
    const selected = watch;
    const timeout = setTimeout(() => { readyReject(new Error("桌面状态同步超时")); this.drop(threadId); }, 8000);
    client.on("disconnected", () => { readyReject(new Error("桌面已断开")); clearTimeout(timeout); this.drop(threadId); });
    client.on("broadcast", message => {
      if (message.method !== "thread-stream-state-changed" || message.version !== 11 || message.sourceClientId !== selected.owner
        || message.params?.conversationId !== threadId || message.params?.hostId !== "local") return;
      const change = message.params.change;
      if (change?.type === "snapshot" && change.conversationState?.id === threadId && Number.isInteger(change.revision)) {
        selected.state = change.conversationState; selected.revision = change.revision; selected.resyncing = false;
        clearTimeout(timeout); readyResolve();
      } else if (change?.type === "patches" && selected.state && change.baseRevision === selected.revision) {
        try { applyDesktopPatches(selected.state, change.patches); selected.revision = change.revision; }
        catch { this.resync(threadId, selected); }
      } else this.resync(threadId, selected);
    });
    try {
      await client.start();
      const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, 1);
      if (owner.resultType !== "success" || owner.method !== "thread-owner-discovery" || typeof owner.handledByClientId !== "string") throw new Error("桌面没有持有此会话");
      selected.owner = owner.handledByClientId;
      client.follow(threadId, selected.owner, true);
      await ready; this.touch(threadId, selected); return selected;
    } catch (error) { clearTimeout(timeout); readyReject(error instanceof Error ? error : new Error(String(error))); this.drop(threadId); throw error; }
  }
  private resync(threadId: string, watch: Watch): void {
    watch.state = null;
    if (watch.resyncing) return;
    watch.resyncing = true;
    try { watch.client.follow(threadId, watch.owner, true); } catch { this.drop(threadId); }
  }
  private touch(threadId: string, watch: Watch): void {
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => this.drop(threadId), 30000); watch.timer.unref();
  }
  private drop(threadId: string): void {
    const watch = this.watches.get(threadId); if (!watch) return;
    this.watches.delete(threadId); clearTimeout(watch.timer);
    try { if (watch.owner) watch.client.follow(threadId, watch.owner, false); } catch {}
    watch.client.close();
  }
  private load(): Promise<void> {
    return this.loaded ??= readFile(this.ledgerPath, "utf8").then(raw => { this.ledger = z.array(LedgerRow).parse(JSON.parse(raw)); })
      .catch(error => { if (error.code !== "ENOENT") { this.loaded = null; throw error; } });
  }
  private save(): Promise<void> {
    const operation = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.ledgerPath), { recursive: true });
      const temporary = `${this.ledgerPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(this.ledger), { mode: 0o600 });
      await rename(temporary, this.ledgerPath);
    });
    this.saving = operation; return operation;
  }
}

export function applyDesktopPatches(state: Record<string, any>, patches: unknown): void {
  if (!Array.isArray(patches)) throw new Error("不支持的桌面增量格式");
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || !patch.path.length || patch.path.some((key: unknown) =>
      (typeof key !== "string" && typeof key !== "number") || ["__proto__", "constructor", "prototype"].includes(String(key)))) throw new Error("无效增量路径");
    let parent: any = state;
    for (const key of patch.path.slice(0, -1)) { parent = parent[key]; if (!parent || typeof parent !== "object") throw new Error("增量基线不匹配"); }
    const key = patch.path.at(-1);
    if (patch.op === "remove") { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else if (patch.op === "add") { if (Array.isArray(parent)) parent.splice(Number(key), 0, patch.value); else parent[key] = patch.value; }
    else if (patch.op === "replace") parent[key] = patch.value;
    else throw new Error("不支持的增量操作");
  }
}
