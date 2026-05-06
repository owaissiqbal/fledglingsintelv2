import Link from "next/link";
import { RefreshButton } from "./RefreshButton";

export function Nav() {
  return (
    <nav className="bg-fl-navy text-fl-white">
      <div className="container mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 group">
            <span
              aria-hidden
              className="grid h-8 w-8 place-items-center rounded-md bg-fl-orange font-bold text-white shadow-sm transition-transform group-hover:scale-105"
            >
              F
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold tracking-tight">
                Fledglings
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-fl-mango">
                Inspection Intel
              </span>
            </span>
          </Link>
          <div className="hidden items-center gap-1 md:flex">
            <NavLink href="/" label="Overview" />
            <NavLink href="/itps" label="ITPs" />
            <NavLink href="/universities" label="Universities" />
            <NavLink href="/opportunities" label="Opportunities" />
            <NavLink href="/qa" label="QA" />
          </div>
        </div>
        <RefreshButton />
      </div>
    </nav>
  );
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
    >
      {label}
    </Link>
  );
}
