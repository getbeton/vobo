/**
 * Vobo wordmark — same geometry as vobo-www `vobo-logo-light.svg`.
 * currentColor so it sits on paper (ink) or on dark (paper).
 */
export function Logo({
  height = 19,
  title = 'Vobo',
}: {
  height?: number;
  title?: string;
}) {
  const width = Math.round((458 / 140) * height);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 458 140"
      width={width}
      height={height}
      role="img"
      aria-label={title}
      style={{ display: 'block', color: 'inherit' }}
    >
      <title>{title}</title>
      <path d="M0 0H16L50.5 95.64L85 0H101L50.5 140Z" fill="currentColor" />
      <path
        d="M158 8H181A31 31 0 0 1 181 70H158A31 31 0 0 1 158 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinejoin="miter"
      />
      <rect x="238" y="0" width="16" height="140" fill="currentColor" />
      <path
        d="M254 8H300A31 31 0 0 1 300 70H254"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinejoin="miter"
      />
      <path
        d="M254 70H300A31 31 0 0 1 300 132H254"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinejoin="miter"
      />
      <path
        d="M396 8H419A31 31 0 0 1 419 70H396A31 31 0 0 1 396 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
