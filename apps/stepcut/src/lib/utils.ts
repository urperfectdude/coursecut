// Copied from apps/web/src/lib/utils.ts — a generic shadcn helper, no
// coursecut-specific logic. Not a "ported from desktop" file: apps/stepcut
// has no desktop counterpart, so there is nothing upstream to stay in sync
// with here.
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
