import { Plus, X } from "lucide-react";
import { CUSTOM_TOKENS_HINT } from "../../app/defaults";
import type { ProviderFormField } from "../../app/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Segmented } from "./FormControls";

/** The form-row type Segmented options: text rows carry tokens (or literal
 *  values); file rows carry the artefact image as a binary part (no value). */
const FIELD_TYPE_OPTIONS: { value: "text" | "file"; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "file", label: "File" },
];

interface Props {
  fields: ProviderFormField[];
  onChange: (fields: ProviderFormField[]) => void;
}

/** Postman-style form-data editor for a custom provider's multipart body: one
 *  key + Text/File row per form field, sent in list order. */
export function CustomFormFieldsEditor({ fields, onChange }: Props) {
  const update = (i: number, patch: Partial<ProviderFormField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const add = () => onChange([...fields, { key: "", type: "text", value: "" }]);

  return (
    <Field
      label="Form fields"
      desc={`File fields send the artefact image as a file part. ${CUSTOM_TOKENS_HINT}`}
    >
      <div className="flex flex-col gap-1.5">
        {fields.map((f, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={f.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder="name"
              aria-label="Field name"
              className="h-8 min-w-0 flex-1"
            />
            <Segmented
              options={FIELD_TYPE_OPTIONS}
              value={f.type}
              onChange={(v) => update(i, { type: v as "text" | "file" })}
            />
            {f.type === "text" ? (
              <Input
                value={f.value ?? ""}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder="value"
                aria-label="Field value"
                className="h-8 min-w-0 flex-1"
              />
            ) : (
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">the artefact image</span>
            )}
            <Button
              onClick={() => remove(i)}
              variant="outline"
              size="icon"
              title={`Remove field ${f.key || `#${i + 1}`}`}
              className="size-8 shrink-0"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button onClick={add} variant="outline" size="sm" className="text-muted-foreground w-fit border-dashed">
          <Plus className="size-3" /><span>Add field</span>
        </Button>
      </div>
    </Field>
  );
}
