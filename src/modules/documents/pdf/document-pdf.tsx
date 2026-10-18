import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import Decimal from "decimal.js";
import { type ReactNode } from "react";
import { maskIban, normalizeIban } from "@/lib/iban";
import { type PdfAccent, resolvePdfAccent } from "@/lib/pdf-accent";
import {
  type DocumentDraft,
  type DocumentTotals,
  isPricedDocument,
  type PartySnapshot,
  type PostalAddress,
} from "../domain/types";
import { PDF_FONT_FAMILY } from "./fonts";
import { docDate, docMoney, docNumber, docRate, docUnitPrice } from "./format";
import { documentTranslator } from "./labels";

export interface DocumentPdfModel {
  document: DocumentDraft;
  status: "draft" | "issued";
  number: string | null;
  totals: DocumentTotals | null;
  contentHash?: string | null;
  /**
   * The company's accent colour (presentation only: it never changes content or totals). Missing
   * or unknown values fall back to the default palette entry.
   */
  accent?: PdfAccent | null;
}

/** Neutral colours shared by every accent: white page, dark text, light-grey rules. */
const C = {
  text: "#1f2328",
  muted: "#5c6370",
  rule: "#d9dce1",
  warnBg: "#fff4d6",
  warnText: "#7a5200",
};

function createStyles(accent: string, tint: string) {
  return StyleSheet.create({
    page: {
      fontFamily: PDF_FONT_FAMILY,
      fontSize: 8.5,
      color: C.text,
      backgroundColor: "#ffffff",
      paddingTop: 36,
      paddingBottom: 60,
      paddingHorizontal: 40,
    },
    // lineHeight lives here, not on <Page>: a page-level lineHeight with a custom font makes
    // react-pdf (4.9) drop render-prop text such as page numbers.
    body: { fontSize: 8.5, lineHeight: 1.35 },
    draft: {
      backgroundColor: C.warnBg,
      color: C.warnText,
      padding: 6,
      marginBottom: 12,
      textAlign: "center",
      fontWeight: 700,
      fontSize: 9,
      lineHeight: 1.3,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      paddingBottom: 10,
      borderBottomWidth: 1.25,
      borderColor: accent,
      marginBottom: 12,
    },
    seller: { width: "58%", paddingRight: 12 },
    sellerName: { fontSize: 14, fontWeight: 700, lineHeight: 1.25, marginBottom: 3 },
    titleBox: { width: "42%" },
    title: {
      fontSize: 20,
      fontWeight: 700,
      color: accent,
      textAlign: "right",
      lineHeight: 1.15,
      textTransform: "uppercase",
    },
    numberText: {
      fontSize: 10.5,
      fontWeight: 600,
      textAlign: "right",
      marginTop: 4,
      lineHeight: 1.3,
    },
    muted: { color: C.muted },
    metaRow: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderColor: C.rule,
      paddingBottom: 8,
      marginBottom: 14,
    },
    metaCell: { flexGrow: 1, flexBasis: 0, paddingRight: 8 },
    metaLabel: { fontSize: 6.5, color: C.muted, textTransform: "uppercase" },
    metaValue: { fontSize: 9.5, fontWeight: 600, marginTop: 1, lineHeight: 1.3 },
    relation: {
      backgroundColor: tint,
      borderLeftWidth: 2,
      borderColor: accent,
      paddingVertical: 5,
      paddingHorizontal: 8,
      marginBottom: 14,
      fontWeight: 600,
    },
    parties: { flexDirection: "row", marginBottom: 18, alignItems: "flex-start" },
    party: { flexGrow: 1, flexBasis: 0, paddingRight: 12 },
    heading: {
      fontSize: 6.5,
      color: accent,
      fontWeight: 700,
      textTransform: "uppercase",
      marginBottom: 4,
    },
    partyName: { fontSize: 10, fontWeight: 700, marginBottom: 1, lineHeight: 1.3 },
    due: {
      width: "40%",
      borderWidth: 1,
      borderColor: accent,
      backgroundColor: tint,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    dueRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
    dueDate: { fontSize: 14, fontWeight: 700, color: accent, lineHeight: 1.2 },
    dueAmount: { marginTop: 4, flexDirection: "row", justifyContent: "space-between" },
    th: {
      flexDirection: "row",
      borderBottomWidth: 1,
      borderColor: accent,
      paddingBottom: 4,
      fontWeight: 700,
      fontSize: 7,
      color: C.muted,
      textTransform: "uppercase",
    },
    tr: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: C.rule, paddingVertical: 5 },
    num: { textAlign: "right" },
    totalsWrap: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },
    totals: { width: "46%" },
    totalRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 3,
      borderBottomWidth: 0.5,
      borderColor: C.rule,
    },
    grandRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingTop: 7,
      paddingBottom: 4,
      marginTop: 2,
      borderTopWidth: 1.25,
      borderColor: accent,
      color: accent,
      fontWeight: 700,
      fontSize: 12,
      lineHeight: 1.3,
    },
    // A double rule under the grand total, as on a ledger.
    grandRule: { borderBottomWidth: 0.75, borderColor: accent, marginTop: 1.5 },
    converted: { fontSize: 7.5, color: C.muted, marginTop: 6, textAlign: "right" },
    section: { marginTop: 18 },
    infoRow: { flexDirection: "row", marginBottom: 1.5 },
    // Wide enough for the longest label in all five languages (e.g. lv "Maksājuma noteikumi").
    infoLabel: { width: 104, paddingRight: 8, color: C.muted },
    infoValue: { flexGrow: 1, flexBasis: 0 },
    signatureRow: { flexDirection: "row", marginTop: 36 },
    signatureBox: {
      flexGrow: 1,
      flexBasis: 0,
      marginRight: 24,
      borderTopWidth: 0.75,
      borderColor: C.muted,
      paddingTop: 3,
    },
    // Spans the full width (left + right): render-prop text has no intrinsic width at layout time.
    pageNumber: {
      position: "absolute",
      left: 40,
      right: 40,
      bottom: 22,
      fontSize: 7,
      color: C.muted,
      textAlign: "right",
    },
    footer: {
      position: "absolute",
      left: 40,
      right: 40,
      bottom: 22,
      height: 30,
      flexDirection: "row",
      justifyContent: "space-between",
      fontSize: 7,
      color: C.muted,
      borderTopWidth: 0.5,
      borderColor: C.rule,
      paddingTop: 5,
    },
  });
}

type Styles = ReturnType<typeof createStyles>;
const stylesByAccent = new Map<string, Styles>();

/** Styles for a palette entry, built once per accent. */
function stylesFor(accent: PdfAccent | null | undefined): Styles {
  const colors = resolvePdfAccent(accent);
  let styles = stylesByAccent.get(colors.accent);
  if (!styles) {
    styles = createStyles(colors.accent, colors.tint);
    stylesByAccent.set(colors.accent, styles);
  }
  return styles;
}

function addressLines(a?: PostalAddress): string[] {
  if (!a) return [];
  const cityLine = [a.postalCode, a.city].filter(Boolean).join(" ");
  return [...a.lines.filter(Boolean), [cityLine, a.countryCode].filter(Boolean).join(", ")].filter(
    Boolean,
  );
}

type Translator = ReturnType<typeof documentTranslator>;

/** Identification lines of a party; only the fields that are present. */
function PartyDetails({ party, t, s }: { party: PartySnapshot; t: Translator; s: Styles }) {
  return (
    <>
      {addressLines(party.address).map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      {party.legalAddress ? (
        <Text
          style={s.muted}
        >{`${t("legalAddress")}: ${addressLines(party.legalAddress).join(", ")}`}</Text>
      ) : null}
      {party.registrationNumber ? (
        <Text>{`${t("registrationNumber")} ${party.registrationNumber}`}</Text>
      ) : null}
      {party.vatNumber ? <Text>{`${t("vatNumber")} ${party.vatNumber}`}</Text> : null}
      {party.email ? <Text style={s.muted}>{`${t("email")}: ${party.email}`}</Text> : null}
      {party.phone ? <Text style={s.muted}>{`${t("phone")}: ${party.phone}`}</Text> : null}
    </>
  );
}

function Party({
  heading,
  party,
  t,
  s,
}: {
  heading: string;
  party: PartySnapshot;
  t: Translator;
  s: Styles;
}) {
  return (
    <View style={s.party}>
      <Text style={s.heading}>{heading}</Text>
      <Text style={s.partyName}>{party.name}</Text>
      <PartyDetails party={party} t={t} s={s} />
    </View>
  );
}

function Meta({ label, value, s }: { label: string; value: string; s: Styles }) {
  return (
    <View style={s.metaCell}>
      <Text style={s.metaLabel}>{label}</Text>
      <Text style={s.metaValue}>{value}</Text>
    </View>
  );
}

function Info({ label, value, s }: { label: string; value: string; s: Styles }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue}>{value}</Text>
    </View>
  );
}

/**
 * Break points for words longer than `max` characters, so a long single word (e.g. et
 * "Pöördmaksustamine" in the tax column, or a long product code) wraps with a hyphen instead of
 * running into the next column. Shorter words, numbers and amounts are never split.
 */
function breakLongWords(max: number) {
  return (word: string) => (word.length <= max ? [word] : (word.match(/.{1,3}/gu) ?? [word]));
}
const TAX_BREAKS = breakLongWords(9);
const TEXT_BREAKS = breakLongWords(24);

function Cell({
  w,
  children,
  right,
  bold,
  breaks,
  s,
}: {
  w: string;
  children: ReactNode;
  right?: boolean;
  bold?: boolean;
  breaks?: (word: string) => string[];
  s: Styles;
}) {
  return (
    <View style={{ width: w, paddingHorizontal: 3 }}>
      <Text
        hyphenationCallback={breaks}
        style={[right ? s.num : {}, bold ? { fontWeight: 700 } : {}]}
      >
        {children}
      </Text>
    </View>
  );
}

export function DocumentPdf({ model }: { model: DocumentPdfModel }) {
  const { document: doc, totals } = model;
  const s = stylesFor(model.accent);
  const locale = doc.language;
  const t = documentTranslator(locale);
  const priced = isPricedDocument(doc.type);
  const money = (v: string) => docMoney(v, doc.currency, locale);
  const title = t(`title.${doc.type}`);
  const hasDiscount = doc.lines.some(
    (l) => l.discountPercent && !new Decimal(l.discountPercent).isZero(),
  );
  const hasWeight = doc.lines.some((l) => l.weightKg);
  const netById = new Map(totals?.lines.map((l) => [l.lineId, l.net]) ?? []);
  // The prominent "pay by" block: invoices with a due date only (not proformas or credit notes).
  const showDue = doc.type === "invoice" && Boolean(doc.dueDate);

  const taxLabel = (kind: string, rate: string) =>
    kind === "standard"
      ? t("taxKind.standard", { rate: docNumber(rate, locale, 2) })
      : t(`taxKind.${kind as "exempt"}`);

  const cols: Record<
    "no" | "desc" | "qty" | "unit" | "price" | "disc" | "tax" | "amount" | "weight",
    string
  > = priced
    ? {
        no: "4%",
        desc: hasDiscount ? "34%" : "41%",
        qty: "8%",
        unit: "7%",
        price: "12%",
        disc: "7%",
        tax: "13%",
        amount: "15%",
        weight: "0%",
      }
    : {
        no: "5%",
        desc: hasWeight ? "55%" : "71%",
        qty: "12%",
        unit: "12%",
        price: "0%",
        disc: "0%",
        tax: "0%",
        amount: "0%",
        weight: "16%",
      };

  // A total quantity is only meaningful when every line uses the same unit.
  const units = new Set(doc.lines.map((l) => l.unit ?? ""));
  const totalQty =
    units.size === 1
      ? doc.lines.reduce((a, l) => a.plus(l.quantity), new Decimal(0)).toFixed()
      : null;
  const totalWeight = doc.lines
    .reduce((a, l) => a.plus(l.weightKg ?? "0"), new Decimal(0))
    .toFixed();

  const metas = [
    { label: t("issueDate"), value: docDate(doc.issueDate, locale) },
    doc.supplyDate ? { label: t("supplyDate"), value: docDate(doc.supplyDate, locale) } : null,
    // Shown here when there is no separate due-date block (e.g. proformas).
    doc.dueDate && priced && !showDue
      ? { label: t("dueDate"), value: docDate(doc.dueDate, locale) }
      : null,
    doc.validUntil ? { label: t("validUntil"), value: docDate(doc.validUntil, locale) } : null,
    doc.buyerReference ? { label: t("buyerReference"), value: doc.buyerReference } : null,
  ].filter((m) => m !== null);

  const showPayment =
    doc.type !== "credit_note" && priced && (doc.bankAccounts.length > 0 || doc.paymentTerms);

  return (
    <Document
      title={`${title} ${model.number ?? ""}`.trim()}
      author={doc.seller.name}
      language={locale}
      producer="ALVOXIS Flow"
      creator="ALVOXIS Flow"
    >
      <Page size="A4" style={s.page}>
        <View style={s.body}>
          {model.status === "draft" ? <Text style={s.draft}>{t("draftWatermark")}</Text> : null}

          {/* Seller identity on the left, document title and number on the right. */}
          <View style={s.header}>
            <View style={s.seller}>
              <Text style={s.heading}>{t("seller")}</Text>
              <Text style={s.sellerName}>{doc.seller.name}</Text>
              <PartyDetails party={doc.seller} t={t} s={s} />
            </View>
            <View style={s.titleBox}>
              <Text style={s.title}>{title}</Text>
              {model.number ? (
                <Text style={s.numberText}>{`${t("number")} ${model.number}`}</Text>
              ) : null}
            </View>
          </View>

          <View style={s.metaRow}>
            {metas.map((m) => (
              <Meta key={m.label} label={m.label} value={m.value} s={s} />
            ))}
          </View>

          {doc.relation ? (
            <Text style={s.relation}>
              {t(`relation.${doc.relation.kind}`, {
                number: doc.relation.documentNumber,
                date: docDate(doc.relation.issueDate, locale),
              })}
            </Text>
          ) : null}

          <View style={s.parties}>
            <Party heading={t("buyer")} party={doc.buyer} t={t} s={s} />
            {doc.deliverTo ? (
              <Party heading={t("deliverTo")} party={doc.deliverTo} t={t} s={s} />
            ) : null}
            {showDue ? (
              <View style={s.due} wrap={false}>
                {/* Label and date on one line: readable at a glance, and the PDF import can pair
                    them (it reads a date next to or directly below its label). */}
                <View style={s.dueRow}>
                  <Text style={[s.heading, { marginBottom: 2 }]}>{t("dueDate")}</Text>
                  <Text style={s.dueDate}>{docDate(doc.dueDate!, locale)}</Text>
                </View>
                {totals ? (
                  <View style={s.dueAmount}>
                    <Text style={s.muted}>{t("amountDue")}</Text>
                    <Text style={{ fontWeight: 700 }}>{money(totals.grossTotal)}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>

          <View style={s.th}>
            <Cell w={cols.no} s={s}>
              {t("lineNo")}
            </Cell>
            <Cell w={cols.desc} s={s}>
              {t("description")}
            </Cell>
            <Cell w={cols.qty} right s={s}>
              {t("quantity")}
            </Cell>
            <Cell w={cols.unit} s={s}>
              {t("unit")}
            </Cell>
            {priced ? (
              <>
                <Cell w={cols.price} right s={s}>
                  {t("unitPrice")}
                </Cell>
                {hasDiscount ? (
                  <Cell w={cols.disc} right s={s}>
                    {t("discount")}
                  </Cell>
                ) : null}
                <Cell w={cols.tax} right s={s}>
                  {t("tax")}
                </Cell>
                <Cell w={cols.amount} right s={s}>
                  {t("amount")}
                </Cell>
              </>
            ) : hasWeight ? (
              <Cell w={cols.weight} right s={s}>
                {t("weight")}
              </Cell>
            ) : null}
          </View>
          {doc.lines.map((l, i) => (
            <View key={l.id} style={s.tr} wrap={false}>
              <Cell w={cols.no} s={s}>
                {String(i + 1)}
              </Cell>
              <Cell w={cols.desc} breaks={TEXT_BREAKS} s={s}>
                {l.description}
              </Cell>
              <Cell w={cols.qty} right s={s}>
                {docNumber(l.quantity, locale)}
              </Cell>
              <Cell w={cols.unit} s={s}>
                {l.unit ?? ""}
              </Cell>
              {priced ? (
                <>
                  <Cell w={cols.price} right s={s}>
                    {l.unitPrice ? docUnitPrice(l.unitPrice, locale) : ""}
                  </Cell>
                  {hasDiscount ? (
                    <Cell w={cols.disc} right s={s}>
                      {l.discountPercent ? docNumber(l.discountPercent, locale, 2) : ""}
                    </Cell>
                  ) : null}
                  <Cell w={cols.tax} right breaks={TAX_BREAKS} s={s}>
                    {l.taxCategory ? taxLabel(l.taxCategory.kind, l.taxCategory.ratePercent) : ""}
                  </Cell>
                  <Cell w={cols.amount} right s={s}>
                    {netById.has(l.id) ? money(netById.get(l.id)!) : ""}
                  </Cell>
                </>
              ) : hasWeight ? (
                <Cell w={cols.weight} right s={s}>
                  {l.weightKg ? docNumber(l.weightKg, locale, 3) : ""}
                </Cell>
              ) : null}
            </View>
          ))}

          {priced && totals ? (
            <View style={s.totalsWrap} wrap={false}>
              <View style={s.totals}>
                <View style={s.totalRow}>
                  <Text>{t("netTotal")}</Text>
                  <Text>{money(totals.netTotal)}</Text>
                </View>
                {totals.taxSummary.map((r) => (
                  <View key={`${r.code}|${r.kind}|${r.ratePercent}`} style={s.totalRow}>
                    <Text
                      style={s.muted}
                    >{`${t("tax")} ${taxLabel(r.kind, r.ratePercent)} · ${money(r.taxableAmount)}`}</Text>
                    <Text>{money(r.taxAmount)}</Text>
                  </View>
                ))}
                <View style={s.totalRow}>
                  <Text>{t("taxTotal")}</Text>
                  <Text>{money(totals.taxTotal)}</Text>
                </View>
                <View style={s.grandRow}>
                  <Text>{doc.type === "credit_note" ? t("creditTotal") : t("grossTotal")}</Text>
                  <Text>{money(totals.grossTotal)}</Text>
                </View>
                <View style={s.grandRule} />
                {totals.converted ? (
                  <Text style={s.converted}>
                    {`${t("converted", {
                      currency: totals.converted.currency,
                      from: totals.converted.rate.from,
                      rate: docRate(totals.converted.rate.rate, locale),
                      date: docDate(totals.converted.rate.rateDate, locale),
                      source:
                        totals.converted.rate.source.kind === "manual"
                          ? t("rateSourceManual")
                          : t("rateSourceReference", {
                              provider: totals.converted.rate.source.provider,
                            }),
                    })}: ${t("netTotal")} ${docMoney(totals.converted.netTotal, totals.converted.currency, locale)} · ${t("taxTotal")} ${docMoney(
                      totals.converted.taxTotal,
                      totals.converted.currency,
                      locale,
                    )} · ${t("grossTotal")} ${docMoney(totals.converted.grossTotal, totals.converted.currency, locale)}`}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          {!priced ? (
            <View style={s.totalsWrap} wrap={false}>
              <View style={s.totals}>
                {totalQty !== null ? (
                  <View style={s.totalRow}>
                    <Text>{t("totalQuantity")}</Text>
                    <Text>{`${docNumber(totalQty, locale)} ${[...units][0]}`.trim()}</Text>
                  </View>
                ) : null}
                {hasWeight ? (
                  <View style={s.totalRow}>
                    <Text>{t("totalWeight")}</Text>
                    <Text>{docNumber(totalWeight, locale, 3)}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}

          {priced && totals && totals.taxSummary.some((r) => r.note) ? (
            <View style={s.section} wrap={false}>
              <Text style={s.heading}>{t("taxNotes")}</Text>
              {totals.taxSummary
                .filter((r) => r.note)
                .map((r) => (
                  <Text
                    key={r.code}
                  >{`${r.label} (${taxLabel(r.kind, r.ratePercent)}): ${r.note}`}</Text>
                ))}
            </View>
          ) : null}

          {showPayment ? (
            <View style={s.section} wrap={false}>
              <Text style={s.heading}>{t("payment")}</Text>
              {doc.paymentTerms ? (
                <Info label={t("paymentTerms")} value={doc.paymentTerms} s={s} />
              ) : null}
              {doc.bankAccounts.map((b, i) => (
                <View key={i} style={i > 0 ? { marginTop: 4 } : undefined}>
                  {b.bankName ? <Info label={t("bank")} value={b.bankName} s={s} /> : null}
                  <Info
                    label={t("iban")}
                    value={normalizeIban(b.iban)
                      .replace(/(.{4})/g, "$1 ")
                      .trim()}
                    s={s}
                  />
                  {b.bic ? <Info label={t("bic")} value={b.bic} s={s} /> : null}
                </View>
              ))}
            </View>
          ) : null}

          {doc.notes ? (
            <View style={s.section} wrap={false}>
              <Text style={s.heading}>{t("notes")}</Text>
              <Text>{doc.notes}</Text>
            </View>
          ) : null}

          {doc.type === "delivery_note" ? (
            <View style={s.signatureRow} wrap={false}>
              <View style={s.signatureBox}>
                <Text style={{ fontWeight: 700 }}>{t("issuedBy")}</Text>
                <Text style={s.muted}>{t("signatureLine")}</Text>
              </View>
              <View style={s.signatureBox}>
                <Text style={{ fontWeight: 700 }}>{t("receivedBy")}</Text>
                <Text style={s.muted}>{t("signatureLine")}</Text>
              </View>
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <View style={{ width: "75%" }}>
            {doc.footer ? <Text>{doc.footer}</Text> : null}
            {model.contentHash ? (
              <Text>{t("fingerprint", { hash: model.contentHash.slice(0, 16) })}</Text>
            ) : null}
          </View>
        </View>
        <Text
          fixed
          style={s.pageNumber}
          render={({ pageNumber, totalPages }) =>
            t("page", { page: pageNumber, total: totalPages })
          }
        />
      </Page>
    </Document>
  );
}

/** For logs and previews where account numbers must not be shown in full. */
export { maskIban };
