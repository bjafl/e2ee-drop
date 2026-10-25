// apps/web/src/components/common/Codewords.tsx
//
// Verification words as numbered chips, large mono type — the one visual a
// sender and recipient compare out loud, so it is deliberately prominent.
//
// The numbers are CSS-generated (counter), and the " · " separators are
// visually hidden, so the element's textContent stays "fox · river · lamp ·
// otter" — the same plain phrase screen readers announce and copy/paste yields.
import { useTranslation } from "react-i18next";
import { cn } from "cn";

export function Codewords({
  words,
  testId = "codewords",
  size = "lg",
  className,
}: {
  words: string[];
  testId?: string;
  size?: "lg" | "md";
  className?: string;
}) {
  const { t } = useTranslation("common");
  return (
    <ol
      aria-label={t("codewordsListLabel")}
      data-testid={testId}
      className={cn(
        "grid grid-cols-2 gap-2 [counter-reset:cw] sm:grid-cols-4",
        className
      )}
    >
      {words.map((word, i) => (
        <li
          key={`${i}-${word}`}
          className={cn(
            "flex min-w-0 items-baseline gap-2 rounded-md bg-muted font-mono [overflow-wrap:anywhere] font-medium [counter-increment:cw] before:font-sans before:text-xs before:font-medium before:text-muted-foreground before:content-[counter(cw)]",
            size === "lg" ? "px-3 py-2.5 text-base leading-6 sm:px-4 sm:py-3 sm:text-lg" : "px-3 py-2 text-base leading-6"
          )}
        >
          {word}
          {i < words.length - 1 && (
            <span className="sr-only" aria-hidden="true">
              {" · "}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Inline, compact variant for tables and lists: "fox · river · lamp · otter" in mono. */
export function CodewordsInline({ words, testId, className }: { words: string[]; testId?: string; className?: string }) {
  return (
    <span data-testid={testId} className={cn("font-mono text-[13px] leading-5", className)}>
      {words.join(" · ")}
    </span>
  );
}
