import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import { VisionProvidersSection } from "./VisionProvidersSection";
import { EmbeddingProvidersSection } from "./EmbeddingProvidersSection";

interface Props {
  state: AppState;
  actions: AppActions;
}

/** Host for the "Model Providers" tab. The tab covers two distinct provider
 *  kinds — vision (chat) models and embedding models — each rendered as its own
 *  section so the per-kind UIs and drafts stay independent. The end-to-end
 *  pipeline diagram lives in `README.md` ("Cataloguing pipeline") rather than
 *  in-app; see AGENTS.md for the rule that keeps it in sync. */
export function ModelProvidersTab({ state, actions }: Props) {
  return (
    <div className="flex flex-col gap-6">
      <VisionProvidersSection state={state} actions={actions} />
      <EmbeddingProvidersSection state={state} actions={actions} />
    </div>
  );
}
