// Copied from apps/web/src/components/SegmentedScrubber.tsx — a generic,
// presentational reskin of `<input type="range">`. Not a "ported from
// desktop" file: apps/stepcut has no desktop counterpart. The segment-
// highlight overlay that reference supports is unused here (StepClipPlayer
// only ever passes `min`/`max`/`step`/`value`/`onChange`); kept in the copy
// anyway rather than stripped, so this file stays a plain copy of its
// source instead of a StepCut-specific fork.
import { cn } from "@/lib/utils";

interface SegmentedScrubberSegment {
  id: string;
  start: number;
  end: number;
}

interface SegmentedScrubberProps {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  "aria-label": string;
  className?: string;
  segments?: SegmentedScrubberSegment[];
  duration?: number;
}

export default function SegmentedScrubber({
  min,
  max,
  step,
  value,
  onChange,
  disabled,
  "aria-label": ariaLabel,
  className,
  segments,
  duration,
}: SegmentedScrubberProps) {
  const showOverlay = segments !== undefined && duration !== undefined && duration > 0;

  return (
    <div className="relative box-border">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn(
          "relative z-10 block w-full appearance-none bg-transparent",
          "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted",
          "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:cursor-pointer",
          "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted",
          "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:cursor-pointer",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      />
      {showOverlay && (
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 box-border h-1.5 -translate-y-1/2"
          aria-hidden="true"
        >
          {segments.map((segment) => (
            <span
              key={segment.id}
              className="absolute inset-y-0 rounded-full bg-amber-400/60 ring-1 ring-inset ring-white/20"
              style={{
                left: `${(segment.start / duration) * 100}%`,
                width: `${((segment.end - segment.start) / duration) * 100}%`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
