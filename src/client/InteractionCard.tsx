import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ApprovalDecision, ApprovalSummary } from "../shared/models";
import { BottomSheet } from "./BottomSheet";

export function InteractionCard({ approval, onSubmit, onClose, navigation }: {
  approval: ApprovalSummary;
  onSubmit: (approval: ApprovalSummary, decision: ApprovalDecision, answers?: Record<string, string[]>) => Promise<void>;
  onClose: () => void;
  navigation?: ReactNode;
}) {
  const id = useId();
  const customOption = `${id}-custom`;
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => Object.fromEntries(approval.questions.map(question => [question.id, question.defaultValue ?? []])));
  const [customQuestions, setCustomQuestions] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mcp = approval.kind === "mcp_elicitation";
  const unsupported = approval.interactionMode === "unsupported";
  const urlFlow = approval.interactionMode === "url";
  function answer(questionId: string, values: string[]) { setAnswers(current => ({ ...current, [questionId]: values })); }
  async function submit(decision: ApprovalDecision) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSubmit(approval, decision, decision === "accept" ? answers : undefined); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "回答提交失败，请重试"); }
    finally { setBusy(false); }
  }
  function handleSubmit(event: FormEvent) { event.preventDefault(); void submit("accept"); }
  return (
    <BottomSheet title={approval.title} description="会话正在等你回答。关闭后仍会保留问题。" onClose={onClose} busy={busy} className="approvalSheet">
      {navigation}
      {approval.reason ? <p>{approval.reason}</p> : null}
      {unsupported ? <p role="status">此交互需要原客户端提供的界面，请回原客户端处理。这里可以拒绝或取消请求。</p> : null}
      {urlFlow ? <p>请先在<a href={approval.interactionUrl} target="_blank" rel="noopener noreferrer">对应页面</a>完成操作，再回来确认。打开页面不会自动提交或完成此请求。</p> : null}
      <form onSubmit={handleSubmit}>
        <fieldset disabled={busy} className="interactionFields">
          {approval.questions.map((question, index) => {
            const fieldId = `${id}-${index}`;
            const values = answers[question.id] ?? [];
            const value = values[0] ?? "";
            const required = question.required !== false;
            const custom = customQuestions.has(question.id);
            return (
              <div className="sheetField" key={question.id}>
                <label htmlFor={fieldId}>{question.header}{required ? "（必填）" : "（选填）"}</label>
                {question.question ? <p id={`${fieldId}-description`}>{question.question}</p> : null}
                {question.inputType === "multiselect" ? (
                  <select id={fieldId} aria-describedby={question.question ? `${fieldId}-description` : undefined} multiple required={required} value={values} onChange={event => answer(question.id, Array.from(event.target.selectedOptions, option => option.value))}>
                    {question.options?.map(option => <option key={option.value ?? option.label} value={option.value ?? option.label}>{option.label}</option>)}
                  </select>
                ) : question.inputType === "boolean" ? (
                  <select id={fieldId} required={required} value={value} onChange={event => answer(question.id, [event.target.value])}>
                    <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
                  </select>
                ) : question.options?.length ? (
                  <>
                    <select id={fieldId} required={required} value={custom ? customOption : value} onChange={event => {
                      const nextCustom = event.target.value === customOption;
                      setCustomQuestions(current => { const next = new Set(current); nextCustom ? next.add(question.id) : next.delete(question.id); return next; });
                      answer(question.id, nextCustom ? [] : [event.target.value]);
                    }}>
                      <option value="">请选择</option>
                      {question.options.map(option => <option key={option.value ?? option.label} value={option.value ?? option.label}>{option.label}</option>)}
                      {question.isOther ? <option value={customOption}>自行填写</option> : null}
                    </select>
                    {question.options.some(option => option.description) ? <ul className="interactionOptions">{question.options.map(option => <li key={option.label}><strong>{option.label}</strong>{option.description ? `：${option.description}` : ""}</li>)}</ul> : null}
                    {custom ? <input aria-label={`${question.header}：自定义回答`} type={question.isSecret ? "password" : "text"} required={required} value={value} onChange={event => answer(question.id, [event.target.value])} /> : null}
                  </>
                ) : (
                  <input id={fieldId} aria-describedby={question.question ? `${fieldId}-description` : undefined} type={question.isSecret ? "password" : ["number", "integer"].includes(question.inputType ?? "") ? "number" : "text"} step={question.inputType === "integer" ? 1 : "any"} min={question.minimum} max={question.maximum} minLength={question.minLength} maxLength={question.maxLength} required={required} value={value} onChange={event => answer(question.id, [event.target.value])} />
                )}
              </div>
            );
          })}
        </fieldset>
        {error ? <p className="errorText" role="alert">{error}</p> : null}
        <div className="approvalActions">
          {!unsupported ? <button className="primaryButton" type="submit" disabled={busy}>{busy ? "提交中…" : urlFlow ? "已在页面完成，继续" : "提交回答"}</button> : null}
          {mcp ? <><button className="ghostButton" type="button" disabled={busy} onClick={() => void submit("decline")}>拒绝请求</button><button className="ghostButton" type="button" disabled={busy} onClick={() => void submit("cancel")}>取消请求</button></> : null}
          <button className="ghostButton" type="button" disabled={busy} onClick={onClose}>稍后回答</button>
        </div>
      </form>
    </BottomSheet>
  );
}
