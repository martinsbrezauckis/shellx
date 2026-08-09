export const DEBUG_ELEMENT_OBSERVATION_ATTRIBUTE = "data-shellx-release-observe";
export const DEBUG_ELEMENT_OBSERVATION_FIELDS = [
  "value",
  "checked",
  "selected",
  "pressed",
  "expanded",
  "focused",
  "disabled",
  "title",
  "href",
  "scrollLeft",
  "scrollWidth",
  "clientWidth",
  "mounted",
  "nonempty",
] as const;

export type DebugElementObservationField = typeof DEBUG_ELEMENT_OBSERVATION_FIELDS[number];

export type DebugElementObservation = Partial<{
  value: string;
  checked: boolean;
  selected: boolean;
  pressed: boolean;
  expanded: boolean;
  focused: boolean;
  disabled: boolean;
  title: string;
  href: string;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  mounted: boolean;
  nonempty: boolean;
}>;

const FIELD_SET = new Set<string>(DEBUG_ELEMENT_OBSERVATION_FIELDS);
const MAX_FIELDS = DEBUG_ELEMENT_OBSERVATION_FIELDS.length;
const MAX_TEXT_LENGTH = 256;

export function normalizeDebugElementObservationFields(value: unknown): DebugElementObservationField[] {
  if (!Array.isArray(value)) return [];
  const fields: DebugElementObservationField[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !FIELD_SET.has(item) || fields.includes(item as DebugElementObservationField)) continue;
    fields.push(item as DebugElementObservationField);
    if (fields.length >= MAX_FIELDS) break;
  }
  return fields;
}

export function observeDebugElement(
  element: HTMLElement,
  requested: readonly DebugElementObservationField[],
): DebugElementObservation {
  const declared = new Set(
    normalizeDebugElementObservationFields(
      (element.getAttribute(DEBUG_ELEMENT_OBSERVATION_ATTRIBUTE) ?? "").split(/\s+/).filter(Boolean),
    ),
  );
  const observation: DebugElementObservation = {};
  for (const field of requested) {
    if (!declared.has(field)) continue;
    if (field === "focused") {
      observation.focused = document.activeElement === element;
      continue;
    }
    if (field === "pressed" || field === "expanded" || field === "selected") {
      const aria = element.getAttribute(`aria-${field}`);
      if (aria === "true" || aria === "false") observation[field] = aria === "true";
      else if (field === "selected" && element instanceof HTMLOptionElement) observation.selected = element.selected;
      continue;
    }
    if (field === "disabled") {
      const nativeDisabled = "disabled" in element && typeof element.disabled === "boolean"
        ? element.disabled
        : null;
      const aria = element.getAttribute("aria-disabled");
      if (nativeDisabled !== null) observation.disabled = nativeDisabled;
      else if (aria === "true" || aria === "false") observation.disabled = aria === "true";
      continue;
    }
    if (field === "checked") {
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
        observation.checked = element.checked;
      }
      continue;
    }
    if (field === "title" && !element.closest("[data-shellx-sensitive='true']")) {
      observation.title = (element.getAttribute("title") ?? "").slice(0, MAX_TEXT_LENGTH);
      continue;
    }
    if (field === "href" && element instanceof HTMLAnchorElement
      && !element.closest("[data-shellx-sensitive='true']")) {
      const href = element.href.slice(0, MAX_TEXT_LENGTH);
      if (/^https:\/\//i.test(href)) observation.href = href;
      continue;
    }
    if (field === "scrollLeft") {
      observation.scrollLeft = element.scrollLeft;
      continue;
    }
    if (field === "scrollWidth") {
      observation.scrollWidth = element.scrollWidth;
      continue;
    }
    if (field === "clientWidth") {
      observation.clientWidth = element.clientWidth;
      continue;
    }
    if (field === "mounted") {
      const mounted = element.getAttribute("data-shellx-release-mounted");
      if (mounted === "true" || mounted === "false") observation.mounted = mounted === "true";
      continue;
    }
    if (field === "nonempty") {
      const input = element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement;
      if (input) observation.nonempty = element.value.length > 0;
      continue;
    }
    if (field === "value" && valueMayBeObserved(element)) {
      observation.value = element.value.slice(0, MAX_TEXT_LENGTH);
    }
  }
  return observation;
}

function valueMayBeObserved(
  element: HTMLElement,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return false;
  }
  if (element.closest("[data-shellx-sensitive='true']")) return false;
  if (element instanceof HTMLInputElement && ["password", "hidden", "file"].includes(element.type)) return false;
  const autocomplete = element.getAttribute("autocomplete")?.trim().toLowerCase() ?? "";
  return !["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(autocomplete);
}
