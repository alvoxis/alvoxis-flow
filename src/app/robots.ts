import { type MetadataRoute } from "next";
import { publicOrigin } from "@/components/public/metadata";

/**
 * Crawlers may read the public website; API routes and the signed-in application are excluded
 * (app pages also send noindex). Preview deployments are kept out of search engines entirely.
 */
export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/*/companies/", "/*/account/", "/*/admin"],
    },
    sitemap: `${publicOrigin()}/sitemap.xml`,
  };
}
