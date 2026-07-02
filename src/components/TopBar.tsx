import {
  Activity,
  AlertCircle,
  ChevronLeft,
  Moon,
  Settings as SettingsIcon,
  Sun,
  Zap,
} from "lucide-react";
import type { AppActions } from "../app/actions";
import type { AppState } from "../app/state";
import { activeProvider, hasProvider } from "../lib/ai";
import { useLogErrorCount } from "../lib/logs";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface Props {
  state: AppState;
  actions: AppActions;
}

export function TopBar({ state, actions }: Props) {
  const isMain = state.screen === "main";
  const isSettings = state.screen === "settings";
  const logs = useLogErrorCount();
  const issues = logs;
  const providerReady = hasProvider(state.settings);
  const prov = activeProvider(state.settings);
  return (
    <div className="bg-card border-b flex h-[52px] shrink-0 items-center gap-3 px-5 z-40">
      {isMain && (
        <>
          <span className="text-xl font-semibold tracking-tight">Artefact Cataloguer</span>
          <Separator orientation="vertical" className="!h-3.5" />
          <span className="text-muted-foreground text-xs uppercase tracking-[0.1em]">Museum Cataloguing</span>
        </>
      )}
      {isSettings && (
        <>
          <Button variant="ghost" size="sm" onClick={actions.goMain} className="text-muted-foreground">
            <ChevronLeft className="size-3.5" />
            <span>Main</span>
          </Button>
          <Separator orientation="vertical" className="!h-3.5" />
          <span className="text-lg font-semibold tracking-tight">Settings</span>
        </>
      )}
      <div className="flex-1" />
      <div className="flex flex-col justify-center gap-0.5 px-5 text-center">
        {providerReady ? (
          <div className="flex items-center gap-1.5">
            <Zap className="size-3 text-primary" />
            <div className="flex flex-col gap-px leading-tight">
              <span className="text-muted-foreground text-xs">{prov?.name}</span>
              <span className="text-muted-foreground text-[11px]">{prov?.model}</span>
            </div>
          </div>
        ) : (
          <div className="text-destructive flex items-center gap-1.5 text-xs">
            <AlertCircle className="size-3" />
            <span>Enable AI in Settings first</span>
          </div>
        )}
      </div>
      <Button variant="outline" size="icon" onClick={actions.toggleLogs} title="Logs Viewer" className="relative">
        <Activity className="size-3.5" />
        {issues > 0 && (
          <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none">
            {issues > 99 ? "99+" : issues}
          </span>
        )}
      </Button>
      <div className="bg-input flex shrink-0 items-center overflow-hidden rounded-md border">
        <Button variant="ghost" size="sm" onClick={actions.zoomOut} className="text-muted-foreground font-sans h-7">A−</Button>
        <span className="text-muted-foreground w-9 min-w-9 select-none text-center text-[13px]">
          {Math.round(state.zoom * 100)}%
        </span>
        <Button variant="ghost" size="sm" onClick={actions.zoomIn} className="text-muted-foreground font-sans h-7">A+</Button>
      </div>
      <Button variant="outline" size="icon" onClick={actions.toggleDark} title="Toggle theme">
        {state.darkMode ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      </Button>
      {isMain && (
        <Button variant="outline" size="sm" onClick={() => actions.goSettings("about")}>
          <SettingsIcon className="size-3.5" />
          <span>Settings</span>
        </Button>
      )}
    </div>
  );
}
