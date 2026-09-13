"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronsUpDown as ChevronUpDownIcon,
  ChevronUp as ChevronUpIcon,
} from "lucide-react";
import { Children, isValidElement } from "react";

import type { ReactNode } from "react";

type OptionProps = {
  value: string | number;
  children: ReactNode;
  disabled?: boolean;
};

/** One accessible select surface for rules, preferences, filters and swap review. */
export function Select({
  children,
  value,
  onValueChange,
  className = "",
  disabled,
  id,
  name,
  "aria-label": label,
  "aria-labelledby": labelledBy,
}: {
  children: ReactNode;
  value: string | number;
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const options = Children.toArray(children).filter(
    isValidElement<OptionProps>,
  );
  const placeholder = options.find(
    (option) => String(option.props.value) === "",
  )?.props.children;

  return (
    <SelectPrimitive.Root
      value={String(value)}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        aria-labelledby={labelledBy}
        className={`scout-select ${className}`}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronUpDownIcon />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="scout-menu select-menu"
          position="popper"
          sideOffset={5}
          align="end"
          collisionPadding={12}
        >
          <SelectPrimitive.ScrollUpButton className="select-scroll">
            <ChevronUpIcon />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="select-viewport">
            {options
              .filter((option) => String(option.props.value) !== "")
              .map((option) => (
                <SelectPrimitive.Item
                  key={String(option.props.value)}
                  value={String(option.props.value)}
                  disabled={option.props.disabled}
                  className="scout-menu-item"
                >
                  <SelectPrimitive.ItemText>
                    {option.props.children}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="menu-check">
                    <CheckIcon />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="select-scroll">
            <ChevronDownIcon />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
