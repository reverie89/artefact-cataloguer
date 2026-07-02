import type { ChangeEvent, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Shared segmented control — the canonical "mutually-exclusive buttons" toggle
 *  for a small fixed set of options (Open-ended/Controlled, Yes/No). A single
 *  visual vocabulary for every binary/ternary field toggle, no per-tab cruft. */
interface SegmentedProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

export function Segmented({ options, value, onChange }: SegmentedProps) {
  return (
    <div className="bg-muted inline-flex rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-sm px-2.5 py-1 text-sm transition-colors",
            o.value === value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Generic labeled field wrapper. The single home for the
 *  `<div><label/><control/><hint/></div>` pattern that every form field shares,
 *  so the label/spacing/hint placement is identical wherever a field is reused.
 *  `action` renders a top-right affordance beside the label (e.g. the Preview /
 *  Override buttons on the prose cards) — keeping the field's own header markup
 *  here rather than hand-rolling it per card. */
interface FieldProps {
  label: string;
  hint?: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Field({ label, hint, desc, action, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {action ? (
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-muted-foreground text-xs uppercase tracking-[0.08em]">{label}</Label>
            {desc && <div className="text-muted-foreground text-xs leading-snug">{desc}</div>}
          </div>
          {action}
        </div>
      ) : (
        <>
          <Label className="text-muted-foreground text-xs uppercase tracking-[0.08em]">{label}</Label>
          {desc && <div className="text-muted-foreground text-xs leading-snug">{desc}</div>}
        </>
      )}
      {children}
      {hint && <div className="text-muted-foreground mt-1 text-xs">{hint}</div>}
    </div>
  );
}

/** Labeled text `<input>` wrapper. */
interface FieldInputProps {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  hint?: ReactNode;
  desc?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

export function FieldInput({ label, value, onChange, placeholder, type, disabled, hint, desc, ariaLabel, className }: FieldInputProps) {
  return (
    <Field label={label} hint={hint} desc={desc}>
      <Input
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        type={type}
        disabled={disabled}
        aria-label={ariaLabel}
        className={className}
      />
    </Field>
  );
}

/** Labeled `<textarea>` wrapper. */
interface FieldTextareaProps {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  hint?: ReactNode;
  desc?: ReactNode;
  className?: string;
}

export function FieldTextarea({ label, value, onChange, placeholder, rows, disabled, readOnly, hint, desc, className }: FieldTextareaProps) {
  return (
    <Field label={label} hint={hint} desc={desc}>
      <Textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        readOnly={readOnly}
        className={className}
      />
    </Field>
  );
}

/** Labeled `<select>` wrapper. Uses the shadcn Select (Radix-powered). Pass
 *  `placeholder` for the leading "Select a model…" affordance and `children`
 *  (FieldSelectOption) for the options. `hint` renders a line under the select. */
interface FieldSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  hint?: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
}

export function FieldSelect({ label, value, onChange, placeholder, disabled, ariaLabel, hint, desc, children }: FieldSelectProps) {
  return (
    <Field label={label} hint={hint} desc={desc}>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={ariaLabel} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </Field>
  );
}

/** Option for FieldSelect. */
export function FieldSelectOption({ value, children }: { value: string; children: ReactNode }) {
  return <SelectItem value={value}>{children}</SelectItem>;
}
