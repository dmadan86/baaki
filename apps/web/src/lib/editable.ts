/**
 * What the web's expense editor is allowed to open.
 *
 * The web form writes one payer and one of four split kinds. Anything the app
 * can record and the form cannot express has to be refused rather than
 * rewritten: opening a bill with three payers and saving it would put the whole
 * amount on the first of them, silently, on an append-only ledger (ADR-004).
 *
 * The rule is here rather than inline in the form so it can be tested — the web
 * suite runs in node with no renderer.
 */

/** Only the parts of a version this decision reads. */
export interface EditableVersion {
  readonly payers: readonly { readonly member_id: string }[];
}

/**
 * True when the expense records several payers, which this editor cannot hold.
 * The form shows its read-only note instead; the app can still edit it.
 */
export function tooManyPayersForWeb(version: EditableVersion): boolean {
  return version.payers.length > 1;
}
