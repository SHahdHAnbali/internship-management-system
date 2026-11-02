/** On/off switch (`role="switch"`), RTL-aware. */
export function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 flex-none items-center rounded-full border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
        checked ? 'border-primary bg-primary' : 'border-muted bg-surface-subtle'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-1/2 size-5 -translate-y-1/2 rounded-full transition-[inset-inline-start] ${
          checked ? 'start-[calc(100%-1.375rem)] bg-white' : 'start-0.5 bg-muted'
        }`}
      />
    </button>
  );
}
