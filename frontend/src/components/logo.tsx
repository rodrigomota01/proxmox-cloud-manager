import { useId } from "react";

const PATH =
  "M384 326 H492 A42 42 0 1 0 460.0 256.8 A56 56 0 0 0 352.3 241.7 A42 42 0 1 0 338.0 316.8 C372 316.8 400 262.8 460.0 256.8";

/** The cloud mark alone (one stroke, blue gradient): reads on light and dark surfaces. */
export function LogoMark({ className = "h-8 w-auto" }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="276 166 270 182" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="280" y1="0" x2="540" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3fb8ee" />
          <stop offset="0.55" stopColor="#2f8fe0" />
          <stop offset="1" stopColor="#2e3192" />
        </linearGradient>
      </defs>
      <path d={PATH} fill="none" stroke={`url(#${id})`} strokeWidth="17" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Mark + wordmark. The name is text (not baked into the image) so it follows the theme. */
export function Logo({ size = "sm" }: { size?: "sm" | "lg" }) {
  const lg = size === "lg";
  return (
    <span className={`flex items-center ${lg ? "flex-col gap-2" : "gap-2"}`} aria-label="Cloud Manager System">
      <LogoMark className={lg ? "h-14 w-auto" : "h-7 w-auto"} />
      <span className={`flex flex-col leading-none ${lg ? "items-center" : ""}`}>
        <span className={`font-semibold uppercase tracking-wide ${lg ? "text-xl" : "text-sm"}`}>Cloud Manager</span>
        <span className={`font-medium uppercase text-sky-600 dark:text-sky-400 ${lg ? "mt-1 text-xs tracking-[0.4em]" : "mt-0.5 text-[0.6rem] tracking-[0.35em]"}`}>
          System
        </span>
      </span>
    </span>
  );
}
