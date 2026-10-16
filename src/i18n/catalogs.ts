import { type AppLocale } from "./config";
import en from "../../messages/en.json";
import et from "../../messages/et.json";
import lt from "../../messages/lt.json";
import lv from "../../messages/lv.json";
import ru from "../../messages/ru.json";

/** All message catalogs, for server-side translation outside a request (PDFs, emails). */
export const CATALOGS: Record<AppLocale, typeof en> = { en, ru, lv, lt, et };
