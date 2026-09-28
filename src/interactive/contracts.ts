export type RawElementKind = "link" | "button" | "field" | "select" | "submit";
export type ActionKind = "navigate" | "toggle" | "fill" | "select" | "submit" | "scroll" | "wait";

export interface FormField {
  name: string;
  value: string;
  hidden: boolean;
  type?: string;
}

export interface FormEvidence {
  action: string;
  method: string;
  hasFileInput: boolean;
  fields: FormField[];
}

export interface RawInteractiveElement {
  domIndex: number;
  kind: RawElementKind;
  label: string;
  visible: boolean;
  enabled: boolean;
  href?: string;
  download?: boolean;
  buttonEffect?: "disclosure" | "tab";
  name?: string;
  fieldType?: string;
  form?: FormEvidence;
}

export interface RawInteractivePage {
  url: string;
  title: string;
  text: string;
  elements: RawInteractiveElement[];
  viewport?: { canScrollUp: boolean; canScrollDown: boolean };
  canWait?: boolean;
}

export interface SitePolicy {
  siteOrigin: string;
}

export interface ActionCandidate {
  id: string;
  kind: ActionKind;
  domIndex: number;
  label: string;
  destination: string;
  valueKey?: string;
  direction?: "up" | "down";
  fieldName?: string;
  fieldType?: string;
  form?: FormEvidence;
  fingerprint: string;
}

export interface ModelAction {
  id: string;
  kind: ActionKind;
  label: string;
  destination: string;
  valueKey?: string;
  direction?: "up" | "down";
}

export interface InteractiveSnapshot {
  sourceUrl: string;
  publicUrl: string;
  title: string;
  modelText: string;
  modelActions: ModelAction[];
  candidates: ActionCandidate[];
}
