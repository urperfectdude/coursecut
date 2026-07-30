import { Fragment } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

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
    <Breadcrumb aria-label="Breadcrumb">
      <BreadcrumbList>
        {crumbs.map((crumb, index) => (
          <Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.onClick ? (
                <BreadcrumbLink asChild>
                  <button type="button" onClick={crumb.onClick}>
                    {crumb.label}
                  </button>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
