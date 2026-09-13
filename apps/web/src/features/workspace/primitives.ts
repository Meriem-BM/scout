// Shared controls use the same native surfaces in every Scout flow.
export function buttonClassName(
  variant: "default" | "primary" | "quiet" | "danger" = "default",
  extra = "",
) {
  return `scout-button scout-button-${variant} ${extra}`;
}

export const iconButtonClassName = "control-icon";

export const inputClassName = "scout-input";

export const fieldClassName = "scout-field";

export const noticeClassName =
  "flex items-start gap-3 rounded-lg border border-neutral-700/80 bg-neutral-900/70 px-4 py-3 text-sm leading-6 text-neutral-300 [&_svg]:mt-1 [&_a]:underline [&_a]:underline-offset-4";

export const errorClassName =
  "flex items-start gap-3 rounded-lg border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm leading-6 text-red-300 [&_svg]:mt-1 [&_a]:underline [&_a]:underline-offset-4";

export const warningClassName =
  "flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm leading-6 text-amber-200 [&_svg]:mt-1 [&_a]:underline [&_a]:underline-offset-4";

export const dialogOverlayClassName = "scout-overlay";

export const dialogContentClassName = "scout-dialog";
