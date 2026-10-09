import { useRef } from "react";
import { AlertTriangle, Eye, EyeOff, Loader2, Plus, Wifi } from "lucide-react";
import type { AppActions } from "../../app/actions";
import { embeddingProviderDraftFromSettings, type AppState, type EmbeddingProviderDraft } from "../../app/state";
import { fieldsDiffer } from "../../app/drafts";
import type { EmbeddingApiFormat, EmbeddingProvider } from "../../app/types";
import { embeddingModelOptions, embeddingProviderEndpoints, selectedModelLacksImageInput } from "../../lib/ai";
import { CardActions } from "./CardActions";
import { Field, FieldSelect, FieldSelectOption } from "./FormControls";
import { ConnectionStatus, StatusBadge, type TestStatus } from "./ProviderStatus";
import { UnsavedBadge } from "./UnsavedBadge";
import { SortableList } from "./SortableList";
import { SortableRow } from "./SortableRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SaveState } from "./SaveActions.types";
import { useScrollNewRowIntoView } from "../../hooks/useScrollNewRowIntoView";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** True when a single draft entry differs from its persisted embedding
 *  provider — drives the per-row "unsaved" badge. Mirrors entryDiffers in
 *  VisionProvidersSection.tsx. Only user-authored fields are compared:
 *  `modelOptions`/`imageInputModels`/`connStatus` are machine-written by Test
 *  Connection and must not flag the row (see isTabDirty in drafts.ts). */
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
      modelOptions: p.modelOptions ?? [],
      imageInputModels: p.imageInputModels ?? null,
      connStatus: p.connStatus ?? "untested",
    },
    ["name", "baseUrl", "apiKey", "model", "apiFormat"],
  );
}

/** Grid template shared by the header row and each provider row (via
 *  SortableRow) so columns align exactly: grip / Provider / Model / Status /
 *  Active. */
const GRID = "grid-cols-[24px_1fr_1fr_120px_104px] gap-2.5 px-3.5";

/** Embedding-model provider list, rendered as a second card-list within the
 *  same "modelProviders" tab, below the vision VisionProvidersSection.
 *  Structurally a near-copy of VisionProvidersSection.tsx — same
 *  draft/save/discard shape — since embeddings may run on a completely
 *  different vendor/endpoint than chat+vision. */
export function EmbeddingProvidersSection({ state, actions }: Props) {
  const { settings, showEmbProvKey } = state;
  const live = state.embProviderDraft ?? embeddingProviderDraftFromSettings(settings);

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useScrollNewRowIntoView(
    live.providers.length,
    cardRefs,
    live.providers[live.providers.length - 1]?.id
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Configure the models used to embed vocabulary terms and, at parse time, artefact descriptions and the artefact image
        for shortlisted retrieval. Embedding models MUST be multimodal (text + image) — the per-row pipeline embeds the
        artefact image unconditionally, so a text-only model hard-fails that row. Switching models marks vocabulary syncs
        stale — re-sync sources after changing the model. Embeddings can run on a different vendor than the vision provider
        above — e.g. a local multimodal model here alongside a hosted vision provider.
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("grid bg-muted/30 border-b py-1.75", GRID)}>
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em] flex items-center gap-1.5">
            Embedding Provider
          </span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Model</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Status</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Active</span>
        </div>

        <SortableList
          items={live.providers.map((e) => e.id)}
          onReorder={(ids) => void actions.reorderEmbProv(ids)}
        >
          {live.providers.map((entry) => {
            const isActive = entry.id === live.activeProvider;
            const saved = settings.embeddingProviders.find((p) => p.id === entry.id);
            const cardDirty = !!state.embProviderDraft && (
              !saved || entryDiffers(entry, saved)
            );
            const transient = state.embProvStatus[entry.id]?.test ?? null;
            const testStatus = transient ?? (entry.connStatus === "untested" ? null : entry.connStatus);
            return (
              <EmbeddingProviderRow
                key={entry.id}
                entry={entry}
                testStatus={testStatus}
                testError={state.embProvStatus[entry.id]?.error}
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
        </SortableList>

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

/** A single reorderable embedding-provider row (shared SortableRow shell).
 *  Clicking anywhere on the row toggles the editor; the grip is drag-only. */
interface RowProps {
  entry: EmbeddingProviderDraft["providers"][number];
  testStatus: TestStatus;
  testError?: string;
  showEmbProvKey: boolean;
  isActive: boolean;
  dirty: boolean;
  cardStatus: SaveState;
  cardError?: string;
  expanded: boolean;
  cardRef?: (node: HTMLDivElement | null) => void;
  actions: AppActions;
}

function EmbeddingProviderRow({ entry, testStatus, testError, showEmbProvKey, isActive, dirty, cardStatus, cardError, expanded, cardRef, actions }: RowProps) {
  // Strict image-capable filter (empty stays empty — see embeddingModelOptions),
  // then keep a drifted saved model visible so the warning below can explain it.
  const usable = embeddingModelOptions(entry.modelOptions, entry.imageInputModels);
  const modelOptions = usable.includes(entry.model) || !entry.model ? usable : [entry.model, ...usable];
  const modelsReady = modelOptions.length > 0;
  const noImageCapable = entry.imageInputModels !== null && usable.length === 0;
  const lacksImageInput = selectedModelLacksImageInput(entry.model, entry.imageInputModels);
  const modelWarning = noImageCapable || lacksImageInput ? (
    <span className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <span>
        {noImageCapable
          ? "Connected, but none of this provider's embedding models accepts image input, which processing requires — point this provider at an image-capable endpoint or add one."
          : "This model advertises text-only input — it can't embed the artefact image, so processing will fail. Pick a model with image input."}
      </span>
    </span>
  ) : undefined;
  const id = entry.id;
  const nameDisplay = entry.name || "Untitled provider";

  return (
    <SortableRow
      id={entry.id}
      expanded={expanded}
      onToggle={() => actions.toggleEmbProv(id)}
      grid={GRID}
      cardRef={cardRef}
      label={
        expanded ? (
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
            <UnsavedBadge dirty={dirty} />
          </>
        )
      }
      cells={
        <>
          <span className="text-muted-foreground truncate text-sm">{entry.model || "—"}</span>
          <StatusBadge status={testStatus} error={testError} />
          <div onClick={(e) => e.stopPropagation()}>
            {isActive ? (
              <Badge variant="default" className="w-fit tracking-[0.04em]">Active</Badge>
            ) : (
              <Button onClick={() => void actions.setActiveEmbProv(id)} variant="outline" size="sm">Set Active</Button>
            )}
          </div>
        </>
      }
    >
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <Field
            label="Base URL"
            desc="The full embeddings endpoint for this provider — requests are posted here directly, so it must include any provider-specific path (e.g. /embeddings, /embed). /models is appended only to look up available models; if the provider doesn't serve models there, the API root's /models is tried instead and filtered to embedding models."
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

          <div className="flex items-center justify-start gap-2.5">
            <Button onClick={() => void actions.testEmbConn(id)} variant="secondary" size="sm">
              {testStatus === "testing" ? <Loader2 className="size-3 animate-spin" /> : <Wifi className="size-3" />}
              <span>{testStatus === "testing" ? "Testing…" : "Test Connection"}</span>
            </Button>
            <ConnectionStatus status={testStatus} error={testError} />
          </div>

          <FieldSelect
            label="Model"
            value={entry.model}
            onChange={(v) => actions.setEmbProvModel(id, v)}
            disabled={!modelsReady}
            ariaLabel="Model"
            hint={modelWarning}
            placeholder={
              modelsReady
                ? entry.model ? undefined : "Select a model…"
                : noImageCapable ? "No image-capable embedding models" : "Available after Test Connection"
            }
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
    </SortableRow>
  );
}
