/**
 * A two-state switch, for preferences that are on or off.
 *
 * The button is the control: it takes the whole 44 px target, and the track
 * and thumb are drawn inside it. `role="switch"` is what lets a screen reader
 * announce the state without a separate label.
 */

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </button>
  );
}
