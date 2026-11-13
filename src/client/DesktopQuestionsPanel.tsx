import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../shared/api";
import type { DesktopQuestionsState, DesktopHistoryPage } from "../shared/desktopQuestions";
import type { ApprovalSummary } from "../shared/models";
import { InteractionCard } from "./InteractionCard";

export function DesktopQuestionsPanel({ sessionId, showUnavailable = false, onHistory }: {
  sessionId: string; showUnavailable?: boolean; onHistory?: (history: DesktopHistoryPage) => void;
}) {
  const [state, setState] = useState<DesktopQuestionsState | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const historyCallback = useRef(onHistory);
  historyCallback.current = onHistory;
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/desktop-questions`;
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setState(null); setNotice(null); setOpen(false); setSelectedId(null);
    async function poll() {
      const version = generation.current;
      try {
        const next = await apiRequest<DesktopQuestionsState>(endpoint, { signal: controller.signal });
        if (!stopped && version === generation.current) {
          setState(next);
          if (next.available && next.history) historyCallback.current?.(next.history);
        }
      } catch {
        if (!stopped && version === generation.current) setState({ available: false, turnId: null, questions: [], submissions: [], reason: "桌面问题暂时无法同步，请稍候。" });
      } finally { if (!stopped) timer = setTimeout(() => void poll(), 3000); }
    }
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); generation.current++; };
  }, [endpoint]);
  const questions = state?.questions.filter(question => !state.submissions.some(row => row.questionId === question.id)) ?? [];
  const question = questions.find(row => row.id === selectedId) ?? questions[0];
  useEffect(() => { setOpen(Boolean(question)); }, [question?.id]);
  const uncertain = state?.submissions.some(row => row.status === "unknown");
  if (!question && !uncertain && (!showUnavailable || state?.available !== false) && !notice) return null;
  const approval: ApprovalSummary | null = question && state?.turnId ? {
    id: question.id, requestId: question.id, threadId: sessionId, turnId: state.turnId, itemId: null,
    kind: "tool_user_input", status: "pending", title: "桌面提问", command: null, cwd: null, reason: null,
    createdAt: "", resolvedAt: null, raw: {},
    questions: [{ id: question.id, header: "你的回答", question: question.title, isOther: true, isSecret: false,
      options: question.options.map(label => ({ label, description: "" })), maxLength: 4000 }]
  } : null;
  return <section className="approvalPanel" aria-label="桌面途中提问">
    {question ? <button className="approvalTrigger" type="button" onClick={() => setOpen(true)}>
      <span aria-hidden="true">?</span><span><strong>桌面有 {questions.length} 个问题可回答</strong><small>{question.title}</small></span><span aria-hidden="true">›</span>
    </button> : null}
    {showUnavailable && state?.available === false ? <p role="status">{state.reason}</p> : null}
    {uncertain ? <p role="status">回答结果待桌面确认，请勿重复提交。可到桌面核对。</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {open && approval ? <InteractionCard key={approval.id} approval={approval} onClose={() => setOpen(false)}
      description="选择一个选项或自行填写，回答会提交给桌面当前任务。"
      navigation={questions.length > 1 ? <label className="sheetField">待回答问题<select value={question.id} onChange={event => setSelectedId(event.target.value)}>{questions.map((row, index) => <option value={row.id} key={row.id}>{index + 1}. {row.title}</option>)}</select></label> : undefined}
      onSubmit={async (_approval, _decision, answers) => {
        generation.current++;
        const next = await apiRequest<DesktopQuestionsState>(endpoint, { method: "POST", body: JSON.stringify({
          turnId: approval.turnId, questionId: approval.id, answer: answers?.[approval.id]?.[0] ?? ""
        }) });
        generation.current++;
        setState(next);
        if (next.available && next.history) historyCallback.current?.(next.history);
        setNotice(next.submissions.some(row => row.questionId === approval.id && row.status === "accepted") ? "回答已提交给桌面当前任务。" : null);
        setOpen(false);
      }} /> : null}
  </section>;
}
