import { useEffect, useRef } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Plus, Wifi, XCircle } from "lucide-react";
import type { AppActions } from "../../app/actions";
import { providerDraftFromSettings, type AppState, type ProviderDraft } from "../../app/state";
import { fieldsDiffer } from "../../app/drafts";
import type { SaveState } from "./SaveActions.types";
import type { ApiFormat, Provider } from "../../app/types";
import { providerEndpoints } from "../../lib/ai";
import { CardActions } from "./CardActions";
import { Field, FieldSelect, FieldSelectOption } from "./FormControls";
import { StatusIndicator } from "./SaveActions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** True when a single draft entry differs from its persisted provider — drives
 *  the per-row "unsaved" badge. Mirrors isProvidersDirty but per row. */
function entryDiffers(e: ProviderDraft["providers"][number], p: Provider): boolean {
  return fieldsDiffer(
    e,
    {
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      apiFormat: (p.apiFormat ?? "openai") as ApiFormat,
      modelOptions: p.modelOptions ?? [],
      connStatus: p.connStatus ?? "untested",
    },
    ["name", "baseUrl", "apiKey", "model", "apiFormat", "modelOptions", "connStatus"],
  );
}

export function ProvidersTab({ state, actions }: Props) {
  const { settings, provStatus, showProvKey } = state;
  // Render from the unified draft when there are pending edits, else settings.
  const live = state.providerDraft ?? providerDraftFromSettings(settings);

  // Per-row DOM refs so a newly-added row can be scrolled into view,
  // anchoring its editor within the scroll pane. A ref tracks the previous
  // provider count so the scroll fires ONLY when the count grows (an Add),
  // never on content edits or deletes — which also change `live.providers`.
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const prevCountRef = useRef(live.providers.length);
  useEffect(() => {
    const grew = live.providers.length > prevCountRef.current;
    prevCountRef.current = live.providers.length;
    if (!grew) return;
    // Add appends, so the new row is the last. Scroll it into view.
    const last = live.providers[live.providers.length - 1];
    const node = last ? cardRefs.current[last.id] : null;
    // block:"nearest" avoids jumping when the row is already partly visible;
    // a small timeout lets the expanded body measure before scrolling.
    const t = setTimeout(() => node?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    return () => clearTimeout(t);
  }, [live.providers]);

  // Grid template shared by the header row and each provider row so columns
  // align exactly: Provider / Model / Status / Active.
  const GRID = "grid grid-cols-[1fr_1fr_120px_104px] gap-2.5 px-3.5";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Configure the AI providers used to catalogue artefacts. Add at least one provider to run the catalogue; click a row to edit its credentials and model.
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("bg-muted/30 border-b py-1.75", GRID)}>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Provider</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Model</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Status</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Active</span>
        </div>

        {live.providers.map((entry) => {
          const isActive = entry.id === live.activeProvider;
          const saved = settings.providers.find((p) => p.id === entry.id);
          // A row is "unsaved" when it's newly added (no persisted match), its
          // draft entry differs from the persisted provider, or the user just made
          // it the active selection (active-flip is committed by this row's Save).
          const cardDirty = !!state.providerDraft && (
            !saved || entryDiffers(entry, saved) || (isActive && settings.activeProvider !== entry.id)
          );
          // Resolve the Status shown in the row: the transient Test Connection
          // outcome wins (it carries the live "testing" + just-run result that
          // hasn't been Saved yet); when there's no transient entry, fall back to
          // the draft's persisted connStatus so the last verified result survives
          // a restart. "untested" maps to null ("Not tested").
          const transient = provStatus[entry.id]?.test ?? null;
          const testStatus = transient ?? (entry.connStatus === "untested" ? null : entry.connStatus);
          return (
            <ProviderRow
              key={entry.id}
              entry={entry}
              grid={GRID}
              testStatus={testStatus}
              showProvKey={showProvKey}
              isActive={isActive}
              dirty={cardDirty}
              cardStatus={state.provCardSaveStatus[entry.id] ?? null}
              cardError={state.provCardError[entry.id]}
              expanded={!!state.providerExpanded[entry.id]}
              cardRef={(node) => { cardRefs.current[entry.id] = node; }}
              actions={actions}
            />
          );
        })}

        {live.providers.length === 0 && (
          <div className="text-muted-foreground p-5 text-center text-[15px]">
            No AI providers configured. Add one below to enable cataloguing.
          </div>
        )}
      </Card>

      <Button onClick={actions.startAddProv} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add Provider</span>
      </Button>
    </div>
  );
}

interface RowProps {
  entry: ProviderDraft["providers"][number];
  /** Shared grid template (header + rows) so columns align. */
  grid: string;
  testStatus: "testing" | "ok" | "err" | null;
  showProvKey: boolean;
  isActive: boolean;
  /** Whether this row has unsaved draft changes (drives the "unsaved" badge). */
  dirty: boolean;
  /** Persist status of this row's own Save button. */
  cardStatus: SaveState;
  /** Specific reason the row's Save failed, shown inline instead of "Not saved". */
  cardError?: string;
  /** Whether the editor body is expanded. Collapsed shows the summary row only. */
  expanded: boolean;
  /** Registers this row's root DOM node so the parent can scroll it into view. */
  cardRef?: (node: HTMLDivElement | null) => void;
  actions: AppActions;
}

function ProviderRow({ entry, grid, testStatus, showProvKey, isActive, dirty, cardStatus, cardError, expanded, cardRef, actions }: RowProps) {
  // The model dropdown is only meaningful after a successful connection, which
  // is what populates `modelOptions`. Before that, show a muted hint so the user
  // understands the dependency.
  const modelOptions = entry.modelOptions.includes(entry.model) || !entry.model ? entry.modelOptions : [entry.model, ...entry.modelOptions];
  const modelsReady = modelOptions.length > 0;
  const id = entry.id;
  const nameDisplay = entry.name || "Untitled provider";

  return (
    <div ref={cardRef} className="border-border/60 border-b">
      {/* Clickable summary row — grid-aligned to the header. */}
      <div onClick={() => actions.toggleProv(id)} className={cn("grid cursor-pointer items-center py-2.25", grid)}>
        {/* Provider: chevron + name (inline-editable when expanded) + unsaved badge */}
        <div className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown className="text-muted-foreground size-3" /> : <ChevronRight className="text-muted-foreground size-3" />}
          {expanded ? (
            <Input
              value={entry.name}
              onChange={(e) => actions.setProvF(id, "name", e)}
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
        {/* Model */}
        <span className="text-muted-foreground truncate text-sm">{entry.model || "—"}</span>
        {/* Status */}
        <StatusBadge status={testStatus} />
        {/* Active: kept interactive via stopPropagation so the row doesn't toggle.
            "Set Active" buffers into the draft and is committed by this row's Save. */}
        <div onClick={(e) => e.stopPropagation()}>
          {isActive ? (
            <Badge variant="default" className="w-fit tracking-[0.04em]">Active</Badge>
          ) : (
            <Button onClick={() => actions.setActiveProv(id)} variant="outline" size="sm">Set Active</Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <Field
            label="Base URL"
            hint={entry.baseUrl.trim() ? (
              <>POST <code className="text-foreground">{providerEndpoints(entry).completions}</code></>
            ) : undefined}
          >
            <Input value={entry.baseUrl} onChange={(e) => actions.setProvF(id, "baseUrl", e)} placeholder="https://api.openai.com/v1" />
          </Field>

          <FieldSelect
            label="API Format"
            value={entry.apiFormat}
            onChange={(v) => actions.setProvApiFormat(id, v as ApiFormat)}
            hint="Determines the auth scheme and endpoint paths."
          >
            <FieldSelectOption value="openai">OpenAI</FieldSelectOption>
            <FieldSelectOption value="anthropic">Anthropic</FieldSelectOption>
            <FieldSelectOption value="gemini">Gemini</FieldSelectOption>
          </FieldSelect>

          <Field label="API Key">
            <div className="flex gap-1.5">
              <Input type={showProvKey ? "text" : "password"} value={entry.apiKey} onChange={(e) => actions.setProvF(id, "apiKey", e)} placeholder="sk-…" />
              <Button
                onClick={actions.toggleProvKey}
                variant="outline"
                size="icon"
                title={showProvKey ? "Hide key" : "Reveal key"}
                className="h-9"
              >
                {showProvKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
            </div>
          </Field>

          <div className="flex items-center justify-start gap-2.5">
            <Button onClick={() => void actions.testConn(id)} variant="secondary" size="sm">
              {testStatus === "testing" ? <Loader2 className="size-3 animate-spin" /> : <Wifi className="size-3" />}
              <span>{testStatus === "testing" ? "Testing…" : "Test Connection"}</span>
            </Button>
            <ConnectionStatus status={testStatus} />
          </div>

          <FieldSelect
            label="Model"
            value={entry.model}
            onChange={(v) => actions.setProvModel(id, v)}
            disabled={!modelsReady}
            ariaLabel="Model"
            placeholder={modelsReady ? (entry.model ? undefined : "Select a model…") : "Available after Test Connection"}
          >
            {modelOptions.map((m) => (
              <FieldSelectOption key={m} value={m}>{m}</FieldSelectOption>
            ))}
          </FieldSelect>

          {/* Per-row actions: Delete/Discard/Save target only this provider.
              Delete persists immediately (after its confirm); Discard/Save
              operate on this row's content alone. */}
          <CardActions
            dirty={dirty}
            status={cardStatus}
            errorMessage={cardError}
            onSave={() => void actions.saveProvCard(id)}
            onDiscard={() => actions.discardProvCard(id)}
            onDelete={() => void actions.deleteProv(id)}
            deleteLabel="Delete Provider"
          />
        </div>
      )}
    </div>
  );
}

/** Compact connection-status badge for the row's Status column. */
function StatusBadge({ status }: { status: "testing" | "ok" | "err" | null }) {
  if (status === "ok") return <Badge variant="default" className="w-fit gap-1 tracking-[0.04em]"><CheckCircle2 className="size-2.5" />Connected</Badge>;
  if (status === "err") return <Badge variant="destructive" className="w-fit gap-1 tracking-[0.04em]"><XCircle className="size-2.5" />Failed</Badge>;
  if (status === "testing") return <Badge variant="secondary" className="w-fit gap-1 tracking-[0.04em]"><Loader2 className="size-2.5 animate-spin" />Testing…</Badge>;
  return <Badge variant="secondary" className="w-fit tracking-[0.04em]">Not tested</Badge>;
}

function ConnectionStatus({ status }: { status: "testing" | "ok" | "err" | null }) {
  const message = status === "testing" ? "Testing connection…" : status === "ok" ? "Connection successful" : status === "err" ? "Failed — check URL and API key" : "No status";
  return <StatusIndicator state={status === "testing" ? "busy" : status} message={message} />;
}
