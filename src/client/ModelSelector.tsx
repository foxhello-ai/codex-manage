import { useEffect, useMemo, useState } from "react";
import type { ModelCatalogResponse, ModelOption, SessionModelState, UpdateModelSelectionInput } from "../shared/models";
import { defaultEffortForModel, filterAndSortModels } from "./modelSelection";

type MobileModelMenu = "model" | "effort" | null;

export function ModelSelector({
  open,
  catalog,
  current,
  loading,
  submitting,
  error,
  onClose,
  onRefresh,
  onApply
}: {
  open: boolean;
  catalog: ModelCatalogResponse | null;
  current: SessionModelState;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onApply: (input: UpdateModelSelectionInput) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [effortNotice, setEffortNotice] = useState<string | null>(null);
  const [mobileMenu, setMobileMenu] = useState<MobileModelMenu>(null);
  const models = useMemo(() => filterAndSortModels(catalog?.models ?? [], search), [catalog, search]);
  const selected = catalog?.models.find((model) => model.model === selectedModel) ?? null;

  useEffect(() => {
    if (!open) return;
    const preferred = current.mode === "override" ? current.preferredModel : null;
    const initial = catalog?.models.find((model) => model.model === preferred)
      ?? catalog?.models.find((model) => model.isDefault)
      ?? catalog?.models[0]
      ?? null;
    const previousEffort = current.preferredReasoningEffort ?? current.actualReasoningEffort;
    setSelectedModel(initial?.model ?? null);
    setReasoningEffort(initial ? defaultEffortForModel(initial, previousEffort) : null);
    setEffortNotice(initial && previousEffort && !initial.supportedReasoningEfforts.includes(previousEffort)
      ? `原推理强度 ${previousEffort} 不受支持，已选择 ${initial.defaultReasoningEffort ?? "模型默认值"}。`
      : null);
    setMobileMenu(null);
    setSearch("");
  }, [open, catalog, current.mode, current.preferredModel, current.preferredReasoningEffort, current.actualReasoningEffort]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, submitting, onClose]);

  if (!open) return null;

  function selectModel(model: ModelOption) {
    const previousEffort = reasoningEffort ?? current.actualReasoningEffort;
    setSelectedModel(model.model);
    setReasoningEffort(defaultEffortForModel(model, previousEffort));
    setEffortNotice(previousEffort && !model.supportedReasoningEfforts.includes(previousEffort)
      ? `原推理强度 ${previousEffort} 不受支持，已选择 ${model.defaultReasoningEffort ?? "模型默认值"}。`
      : null);
  }

  function applyMobileModel(model: ModelOption) {
    const nextEffort = defaultEffortForModel(model, reasoningEffort ?? current.actualReasoningEffort);
    setSelectedModel(model.model);
    setReasoningEffort(nextEffort);
    setMobileMenu(null);
    void onApply({ mode: "override", model: model.model, reasoningEffort: nextEffort });
  }

  function applyMobileEffort(nextEffort: string | null) {
    setReasoningEffort(nextEffort);
    setEffortNotice(null);
    setMobileMenu(null);
    if (selectedModel) void onApply({ mode: "override", model: selectedModel, reasoningEffort: nextEffort });
  }

  return (
    <div className="modelSelectorBackdrop" role="presentation" onClick={submitting ? undefined : onClose}>
      <section className="modelSelectorDialog" role="dialog" aria-modal="true" aria-label="切换会话模型" onClick={(event) => event.stopPropagation()}>
        <div className="modelSelectorDesktop">
        <header className="modelSelectorHeader">
          <div>
            <h2 id="model-selector-title">切换会话模型</h2>
            <p>只显示当前 app-server 明确支持的模型</p>
          </div>
          <button className="iconButton" type="button" aria-label="关闭模型选择器" onClick={onClose} disabled={submitting}>×</button>
        </header>

        <div className="modelSelectorToolbar">
          <input aria-label="搜索模型" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模型名称或标识" />
          <button className="ghostButton" type="button" onClick={() => void onRefresh()} disabled={loading || submitting}>{loading ? "刷新中" : "刷新"}</button>
        </div>

        {current.actualModel && current.actualModelSupported === false ? (
          <div className="warning">当前会话模型 <code>{current.actualModel}</code> 不在可选列表，系统不会自动替换。</div>
        ) : null}
        {catalog?.stale ? <div className="warning">正在显示 {catalog.loadedAt} 的缓存模型列表。{catalog.lastError}</div> : null}
        {error ? <div className="errorBanner">{error}</div> : null}
        {effortNotice ? <div className="modelEffortNotice" role="status">{effortNotice}</div> : null}

        <div className="modelSelectorList" role="listbox" aria-label="支持模型">
          {loading && !catalog ? <div className="emptyState">正在读取支持模型...</div> : null}
          {!loading && models.length === 0 ? <div className="emptyState">没有匹配的支持模型</div> : null}
          {models.map((model) => (
            <button
              type="button"
              role="option"
              aria-selected={selectedModel === model.model}
              className={`modelOption${selectedModel === model.model ? " selected" : ""}`}
              key={model.model}
              onClick={() => selectModel(model)}
            >
              <span className="modelOptionTitle">
                <strong>{model.displayName}</strong>
                <span>
                  {model.model === current.actualModel ? <small>当前</small> : null}
                  {model.isDefault ? <small>默认</small> : null}
                </span>
              </span>
              <code title={model.model}>{model.model}</code>
              {model.description ? <p>{model.description}</p> : null}
              {model.supportedReasoningEfforts.length > 0 ? <p className="modelEfforts">推理强度：{model.supportedReasoningEfforts.join(" / ")}</p> : null}
              {model.upgradeCopy ? <p className="modelUpgrade">{model.upgradeCopy}</p> : null}
            </button>
          ))}
        </div>

        <footer className="modelSelectorFooter">
          <label>
            <span>推理强度</span>
            <select
              value={reasoningEffort ?? ""}
              onChange={(event) => {
                setReasoningEffort(event.target.value || null);
                setEffortNotice(null);
              }}
              disabled={!selected || submitting}
            >
              <option value="">不覆盖（使用模型默认值）</option>
              {selected?.supportedReasoningEfforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}
            </select>
          </label>
          <div className="modelSelectorActions">
            <button className="ghostButton" type="button" disabled={submitting} onClick={() => void onApply({ mode: "follow_session" })}>跟随会话</button>
            <button type="button" disabled={!selectedModel || submitting} onClick={() => selectedModel && void onApply({ mode: "override", model: selectedModel, reasoningEffort })}>
              {submitting ? "应用中" : "应用模型"}
            </button>
          </div>
        </footer>
        </div>

        <div className="modelSelectorMobile">
          <header className="modelSelectorMobileHeader">
            <h2 id="model-selector-title-mobile">会话模型</h2>
            <button className="iconButton" type="button" aria-label="关闭模型选择器" onClick={onClose} disabled={submitting}>×</button>
          </header>

          {error ? <div className="modelSelectorMobileMessage errorBanner">{error}</div> : null}
          {effortNotice ? <div className="modelSelectorMobileMessage modelEffortNotice" role="status">{effortNotice}</div> : null}

          <div className="mobileModelMenuRows">
            <button
              className={`mobileModelMenuRow${mobileMenu === "model" ? " active" : ""}`}
              type="button"
              onClick={() => setMobileMenu((currentMenu) => currentMenu === "model" ? null : "model")}
              disabled={submitting}
            >
              <span>模型</span>
              <strong>{selected?.displayName ?? selectedModel ?? "未选择"}</strong>
              <span aria-hidden="true">›</span>
            </button>
            <button
              className={`mobileModelMenuRow${mobileMenu === "effort" ? " active" : ""}`}
              type="button"
              onClick={() => setMobileMenu((currentMenu) => currentMenu === "effort" ? null : "effort")}
              disabled={!selected || submitting}
            >
              <span>推理强度</span>
              <strong>{reasoningEffort ?? "默认"}</strong>
              <span aria-hidden="true">›</span>
            </button>
            <button
              className="mobileModelResetRow"
              type="button"
              disabled={submitting}
              onClick={() => void onApply({ mode: "follow_session" })}
            >
              <span>重置为默认设置</span>
              <span aria-hidden="true">↻</span>
            </button>
          </div>

          {mobileMenu === "model" ? (
            <div className="mobileModelSubmenu" role="listbox" aria-label="支持模型">
              {loading && !catalog ? <div className="emptyState">正在读取支持模型...</div> : null}
              {!loading && models.length === 0 ? <div className="emptyState">没有可用模型</div> : null}
              {models.map((model) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedModel === model.model}
                  className={`mobileModelOption${selectedModel === model.model ? " selected" : ""}`}
                  key={model.model}
                  onClick={() => applyMobileModel(model)}
                  disabled={submitting}
                >
                  <span>
                    <strong>{model.displayName}</strong>
                    <small>{model.model}</small>
                  </span>
                  {model.model === current.actualModel ? <b>当前</b> : model.isDefault ? <b>默认</b> : null}
                </button>
              ))}
            </div>
          ) : null}

          {mobileMenu === "effort" ? (
            <div className="mobileModelSubmenu" role="listbox" aria-label="推理强度选项">
              <button className="mobileModelOption" role="option" aria-selected={!reasoningEffort} type="button" onClick={() => applyMobileEffort(null)} disabled={submitting}>
                <strong>默认</strong>
                {!reasoningEffort ? <b>✓</b> : null}
              </button>
              {selected?.supportedReasoningEfforts.map((effort) => (
                <button className="mobileModelOption" role="option" aria-selected={reasoningEffort === effort} type="button" key={effort} onClick={() => applyMobileEffort(effort)} disabled={submitting}>
                  <strong>{effort}</strong>
                  {reasoningEffort === effort ? <b>✓</b> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
