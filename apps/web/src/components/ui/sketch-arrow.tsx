/** Decorative connectors: rounded, asymmetric strokes inspired by ink arrows. */
export function SketchArrow({ loop = false }: { loop?: boolean }) {
  return (
    <svg
      className={`sketch-arrow${loop ? " sketch-arrow-loop" : ""}`}
      viewBox={loop ? "0 0 80 84" : "0 0 72 36"}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {loop ? (
        <>
          <path
            d="M14 8C-1 24 28 35 42 20C54 6 27 2 29 26C30 43 11 51 23 67C34 80 57 72 66 57"
            strokeDasharray="9 7"
          />
          <path d="M54 58Q62 58 68 53Q69 61 67 69" />
        </>
      ) : (
        <>
          <path d="M5 12C19 29 43 30 63 12" strokeDasharray="8 5" />
          <path d="M51 12Q59 13 65 9Q64 16 62 22" />
        </>
      )}
    </svg>
  );
}
