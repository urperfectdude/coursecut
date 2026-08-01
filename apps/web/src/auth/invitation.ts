// Invitation links (plan §4.1 "Members / invites").
//
// The SPA has no router — `App.tsx` is a `useState` view switch, copied from
// desktop, and giving the web app routes would be a structural change to the
// thing §7.1 exists to keep identical. A query parameter needs none: an
// invitee opens `…/?invitation=<id>`, the gate accepts it once a session
// exists, and the parameter is then stripped from the address bar so a reload
// does not try again.

const PARAM = "invitation";

/** The pending invitation id in the current URL, if any. */
export function readInvitationId(): string | null {
  const value = new URLSearchParams(window.location.search).get(PARAM);
  return value && value.trim() ? value : null;
}

/** Drops the parameter without reloading, so the accepted (or refused)
 * invitation is not retried on the next render or refresh. */
export function clearInvitationParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PARAM)) return;
  url.searchParams.delete(PARAM);
  window.history.replaceState({}, "", url.toString());
}

/** The link to hand an invitee. Built from the current origin because that is
 * the only host the SPA can honestly claim to be reachable at — dev server,
 * preview, or the real domain. */
export function invitationLink(invitationId: string): string {
  return `${window.location.origin}/?${PARAM}=${encodeURIComponent(invitationId)}`;
}
