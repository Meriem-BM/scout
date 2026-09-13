"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { X as XMarkIcon } from "lucide-react";

import type { ReactNode } from "react";

export function Popover({
  title,
  description,
  trigger,
  children,
}: {
  title: string;
  description: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={title}
          className="scout-popover"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <div className="popover-heading">
            <h2>{title}</h2>
            <PopoverPrimitive.Close
              aria-label="Close popover"
              className="control-icon"
            >
              <XMarkIcon />
            </PopoverPrimitive.Close>
          </div>
          <p className="popover-description">{description}</p>
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
