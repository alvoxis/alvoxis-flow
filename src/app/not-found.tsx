import Link from "next/link";
import "./globals.css";

// Fallback for paths outside any locale (the proxy normally redirects those).
// Locale is unknown here, so this minimal page links to the default-locale dashboard.
export default function GlobalNotFound() {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center">
        <Link href="/en" className="text-accent underline">
          ALVOXIS Flow
        </Link>
      </body>
    </html>
  );
}
