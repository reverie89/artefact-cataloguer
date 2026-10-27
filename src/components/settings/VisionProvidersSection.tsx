import { useRef } from "react";
import { Eye, EyeOff, Loader2, Plus, Wifi } from "lucide-react";
import type { AppActions } from "../../app/actions";
import { providerDraftFromSettings, type AppState, type ProviderDraft } from "../../app/state";
import { fieldsDiffer } from "../../app/drafts";
import { CUSTOM_MESSAGE_TEMPLATES } from "../../app/defaults";
import type { SaveState } from "./SaveActions.types";
import type { ApiFormat, Provider, ThinkingEffort } from "../../app/types";
import { providerEndpoints } from "../../lib/ai";
import { CardActions } from "./CardActions";
import { Field, FieldSelect, FieldSelectOption, FieldTextarea, Segmented } from "./FormControls";
import { ConnectionStatus, StatusBadge, type TestStatus } from "./ProviderStatus";
import { UnsavedBadge } from "./UnsavedBadge";
import { SortableList } from "./SortableList";
import { SortableRow } from "./SortableRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useScrollNewRowIntoView } from "../../hooks/useScrollNewRowIntoView";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** The Thinking Segmented options: "off" plus every effort level. `"off"` maps
 *  to `null` (no thinking fields sent) at the action boundary. */
const THINKING_OPTIONS: { value: "off" | ThinkingEffort; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** The custom format's Auth Header Segmented options. "Bearer" maps to "" (the
 *  standard `Authorization: Bearer` header); "Custom" reveals a header-name
 *  input seeded with the reference `x-api-key`. */
const AUTH_HEADER_OPTIONS: { value: "bearer" | "custom"; label: string }[] = [
  { value: "bearer", label: "Bearer" },
  { value: "custom", label: "Custom" },
];

/** True when a single draft entry differs from its persisted provider — drives
 *  the per-row "unsaved" badge. Per-row twin of isTabDirty in drafts.ts. Only
 *  user-authored fields are compared: `modelOptions`/`connStatus` are
 *  machine-written by Test Connection and must not flag the row. */
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
      thinking: p.thinking ?? null,
      authHeader: p.authHeader ?? "",
      bodyTemplate: p.bodyTemplate ?? "",
    },
    ["name", "baseUrl", "apiKey", "model", "apiFormat", "thinking", "authHeader", "bodyTemplate"],
  );
}

/** Grid template shared by the header row and each provider row (via
 *  SortableRow) so columns align exactly: grip / Provider / Model / Status /
 *  Active. */
const GRID = "grid-cols-[24px_1fr_1fr_120px_104px] gap-2.5 px-3.5";

export function VisionProvidersSection({ state, actions }: Props) {
  const { settings, provStatus, showProvKey } = state;
  // Render from the unified draft when there are pending edits, else settings.
  const live = state.providerDraft ?? providerDraftFromSettings(settings);

  // Per-row DOM refs so a newly-added row can be scrolled into view,
  // anchoring its editor within the scroll pane.
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useScrollNewRowIntoView(
    live.providers.length,
    cardRefs,
    live.providers[live.providers.length - 1]?.id
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted-foreground text-sm px-0.5 pb-1.5 leading-relaxed">
        Configure the vision providers that power artefact analysis and validation. Add at least one provider to run the catalogue; click a row to edit its credentials and model.
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className={cn("grid bg-muted/30 border-b py-1.75", GRID)}>
          <span />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em] flex items-center gap-1.5">
            Vision Provider
          </span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Model</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Status</span>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Active</span>
        </div>

        <SortableList
          items={live.providers.map((e) => e.id)}
          onReorder={(ids) => void actions.reorderProv(ids)}
        >
          {live.providers.map((entry) => {
            const isActive = entry.id === live.activeProvider;
            const saved = settings.providers.find((p) => p.id === entry.id);
            // A row is "unsaved" when it's newly added (no persisted match) or its
            // draft entry differs from the persisted provider. ("Set Active" persists
            // immediately, so it doesn't contribute to per-card dirtiness.)
            const cardDirty = !!state.providerDraft && (
              !saved || entryDiffers(entry, saved)
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
                testStatus={testStatus}
                testError={provStatus[entry.id]?.error}
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
        </SortableList>

        {live.providers.length === 0 && (
          <div className="text-muted-foreground p-5 text-center text-[15px]">
            No vision providers configured. Add one below to enable cataloguing.
          </div>
        )}
      </Card>

      <Button onClick={actions.startAddProv} variant="outline" className="text-muted-foreground w-full border-dashed">
        <Plus className="size-3" /><span>Add Provider</span>
      </Button>
    </div>
  );
}

/** A single reorderable provider row (shared SortableRow shell). Clicking
 *  anywhere on the row toggles the editor; the grip is drag-only. */
interface RowProps {
  entry: ProviderDraft["providers"][number];
  testStatus: TestStatus;
  testError?: string;
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

function ProviderRow({ entry, testStatus, testError, showProvKey, isActive, dirty, cardStatus, cardError, expanded, cardRef, actions }: RowProps) {
  // Custom gateways have no model concept and no connection test: the base
  // URL is the full request URL, the Status column shows nothing, and the
  // Test Connection button + Thinking control (no effort parameter in the
  // contract) are hidden.
  const isCustom = entry.apiFormat === "custom";
  // The model dropdown is only meaningful after a successful connection, which
  // is what populates `modelOptions`. Before that, show a muted hint so the user
  // understands the dependency.
  const modelOptions = entry.modelOptions.includes(entry.model) || !entry.model ? entry.modelOptions : [entry.model, ...entry.modelOptions];
  const modelsReady = modelOptions.length > 0;
  const id = entry.id;
  const nameDisplay = entry.name || "Untitled provider";

  return (
    <SortableRow
      id={entry.id}
      expanded={expanded}
      onToggle={() => actions.toggleProv(id)}
      grid={GRID}
      cardRef={cardRef}
      /* Provider: name (inline-editable when expanded) + unsaved badge. */
      label={
        expanded ? (
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
            <UnsavedBadge dirty={dirty} />
          </>
        )
      }
      cells={
        <>
          {/* Model */}
          <span className="text-muted-foreground truncate text-sm">{entry.model || "—"}</span>
          {/* Status: custom providers have no connection test to report. */}
          {isCustom ? (
            <span className="text-muted-foreground text-sm">—</span>
          ) : (
            <StatusBadge status={testStatus} error={testError} />
          )}
          {/* Active: kept interactive via stopPropagation so the row doesn't toggle.
              "Set Active" persists immediately to disk (no per-card Save needed). */}
          <div onClick={(e) => e.stopPropagation()}>
            {isActive ? (
              <Badge variant="default" className="w-fit tracking-[0.04em]">Active</Badge>
            ) : (
              <Button onClick={() => void actions.setActiveProv(id)} variant="outline" size="sm">Set Active</Button>
            )}
          </div>
        </>
      }
    >
      {expanded && (
        <div className="bg-muted/30 flex flex-col gap-2.5 border-t px-3.5 pt-2.5 pb-3.5 animate-in fade-in slide-in-from-top-1 duration-100">
          <Field
            label="Base URL"
            desc={isCustom
              ? "The full request URL for this provider, sent as-is (trailing slash trimmed) — any gateway path works."
              : "The API root URL for this provider, without a trailing path."}
            hint={entry.baseUrl.trim() ? (
              <>POST <code className="text-foreground">{providerEndpoints(entry).completions}</code></>
            ) : undefined}
          >
            <Input
              value={entry.baseUrl}
              onChange={(e) => actions.setProvF(id, "baseUrl", e)}
              placeholder={isCustom ? "https://gateway.example" : "https://api.openai.com/v1"}
            />
          </Field>

          <FieldSelect
            label="API Format"
            value={entry.apiFormat}
            onChange={(v) => actions.setProvApiFormat(id, v as ApiFormat)}
            desc="Determines the auth scheme and endpoint paths."
          >
            <FieldSelectOption value="openai">OpenAI</FieldSelectOption>
            <FieldSelectOption value="anthropic">Anthropic</FieldSelectOption>
            <FieldSelectOption value="gemini">Gemini</FieldSelectOption>
            <FieldSelectOption value="custom">Custom</FieldSelectOption>
          </FieldSelect>

          {isCustom && (
            <Field
              label="Auth Header"
              desc={entry.authHeader
                ? `Sent as "${entry.authHeader}: <API key>".`
                : 'Sent as "Authorization: Bearer <API key>".'}
            >
              <Segmented
                options={AUTH_HEADER_OPTIONS}
                value={entry.authHeader ? "custom" : "bearer"}
                onChange={(v) => actions.setProvAuthHeader(id, v === "custom" ? (entry.authHeader || "x-api-key") : "")}
              />
              {entry.authHeader ? (
                <Input
                  value={entry.authHeader}
                  onChange={(e) => actions.setProvAuthHeader(id, e.target.value)}
                  placeholder="x-api-key"
                  aria-label="Auth header name"
                  className="mt-1.5"
                />
              ) : null}
            </Field>
          )}

          <Field label="API Key" desc="Sent with each request to authenticate — stored locally, never shared.">
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

          {isCustom && (
            <>
              <FieldSelect
                label="Load template"
                value=""
                onChange={(v) => actions.setProvBodyTemplate(id, v)}
                ariaLabel="Load template"
                placeholder="Load a template…"
                desc="Replaces the body below with a working baseline to modify."
              >
                {CUSTOM_MESSAGE_TEMPLATES.map((t) => (
                  <FieldSelectOption key={t.label} value={t.body}>{t.label}</FieldSelectOption>
                ))}
              </FieldSelect>
              <FieldTextarea
                label="Message (JSON)"
                value={entry.bodyTemplate}
                onChange={(e) => actions.setProvBodyTemplate(id, e.target.value)}
                placeholder={'{"input": "{{input}}"}'}
                rows={3}
                desc="The JSON body sent to the gateway — {{input}} becomes the prompt text."
              />
            </>
          )}

          {!isCustom && (
            <div className="flex items-center justify-start gap-2.5">
              <Button onClick={() => void actions.testConn(id)} variant="secondary" size="sm">
                {testStatus === "testing" ? <Loader2 className="size-3 animate-spin" /> : <Wifi className="size-3" />}
                <span>{testStatus === "testing" ? "Testing…" : "Test Connection"}</span>
              </Button>
              <ConnectionStatus status={testStatus} error={testError} />
            </div>
          )}

          {!isCustom && (
            <FieldSelect
              label="Model"
              value={entry.model}
              onChange={(v) => actions.setProvModel(id, v)}
              disabled={!modelsReady}
              ariaLabel="Model"
              desc="The model used for cataloguing requests, populated by Test Connection."
              placeholder={modelsReady ? (entry.model ? undefined : "Select a model…") : "Available after Test Connection"}
            >
              {modelOptions.map((m) => (
                <FieldSelectOption key={m} value={m}>{m}</FieldSelectOption>
              ))}
            </FieldSelect>
          )}

          {!isCustom && (
            <Field
              label="Thinking"
              desc="Ask reasoning-capable models to think before answering. Off sends nothing — the provider's default applies, and some models (e.g. GLM-5.3) always think."
            >
              <Segmented
                options={THINKING_OPTIONS}
                value={entry.thinking ?? "off"}
                onChange={(v) => {
                  const picked = THINKING_OPTIONS.find((o) => o.value === v)?.value;
                  actions.setProvThinking(id, !picked || picked === "off" ? null : picked);
                }}
              />
            </Field>
          )}

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
    </SortableRow>
  );
}
