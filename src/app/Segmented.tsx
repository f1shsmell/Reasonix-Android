/**
 * A segmented control with one sliding thumb.
 *
 * The selected pill is a single absolutely positioned element, not a
 * background on each button: moving one element is what makes the change read
 * as a slide instead of a flash. The buttons stay real buttons, so the
 * existing keyboard and screen-reader behaviour is unchanged.
 */

import type { CSSProperties, ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `tablist` for views; the default is a group of pressed buttons. */
  tablist?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  tablist = false,
  className = "",
}: SegmentedProps<T>) {
  const selected = options.findIndex((option) => option.value === value);
  const index = selected < 0 ? 0 : selected;
  const geometry = {
    "--seg-count": options.length,
    "--seg-index": index,
  } as CSSProperties;

  return (
    <div
      className={`segmented ${className}`.trim()}
      role={tablist ? "tablist" : "group"}
      aria-label={ariaLabel}
      style={geometry}
    >
      <span className="seg-thumb" aria-hidden="true" />
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={tablist ? "tab" : undefined}
            aria-selected={tablist ? on : undefined}
            aria-pressed={tablist ? undefined : on}
            className={on ? "on" : ""}
            disabled={option.disabled === true}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
