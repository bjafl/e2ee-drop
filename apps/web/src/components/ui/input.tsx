import * as React from "react"
import { cn } from "cn"

// Flode: 36px (h-9) control, radius-md, `input` border (≥3:1 contrast), focus via
// the global 2px ring. Font size is 16px below `sm` so iOS doesn't zoom on focus.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm transition-colors duration-150 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive read-only:bg-muted/40 sm:text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className
      )}
      {...props}
    />
  )
}

export { Input }
