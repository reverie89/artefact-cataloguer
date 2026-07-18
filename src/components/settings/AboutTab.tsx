import { Cpu, FileText, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STEPS: { n: number; title: string; body: string }[] = [
  { n: 1, title: "Upload", body: "Drop an artefact spreadsheet (.xlsx) with the required columns. Each row is one artefact. Configure required columns in the Artefact File tab." },
  { n: 2, title: "Configure", body: "Set up cataloguing fields and write prompt instructions. Attach vocabulary lists to controlled-vocabulary fields for consistent terminology." },
  { n: 3, title: "Parse", body: "Each artefact is catalogued through a three-step pipeline (vision analysis → embedding → validation). Open-ended fields are answered directly; controlled-vocabulary fields carry a cosine similarity score." },
  { n: 4, title: "Review", body: "Each catalogue field shows a combined dropdown — AI suggestions first (ranked by similarity), followed by vocabulary list terms. Select a value, search, or type a custom entry. You make the final call." },
  { n: 5, title: "Export", body: "Download the completed catalogue as an .xlsx file. Pick which artefact-file columns to include in the Artefact File tab (default all on); they export as leading columns, followed by the catalogue fields, with images embedded per row." },
];

export function AboutTab() {
  return (
    <div className="flex flex-col gap-2.5">
      <Card>
        <CardContent className="flex flex-col gap-1.5 py-4">
          <div className="text-3xl font-semibold tracking-tight">Artefact Cataloguer</div>
          <span className="text-muted-foreground text-xs uppercase tracking-[0.08em]">AI-assisted Museum Cataloguing</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-muted-foreground text-xs uppercase tracking-[0.1em]">How To Use</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={i < STEPS.length - 1 ? "border-border/60 flex gap-3.5 border-b pb-2.5" : "flex gap-3.5"}
            >
              <Badge className="flex size-[22px] shrink-0 items-center justify-center rounded-full p-0 text-[13px] font-bold">
                {s.n}
              </Badge>
              <div>
                <div className="mb-0.5 text-[15px] font-semibold">{s.title}</div>
                <div className="text-muted-foreground text-[13px] leading-relaxed">{s.body}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <Card>
          <CardContent className="flex flex-col gap-1.5 py-4">
            <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><Cpu className="size-3.5" /><span>AI Powered</span></div>
            <div className="text-muted-foreground text-[13px] leading-relaxed">
              Connects to any OpenAI-compatible API. Requests are made from the app process on your machine; your API key is stored in the OS keychain (never in the settings file) and is never sent anywhere except your configured endpoint.
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1.5 py-4">
            <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><Shield className="size-3.5" /><span>Data Privacy</span></div>
            <div className="text-muted-foreground text-[13px] leading-relaxed">
              All settings stay in a single file beside the app (keys excepted — those live in the OS keychain). Only the artefact data you actively submit is sent to your configured AI endpoint.
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="text-muted-foreground flex items-center gap-2.5 py-3.5 text-[13px]">
          <FileText className="size-4 text-primary" />
          <span>Embedded spreadsheet images are extracted beside the app and cleared on restart.</span>
        </CardContent>
      </Card>
    </div>);
}
