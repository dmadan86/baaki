import { csrfToken } from '@/lib/csrf';

/**
 * The hidden field that carries the per-session CSRF token into a mutating form.
 *
 * A component rather than a bare `<input>` so the token is fetched right here and
 * no page can render the field with the wrong value — or, worse, forget the
 * value and ship a form that always fails. Drop one `<CsrfField />` inside any
 * form whose action calls `guardMutation`.
 */
export async function CsrfField() {
  const token = await csrfToken();
  return <input type="hidden" name="_csrf" value={token} />;
}
