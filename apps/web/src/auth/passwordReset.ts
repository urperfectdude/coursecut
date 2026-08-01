// Password-reset links (M7, closing plan §4.1's last row).
//
// Same trick as `invitation.ts`, and for the same reason: the SPA has no
// router, because giving it one would be a structural change to the thing §7.1
// exists to keep identical to desktop. A query parameter needs none.
//
// The round trip is `better-auth`'s, not ours:
//
//   1. the SPA asks for a reset with `redirectTo` = this origin
//   2. the mail carries `/api/auth/reset-password/<token>?callbackURL=…`
//   3. following it redirects back here with `?token=…` — or `?error=…` when
//      the token has expired or been used, which is a case the form has to
//      show rather than swallow, since the two look identical to the user
//   4. the SPA posts the new password with that token, then strips the
//      parameters so a reload is not a second attempt with a spent token

const TOKEN_PARAM = "token";
const ERROR_PARAM = "error";

/** The reset token in the current URL, if the visitor followed a reset link. */
export function readResetToken(): string | null {
  const value = new URLSearchParams(window.location.search).get(TOKEN_PARAM);
  return value && value.trim() ? value : null;
}

/** `better-auth`'s reason for refusing the link (`INVALID_TOKEN`), if it did. */
export function readResetError(): string | null {
  const value = new URLSearchParams(window.location.search).get(ERROR_PARAM);
  return value && value.trim() ? value : null;
}

/** Drops both parameters without reloading. */
export function clearResetParams(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(TOKEN_PARAM) && !url.searchParams.has(ERROR_PARAM)) return;
  url.searchParams.delete(TOKEN_PARAM);
  url.searchParams.delete(ERROR_PARAM);
  window.history.replaceState({}, "", url.toString());
}

/** Where a reset link should land the user back: this origin, for the same
 * reason `invitationLink` uses it — it is the only host the SPA can honestly
 * claim to be reachable at. */
export function resetRedirectTo(): string {
  return `${window.location.origin}/`;
}
