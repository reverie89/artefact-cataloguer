import { Download, Upload } from "lucide-react";
import { useRef } from "react";
import type { AppActions } from "../../app/actions";
import type { AppState } from "../../app/state";
import type { SettingsTab } from "../../app/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CataloguingFieldsTab } from "./CataloguingFieldsTab";
import { VocabTab } from "./VocabTab";
import { ModelProvidersTab } from "./ModelProvidersTab";
import { ArtefactFileTab } from "./ArtefactFileTab";
import { AboutTab } from "./AboutTab";

interface Props {
  state: AppState;
  actions: AppActions;
}

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "about", label: "About" },
  { key: "artefactFile", label: "Artefact File" },
  { key: "fields", label: "Cataloguing Fields" },
  { key: "vocab", label: "Vocabulary Lists" },
  { key: "modelProviders", label: "Model Providers" },
];

export function SettingsScreen({ state, actions }: Props) {
  const tab = state.settingsTab;
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="bg-card border-b flex items-center gap-2 overflow-x-auto px-5">
        <Tabs value={tab} onValueChange={(v) => actions.setTab(v as SettingsTab)}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1.5 py-2">
          <Button variant="outline" size="sm" onClick={() => void actions.exportSettings()}>
            <Download className="size-3" />
            <span>Export</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="size-3" />
            <span>Import</span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => void actions.importSettings(e)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {tab === "fields" && <CataloguingFieldsTab state={state} actions={actions} />}
        {tab === "vocab" && <VocabTab state={state} actions={actions} />}
        {tab === "modelProviders" && <ModelProvidersTab state={state} actions={actions} />}
        {tab === "artefactFile" && <ArtefactFileTab state={state} actions={actions} />}
        {tab === "about" && <AboutTab />}
      </div>
    </div>
  );
}
