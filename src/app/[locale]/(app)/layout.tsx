import { type ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { documentsEntryData } from "@/server/account/page-data";
import { requirePageUser } from "@/server/auth/page-session";

// Every page in the app group requires an authenticated session (re-checked on each request).
export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await requirePageUser(locale);
  const companies = await documentsEntryData(user);
  return (
    <AppShell
      user={{ email: user.email, displayName: user.displayName }}
      companies={companies.map((c) => ({ id: c.id, name: c.name }))}
    >
      {children}
    </AppShell>
  );
}
