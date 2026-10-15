import { type ReactNode } from "react";
import "./globals.css";

// The <html> element is rendered by app/[locale]/layout.tsx so that `lang` is correct.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
