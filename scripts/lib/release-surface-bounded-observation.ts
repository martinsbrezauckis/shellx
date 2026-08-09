export const RELEASE_SURFACE_OBSERVATION_FIELDS = [
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

export type ReleaseSurfaceObservationField = typeof RELEASE_SURFACE_OBSERVATION_FIELDS[number];

export type ReleaseSurfaceElementObservation = {
  present: boolean;
  visible: boolean;
  value?: string;
  checked?: boolean;
  selected?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  focused?: boolean;
  disabled?: boolean;
  title?: string;
  href?: string;
  scrollLeft?: number;
  scrollWidth?: number;
  clientWidth?: number;
  mounted?: boolean;
  nonempty?: boolean;
};

const FIELD_SET = new Set<string>(RELEASE_SURFACE_OBSERVATION_FIELDS);
const MAX_TEXT_LENGTH = 256;

export const RELEASE_SURFACE_BOUNDED_OBSERVATION_SCRIPT = String.raw`
return (() => {
  void "SHELLX_BOUNDED_ELEMENT_OBSERVATION";
  const selector = arguments[0];
  const requested = Array.isArray(arguments[1]) ? arguments[1] : [];
  const allowed = new Set(["value", "checked", "selected", "pressed", "expanded", "focused", "disabled", "title", "href", "scrollLeft", "scrollWidth", "clientWidth", "mounted", "nonempty"]);
  let element = null;
  try { element = document.querySelector(selector); } catch { return { present: false, visible: false, observation: {} }; }
  if (!(element instanceof HTMLElement)) return { present: false, visible: false, observation: {} };
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  const declared = new Set((element.getAttribute("data-shellx-release-observe") || "").split(/\s+/).filter((field) => allowed.has(field)));
  const observation = {};
  for (const field of requested) {
    if (!allowed.has(field) || !declared.has(field)) continue;
    if (field === "focused") { observation.focused = document.activeElement === element; continue; }
    if (field === "pressed" || field === "expanded" || field === "selected") {
      const aria = element.getAttribute("aria-" + field);
      if (aria === "true" || aria === "false") observation[field] = aria === "true";
      else if (field === "selected" && element instanceof HTMLOptionElement) observation.selected = element.selected;
      continue;
    }
    if (field === "disabled") {
      if ("disabled" in element && typeof element.disabled === "boolean") observation.disabled = element.disabled;
      else {
        const aria = element.getAttribute("aria-disabled");
        if (aria === "true" || aria === "false") observation.disabled = aria === "true";
      }
      continue;
    }
    if (field === "checked") {
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) observation.checked = element.checked;
      continue;
    }
    if (field === "title") {
      const secretOwner = Boolean(element.closest("[data-shellx-sensitive='true']"));
      if (!secretOwner) observation.title = (element.getAttribute("title") || "").slice(0, 256);
      continue;
    }
    if (field === "href") {
      const secretOwner = Boolean(element.closest("[data-shellx-sensitive='true']"));
      if (!secretOwner && element instanceof HTMLAnchorElement && /^https:\/\//i.test(element.href)) {
        observation.href = element.href.slice(0, 256);
      }
      continue;
    }
    if (field === "scrollLeft" || field === "scrollWidth" || field === "clientWidth") {
      observation[field] = element[field];
      continue;
    }
    if (field === "mounted") {
      const mounted = element.getAttribute("data-shellx-release-mounted");
      if (mounted === "true" || mounted === "false") observation.mounted = mounted === "true";
      continue;
    }
    if (field === "nonempty") {
      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
      if (input) observation.nonempty = element.value.length > 0;
      continue;
    }
    if (field === "value") {
      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
      const secretType = element instanceof HTMLInputElement && ["password", "hidden", "file"].includes(element.type);
      const secretOwner = Boolean(element.closest("[data-shellx-sensitive='true']"));
      const autocomplete = (element.getAttribute("autocomplete") || "").trim().toLowerCase();
      const secretAutocomplete = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(autocomplete);
      if (input && !secretType && !secretOwner && !secretAutocomplete) observation.value = element.value.slice(0, 256);
    }
  }
  return { present: true, visible, observation };
})();`;

export function normalizeReleaseSurfaceObservationFields(
  fields: readonly ReleaseSurfaceObservationField[],
): ReleaseSurfaceObservationField[] {
  const normalized: ReleaseSurfaceObservationField[] = [];
  for (const field of fields) {
    if (!FIELD_SET.has(field) || normalized.includes(field)) continue;
    normalized.push(field);
  }
  if (normalized.length === 0) throw new Error("bounded element observation requires at least one allowlisted field");
  return normalized;
}

export function validateReleaseSurfaceElementObservation(
  value: unknown,
  requested: readonly ReleaseSurfaceObservationField[],
): ReleaseSurfaceElementObservation {
  if (!isRecord(value) || typeof value.present !== "boolean" || typeof value.visible !== "boolean") {
    throw new Error("bounded element observation returned an invalid presence envelope");
  }
  const raw = isRecord(value.observation) ? value.observation : {};
  const output: ReleaseSurfaceElementObservation = { present: value.present, visible: value.visible };
  if (!value.present) return output;
  for (const field of requested) {
    const observed = raw[field];
    if (field === "value" || field === "title" || field === "href") {
      if (typeof observed !== "string" || observed.length > MAX_TEXT_LENGTH || observed.includes("\0")) {
        throw new Error(`bounded element observation omitted or exceeded its declared ${field} field`);
      }
      if (field === "href" && !/^https:\/\//i.test(observed)) {
        throw new Error("bounded element observation returned a non-HTTPS href");
      }
      output[field] = observed;
      continue;
    }
    if (field === "scrollLeft" || field === "scrollWidth" || field === "clientWidth") {
      if (!Number.isFinite(observed) || Number(observed) < 0 || Number(observed) > 1_000_000) {
        throw new Error(`bounded element observation omitted or exceeded its declared ${field} field`);
      }
      output[field] = Number(observed);
      continue;
    }
    if (typeof observed !== "boolean") {
      throw new Error(`bounded element observation omitted its declared ${field} field`);
    }
    output[field] = observed;
  }
  const extras = Object.keys(raw).filter((field) => !requested.includes(field as ReleaseSurfaceObservationField));
  if (extras.length > 0) throw new Error(`bounded element observation returned undeclared fields: ${extras.join(", ")}`);
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
