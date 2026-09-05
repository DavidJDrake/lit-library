import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../route";

interface Props { href: string; className?: string; onClick?: () => void; children: ReactNode }

export default function Link({ href, className, onClick, children }: Props) {
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onClick?.();
    navigate(href);
  }
  return <a href={href} className={className} onClick={handle}>{children}</a>;
}
