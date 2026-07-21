export interface Crumb {
  label: string;
  // Omitted for the current/last crumb — renders as plain text instead of
  // a button, since there's nowhere useful to navigate to from "here".
  onClick?: () => void;
}

interface BreadcrumbsProps {
  crumbs: Crumb[];
}

/** Shared `Projects / <project> / <video> / <stage>`-style trail
 * (`docs/ux-overhaul-plan.md` Phase 3) — plain `<button>`s rather than
 * `<a>`s, since there's no real routing underneath, just the `App.tsx`
 * view union. */
export default function Breadcrumbs({ crumbs }: BreadcrumbsProps) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => (
        <span className="breadcrumb-item" key={index}>
          {index > 0 && (
            <span className="breadcrumb-separator" aria-hidden="true">
              /
            </span>
          )}
          {crumb.onClick ? (
            <button type="button" className="breadcrumb-link" onClick={crumb.onClick}>
              {crumb.label}
            </button>
          ) : (
            <span className="breadcrumb-current">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
