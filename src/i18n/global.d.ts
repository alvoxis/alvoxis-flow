import { type routing } from "./routing";
import type messages from "../../messages/en.json";

// English is the source catalog; other locales must match its keys (enforced by tests).
declare module "next-intl" {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages;
  }
}
