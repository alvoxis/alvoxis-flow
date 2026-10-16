import { type ReactNode } from "react";

// Auth pages read cookies and server configuration on every request.
export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
