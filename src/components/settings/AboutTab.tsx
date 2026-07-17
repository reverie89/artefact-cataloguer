import { Cpu, FileText, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STEPS: { n: number; title: string; body: string }[] = [
  { n: 1, title: "Upload", body: "Drop an artefact spreadsheet (.xlsx) with the required columns. Each row is one artefact. Configure required columns in the Artefact File tab." },
  { n: 2, title: "Configure", body: "Set up cataloguing fields and write prompt instructions. Attach vocabulary lists to controlled-vocabulary fields for consistent terminology." },
  { n: 3, title: "Parse", body: "Each artefact is catalogued through a three-step pipeline (Call 1 → embedding → Call 3). Open-ended fields are answered directly; controlled-vocabulary fields carry a cosine similarity score." },
  { n: 4, title: "Review", body: "Each catalogue field shows a combined dropdown — AI suggestions first (ranked by similarity), followed by vocabulary list terms. Select a value, search, or type a custom entry. You make the final call." },
  { n: 5, title: "Export", body: "Download the completed catalogue as a CSV file, ready to import into your collection management system." },
];

/** One numbered pipeline step in the "How parsing works" diagram. */
function PipelineStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Badge className="flex size-[22px] shrink-0 items-center justify-center rounded-full p-0 text-[13px] font-bold">
        {n}
      </Badge>
      <div className="bg-muted/40 rounded-md border px-3 py-2 text-center">
        <div className="mb-0.5 text-[13px] font-semibold">{title}</div>
        <div className="text-muted-foreground text-[12px] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

/** Down-arrow connector between pipeline steps. */
function PipelineArrow({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-0.5 text-[11px] leading-tight">
      <span>↓</span>
      <span className="max-w-[220px] text-center">{label}</span>
      <span>↓</span>
    </div>
  );
}

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
          <CardTitle className="text-muted-foreground text-xs uppercase tracking-[0.1em]">How it works</CardTitle>
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

      <Card>
        <CardHeader>
          <CardTitle className="text-muted-foreground text-xs uppercase tracking-[0.1em]">How parsing works</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-1.5">
          <PipelineStep n={1} title="Call 1 — Vision (LLM)">
            image + &lt;artefact_file&gt; + unified prompt → replies in XML
          </PipelineStep>
          <PipelineArrow label="<image_description>, <extraction> per vocab field, <open_field> per open field" />
          <div className="text-muted-foreground bg-muted/30 w-full rounded-md border px-3 py-1.5 text-center text-[12px] leading-relaxed">
            Open fields filled directly (no similarity)
          </div>
          <PipelineArrow label="each vocab field's own extraction" />
          <PipelineStep n={2} title="Embedding (per field)">
            semantic search → top net count candidates
          </PipelineStep>
          <PipelineArrow label="≤ net count candidates per field" />
          <PipelineStep n={3} title="Call 3 — Validation (LLM, optional)">
            vision picks top shortlist count from the net
          </PipelineStep>
          <PipelineArrow label="when Call 3 is off: cosine top-N used directly" />
          <div className="text-muted-foreground bg-muted/30 w-full rounded-md border px-3 py-1.5 text-center text-[12px] leading-relaxed">
            Vocab fields filled (similarity = cosine)
          </div>
          <div className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
            Net count and shortlist count are configurable in the Vocabulary Lists tab; Call 3 can be toggled off there.
          </div>
        </CardContent>
      </Card>

    </div>);
}
