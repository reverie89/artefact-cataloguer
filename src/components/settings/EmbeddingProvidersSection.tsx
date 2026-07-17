import { useEffect, useRef } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Plus, Wifi, XCircle } from "lucide-react";
import type { AppActions } from "../../app/actions";
import { embeddingProviderDraftFromSettings, type AppState, type EmbeddingProviderDraft } from "../../app/state";
import { fieldsDiffer } from "../../app/drafts";
import type { EmbeddingApiFormat, EmbeddingProvider } from "../../app/types";
import { embeddingProviderEndpoints } from "../../lib/ai";
import { CardActions } from "./CardActions";
import { Field, FieldSelect, FieldSelectOption, Segmented } from "./FormControls";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { StatusIndicator } from "./SaveActions";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** True when a single draft entry differs from its persisted embedding
 *  provider — drives the per-row "unsaved" badge. Mirrors entryDiffers in
 *  ProvidersTab.tsx. */
function entryDiffers(e: EmbeddingProviderDraft["providers"][number], p: EmbeddingProvider): boolean {
  return fieldsDiffer(
    e,
    {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      apiFormat: (p.apiFormat ?? "openai") as EmbeddingApiFormat,
      supportsImageInput: p.supportsImageInput ?? false,
      modelOptions: p.modelOptions ?? [],
      dimensions: p.dimensions ?? null,
      connStatus: p.connStatus ?? "untested",
    },
    ["name", "baseUrl", "apiKey", "model", "apiFormat", "supportsImageInput", "modelOptions", "dimensions", "connStatus"],
  );
}

/** Embedding-model provider list, rendered as a second card-list within the
 *  same "ai" tab, below the chat ProvidersTab. Structurally a near-copy of
 *  ProvidersTab.tsx — same draft/save/discard shape — since embeddings may run
 *  on a completely different vendor/endpoint than chat+vision. */
export function EmbeddingProvidersSection({ state, actions }: Props) {
  const { settings, showEmbProvKey } = state;
  const live = state.embProviderDraft ?? embeddingProviderDraftFromSettings(settings);

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevCountRef = useRef(live.providers.length);
  useEffect(() => {
    const grew = live.providers.length > prevCountRef.current;
    prevCountRef.current = live.providers.length;
    if (!grew) return;
    const last = live.providers[live.providers.length - 1];
    const node = last ? cardRefs.current[last.id] : null;
    const t = setTimeout(() => node?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    return () => clearTimeout(t);
  }, [live.providers]);

  const GRID = "grid grid-cols-[1fr_1fr_120px_104px] gap-2.5 px-3.5";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Configure the models used to embed vocabulary terms and, at parse time, artefact descriptions/images for shortlisted
        retrieval. Embeddings can run on a different vendor than the AI Provider above — e.g. a local model here alongside a
        hosted chat/vision provider.
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("bg-muted/30 border-b py-1.75", GRID)}>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em] flex items-center gap-1.5">
            Provider <Badge variant="outline" className="text-[10px]">Embedding</Badge>
          </span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Model</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Status</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Active</span>
        </div>

        {live.providers.map((entry) => {
          const isActive = entry.id === live.activeProvider;
          const saved = settings.embeddingProviders.find((p) => p.id === entry.id);
          const cardDirty = !!state.embProviderDraft && (
            !saved || entryDiffers(entry, saved) || (isActive && settings.activeEmbeddingProvider !== entry.id)
          );
          const transient = state.embProvStatus[entry.id]?.test ?? null;
          const testStatus = transient ?? (entry.connStatus === "untested" ? null : entry.connStatus);
          return (
            <EmbeddingProviderRow
              key={entry.id}
              entry={entry}
              grid={GRID}
              testStatus={testStatus}
              showEmbProvKey={showEmbProvKey}
              isActive={isActive}
              dirty={cardDirty}
              cardStatus={state.embProvCardSaveStatus[entry.id] ?? null}
              cardError={state.embProvCardError[entry.id]}
              expanded={!!state.embProviderExpanded[entry.id]}
              cardRef={(node) => { cardRefs.current[entry.id] = node; }}
              actions={actions}
            />
          );
        })}

        {live.providers.length === 0 && (
          <div className="text-muted-foreground p-5 text-center text-[15px]">
            No embedding providers configured. Vocabulary sources will fall back to full-list prompts until one is added.
          </div>
        )}
      </Card>

      <Button onClick={actions.startAddEmbProv} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add Embedding Provider</span>
      </Button>
    </div>
  );
}

interface RowProps {
  entry: EmbeddingProviderDraft["providers"][number];
  grid: string;
  testStatus: "testing" | "ok" | "err" | null;
  showEmbProvKey: boolean;
  isActive: boolean;
  dirty: boolean;
  cardStatus: SaveState;
  cardError?: string;
  expanded: boolean;
  cardRef?: (node: HTMLDivElement | null) => void;
  actions: AppActions;
}

function EmbeddingProviderRow({ entry, grid, testStatus, showEmbProvKey, isActive, dirty, cardStatus, cardError, expanded, cardRef, actions }: RowProps) {
  const modelOptions = entry.modelOptions.includes(entry.model) || !entry.model ? entry.modelOptions : [entry.model, ...entry.modelOptions];
  const modelsReady = modelOptions.length > 0;
  const id = entry.id;
  const nameDisplay = entry.name || "Untitled provider";

  return (
    <div ref={cardRef} className="border-border/60 border-b">
      <div onClick={() => actions.toggleEmbProv(id)} className={cn("grid cursor-pointer items-center py-2.25", grid)}>
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown className="text-muted-foreground size-3" /> : <ChevronRight className="text-muted-foreground size-3" />}
          {expanded ? (
            <Input
              value={entry.name}
              onChange={(e) => actions.setEmbProvF(id, "name", e)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Provider name"
              aria-label="Provider name"
              className="h-7 min-w-0"
            />
          ) : (
            <>
              <span className="truncate text-[15px] font-semibold">{nameDisplay}</span>
              {dirty && <Badge variant="secondary" className="font-semibold text-amber-600 dark:text-amber-400">Unsaved</Badge>}
            </>
          )}
        </div>
        <span className="text-muted-foreground truncate text-sm">{entry.model || "—"}</span>
        <StatusBadge status={testStatus} />
        <div onClick={(e) => e.stopPropagation()}>
          {isActive ? (
            <Badge variant="default" className="w-fit tracking-[0.04em]">Active</Badge>
          ) : (
            <Button onClick={() => actions.setActiveEmbProv(id)} variant="outline" size="sm">Set Active</Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <Field
            label="Base URL"
            desc="The full embeddings endpoint for this provider — requests are posted here directly, so it must include any provider-specific path (e.g. /embeddings, /embed). /models is appended only to look up available models."
            hint={entry.baseUrl.trim() ? (
              <>POST <code className="text-foreground">{embeddingProviderEndpoints(entry).embeddings}</code></>
            ) : undefined}
          >
            <Input value={entry.baseUrl} onChange={(e) => actions.setEmbProvF(id, "baseUrl", e)} placeholder="https://api.openai.com/v1/embeddings" />
          </Field>

          <FieldSelect
            label="API Format"
            value={entry.apiFormat}
            onChange={(v) => actions.setEmbProvApiFormat(id, v as EmbeddingApiFormat)}
            hint="Anthropic has no embeddings API, so only OpenAI- and Gemini-shaped endpoints are supported here."
          >
            <FieldSelectOption value="openai">OpenAI</FieldSelectOption>
            <FieldSelectOption value="gemini">Gemini</FieldSelectOption>
          </FieldSelect>

          <Field label="API Key">
            <div className="flex gap-1.5">
              <Input type={showEmbProvKey ? "text" : "password"} value={entry.apiKey} onChange={(e) => actions.setEmbProvF(id, "apiKey", e)} placeholder="sk-…" />
              <Button
                onClick={actions.toggleEmbProvKey}
                variant="outline"
                size="icon"
                title={showEmbProvKey ? "Hide key" : "Reveal key"}
                className="h-9"
              >
                {showEmbProvKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
            </div>
          </Field>

          <Field
            label="Supports image input?"
            desc="Whether this model accepts image input, for the parse-time image-embedding step. Vocabulary terms are always embedded with this same model, so image-based retrieval only works when it's genuinely multimodal (e.g. CLIP-family, Voyage multimodal-3, Cohere embed-v4) — a text-only model rejects the image call and the pipeline falls back to text-only automatically."
          >
            <Segmented
              value={entry.supportsImageInput ? "yes" : "no"}
              onChange={(v) => { if ((v === "yes") !== entry.supportsImageInput) actions.toggleEmbProvSupportsImage(id); }}
              options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
            />
          </Field>

          <div className="flex items-center justify-start gap-2.5">
            <Button onClick={() => void actions.testEmbConn(id)} variant="secondary" size="sm">
              {testStatus === "testing" ? <Loader2 className="size-3 animate-spin" /> : <Wifi className="size-3" />}
              <span>{testStatus === "testing" ? "Testing…" : "Test Connection"}</span>
            </Button>
            <ConnectionStatus status={testStatus} dimensions={entry.dimensions} />
          </div>

          <FieldSelect
            label="Model"
            value={entry.model}
            onChange={(v) => actions.setEmbProvModel(id, v)}
            disabled={!modelsReady}
            ariaLabel="Model"
            placeholder={modelsReady ? (entry.model ? undefined : "Select a model…") : "Available after Test Connection"}
          >
            {modelOptions.map((m) => (
              <FieldSelectOption key={m} value={m}>{m}</FieldSelectOption>
            ))}
          </FieldSelect>

          <CardActions
            dirty={dirty}
            status={cardStatus}
            errorMessage={cardError}
            onSave={() => void actions.saveEmbProvCard(id)}
            onDiscard={() => actions.discardEmbProvCard(id)}
            onDelete={() => void actions.deleteEmbProv(id)}
            deleteLabel="Delete Provider"
          />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "testing" | "ok" | "err" | null }) {
  if (status === "ok") return <Badge variant="default" className="w-fit gap-1 tracking-[0.04em]"><CheckCircle2 className="size-2.5" />Connected</Badge>;
  if (status === "err") return <Badge variant="destructive" className="w-fit gap-1 tracking-[0.04em]"><XCircle className="size-2.5" />Failed</Badge>;
  if (status === "testing") return <Badge variant="secondary" className="w-fit gap-1 tracking-[0.04em]"><Loader2 className="size-2.5 animate-spin" />Testing…</Badge>;
  return <Badge variant="secondary" className="w-fit tracking-[0.04em]">Not tested</Badge>;
}

function ConnectionStatus({ status, dimensions }: { status: "testing" | "ok" | "err" | null; dimensions: number | null }) {
  const message = status === "testing"
    ? "Testing connection…"
    : status === "ok"
      ? `Connection successful${dimensions ? ` (dims: ${dimensions})` : ""}`
      : status === "err"
        ? "Failed — check URL and API key"
        : "No status";
  return <StatusIndicator state={status === "testing" ? "busy" : status} message={message} />;
}
