// The Plimail mark (a folded-corner envelope) and its wordmark. Monochrome: the stroke is
// currentColor, so it follows the text colour of wherever it sits and needs no theme plumbing.
export default function LogoMark({ size = 32 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M8 13a2 2 0 0 1 2-2h21l9 9v15a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z" />
      <path d="M31 11v9h9" />
      <path d="M8 15l16 12 7-5.3" />
    </svg>
  );
}

export function Wordmark({ size = 17 }) {
  return (
    <span style={{
      fontFamily: "'Inter', system-ui, sans-serif",
      fontSize: size, fontWeight: 600, letterSpacing: '-0.03em',
      lineHeight: 1, whiteSpace: 'nowrap',
    }}>
      plimail
    </span>
  );
}
