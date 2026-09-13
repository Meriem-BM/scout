/** Shared diagram connector: a dashed hop with a solid head. */
export function FlowArrow() {
  return (
    <svg
      className="flow-arrow"
      viewBox="0 0 80 36"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="flow-arrow-shaft"
        d="M5 21C24 6 48 16 61 16"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray="6.5 5.5"
      />
      <path
        className="flow-arrow-head"
        d="M59 9.5 73 16 59 22.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
