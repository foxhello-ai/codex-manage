import type { SessionTurn } from "./models";

export type DesktopHistoryPage = { turns: SessionTurn[]; nextCursor: string | null; version: string };
// The desktop async question tool uses correlated user text, not a pending RPC reply.
export type DesktopQuestion = { id: string; title: string; options: string[] };
export type DesktopQuestionsState = {
  available: boolean;
  turnId: string | null;
  questions: DesktopQuestion[];
  submissions: Array<{ questionId: string; status: "accepted" | "unknown" }>;
  reason?: string;
  history?: DesktopHistoryPage;
};
export type QuestionReply = { questionItemId: string; question: string; answer: string };
const start = "<send_user_message_question_reply>";
const end = "</send_user_message_question_reply>";
export function encodeQuestionReply(reply: QuestionReply): string {
  return `${start}\n${JSON.stringify([reply])}\n${end}`;
}
export function parseQuestionReplies(text: string): QuestionReply[] {
  const value = text.trim();
  if (!value.startsWith(start) || !value.endsWith(end)) return [];
  try {
    const parsed: unknown = JSON.parse(value.slice(start.length, -end.length).trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter((row): row is QuestionReply => row && typeof row === "object"
      && typeof row.questionItemId === "string" && typeof row.question === "string" && typeof row.answer === "string");
  } catch { return []; }
}
type RecordValue = Record<string, any>;
export function nativeTurns(state: RecordValue): RecordValue[] {
  if (state.turnHistory?.kind === "canonical") {
    const history = state.turnHistory.history;
    return (history?.islands ?? []).flatMap((island: RecordValue) => (island.entries ?? [])
      .map((entry: RecordValue) => history.entitiesByKey?.[entry.value]).filter(Boolean));
  }
  return Array.isArray(state.turns) ? state.turns : [];
}
export function pendingDesktopQuestions(state: RecordValue): { turnId: string | null; questions: DesktopQuestion[] } {
  const turn = nativeTurns(state).at(-1);
  if (!turn || turn.status !== "inProgress" || typeof turn.turnId !== "string") return { turnId: null, questions: [] };
  const items: RecordValue[] = Array.isArray(turn.items) ? turn.items : [];
  const answered = new Set<string>();
  for (const item of items) {
    if (item.type !== "userMessage" && !(item.type === "steeringUserMessage" && item.status === "accepted")) continue;
    const content = item.type === "userMessage" ? item.content : item.input;
    const text = (Array.isArray(content) ? content : []).filter(row => row.type === "text").map(row => row.text ?? "").join("\n");
    for (const reply of parseQuestionReplies(text)) answered.add(reply.questionItemId);
  }
  const questions = items.flatMap((item): DesktopQuestion[] => item.type === "agentMessage" && typeof item.id === "string" && Array.isArray(item.questions)
    ? item.questions.flatMap((question: RecordValue, index: number) => {
      const id = JSON.stringify(["request_user_input_async", item.id, index]);
      return typeof question?.title === "string" && !answered.has(id) ? [{ id, title: question.title,
        options: Array.isArray(question.options) ? question.options.filter((option: unknown) => typeof option === "string") : [] }] : [];
    }) : []);
  return { turnId: turn.turnId.replace(/^turn:/, ""), questions };
}
