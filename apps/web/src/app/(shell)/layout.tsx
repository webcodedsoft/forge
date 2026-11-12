import { AppShell } from "@/components/app-shell";

/** Home and settings pages share the top bar and left navigation. */
export default function ShellLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
