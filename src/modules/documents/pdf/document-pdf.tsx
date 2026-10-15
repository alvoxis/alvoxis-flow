import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import Decimal from "decimal.js";
import { type ReactNode } from "react";
import { maskIban, normalizeIban } from "@/lib/iban";
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
}

const C = {
  text: "#1d1a29",
  muted: "#6b6680",
  border: "#e3e0ec",
  accent: "#6d28d9",
  accentSoft: "#f3effd",
  warnBg: "#fff4d6",
  warnText: "#7a5200",
};

const s = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: 8.5,
    color: C.text,
    paddingTop: 36,
    paddingBottom: 56,
    paddingHorizontal: 36,
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
    marginBottom: 18,
  },
  sellerName: { fontSize: 13, fontWeight: 700, lineHeight: 1.3, marginBottom: 2 },
  title: { fontSize: 18, fontWeight: 700, color: C.accent, textAlign: "right", lineHeight: 1.2 },
  numberText: { fontSize: 10, fontWeight: 600, textAlign: "right", marginTop: 3, lineHeight: 1.3 },
  muted: { color: C.muted },
  metaRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.border,
    paddingVertical: 8,
    marginBottom: 14,
  },
  metaCell: { flexGrow: 1, flexBasis: 0, paddingRight: 8 },
  metaLabel: { fontSize: 7, color: C.muted, textTransform: "uppercase" },
  metaValue: { fontSize: 9.5, fontWeight: 600, marginTop: 1, lineHeight: 1.3 },
  metaValueAccent: {
    fontSize: 9.5,
    fontWeight: 700,
    marginTop: 1,
    color: C.accent,
    lineHeight: 1.3,
  },
  relation: { backgroundColor: C.accentSoft, padding: 6, marginBottom: 12, fontWeight: 600 },
  parties: { flexDirection: "row", marginBottom: 16 },
  party: { flexGrow: 1, flexBasis: 0, paddingRight: 12 },
  partyHeading: {
    fontSize: 7,
    color: C.accent,
    fontWeight: 700,
    textTransform: "uppercase",
    marginBottom: 3,
  },
  partyName: { fontSize: 10, fontWeight: 700, marginBottom: 1, lineHeight: 1.3 },
  th: {
    flexDirection: "row",
    backgroundColor: C.accentSoft,
    paddingVertical: 5,
    fontWeight: 700,
    fontSize: 7.5,
  },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: C.border, paddingVertical: 4.5 },
  num: { textAlign: "right" },
  totalsWrap: { flexDirection: "row", justifyContent: "flex-end", marginTop: 10 },
  totals: { width: "48%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5 },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: C.accent,
    color: "#ffffff",
    padding: 7,
    marginTop: 4,
    fontWeight: 700,
    fontSize: 11,
    lineHeight: 1.3,
  },
  converted: { fontSize: 7.5, color: C.muted, marginTop: 4, textAlign: "right" },
  section: { marginTop: 16 },
  sectionHeading: {
    fontSize: 7.5,
    color: C.accent,
    fontWeight: 700,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  smallTable: { borderTopWidth: 0.5, borderColor: C.border },
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
    left: 36,
    right: 36,
    bottom: 18,
    fontSize: 7,
    color: C.muted,
    textAlign: "right",
  },
  footer: {
    position: "absolute",
    left: 36,
    right: 36,
    bottom: 18,
    height: 30,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: C.muted,
    borderTopWidth: 0.5,
    borderColor: C.border,
    paddingTop: 5,
  },
});

function addressLines(a?: PostalAddress): string[] {
  if (!a) return [];
  const cityLine = [a.postalCode, a.city].filter(Boolean).join(" ");
  return [...a.lines.filter(Boolean), [cityLine, a.countryCode].filter(Boolean).join(", ")].filter(
    Boolean,
  );
}

function Party({
  heading,
  party,
  t,
}: {
  heading: string;
  party: PartySnapshot;
  t: ReturnType<typeof documentTranslator>;
}) {
  return (
    <View style={s.party}>
      <Text style={s.partyHeading}>{heading}</Text>
      <Text style={s.partyName}>{party.name}</Text>
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
    </View>
  );
}

function Meta({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={s.metaCell}>
      <Text style={s.metaLabel}>{label}</Text>
      <Text style={accent ? s.metaValueAccent : s.metaValue}>{value}</Text>
    </View>
  );
}

function Cell({
  w,
  children,
  right,
  bold,
}: {
  w: string;
  children: ReactNode;
  right?: boolean;
  bold?: boolean;
}) {
  return (
    <View style={{ width: w, paddingHorizontal: 3 }}>
      <Text style={[right ? s.num : {}, bold ? { fontWeight: 700 } : {}]}>{children}</Text>
    </View>
  );
}

export function DocumentPdf({ model }: { model: DocumentPdfModel }) {
  const { document: doc, totals } = model;
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

  const taxLabel = (kind: string, rate: string) =>
    kind === "standard"
      ? t("taxKind.standard", { rate: docNumber(rate, locale, 2) })
      : t(`taxKind.${kind as "exempt"}`);

  const cols: Record<
    "no" | "desc" | "qty" | "unit" | "price" | "disc" | "tax" | "amount" | "weight",
    string
  > = priced
    ? {
        no: "5%",
        desc: hasDiscount ? "37%" : "44%",
        qty: "9%",
        unit: "7%",
        price: "12%",
        disc: "7%",
        tax: "9%",
        amount: "14%",
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

          <View style={s.header}>
            <View style={{ width: "55%" }}>
              <Text style={s.sellerName}>{doc.seller.name}</Text>
              {addressLines(doc.seller.address).map((l, i) => (
                <Text key={i} style={s.muted}>
                  {l}
                </Text>
              ))}
            </View>
            <View style={{ width: "45%" }}>
              <Text style={s.title}>{title}</Text>
              {model.number ? (
                <Text style={s.numberText}>{`${t("number")} ${model.number}`}</Text>
              ) : null}
            </View>
          </View>

          <View style={s.metaRow}>
            <Meta label={t("issueDate")} value={docDate(doc.issueDate, locale)} />
            {doc.supplyDate ? (
              <Meta label={t("supplyDate")} value={docDate(doc.supplyDate, locale)} />
            ) : null}
            {doc.dueDate && priced ? (
              <Meta label={t("dueDate")} value={docDate(doc.dueDate, locale)} accent />
            ) : null}
            {doc.validUntil ? (
              <Meta label={t("validUntil")} value={docDate(doc.validUntil, locale)} />
            ) : null}
            {doc.buyerReference ? (
              <Meta label={t("buyerReference")} value={doc.buyerReference} />
            ) : null}
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
            <Party heading={t("seller")} party={doc.seller} t={t} />
            <Party heading={t("buyer")} party={doc.buyer} t={t} />
            {doc.deliverTo ? <Party heading={t("deliverTo")} party={doc.deliverTo} t={t} /> : null}
          </View>

          <View style={s.th}>
            <Cell w={cols.no}>{t("lineNo")}</Cell>
            <Cell w={cols.desc}>{t("description")}</Cell>
            <Cell w={cols.qty} right>
              {t("quantity")}
            </Cell>
            <Cell w={cols.unit}>{t("unit")}</Cell>
            {priced ? (
              <>
                <Cell w={cols.price} right>
                  {t("unitPrice")}
                </Cell>
                {hasDiscount ? (
                  <Cell w={cols.disc} right>
                    {t("discount")}
                  </Cell>
                ) : null}
                <Cell w={cols.tax} right>
                  {t("tax")}
                </Cell>
                <Cell w={cols.amount} right>
                  {t("amount")}
                </Cell>
              </>
            ) : hasWeight ? (
              <Cell w={cols.weight} right>
                {t("weight")}
              </Cell>
            ) : null}
          </View>
          {doc.lines.map((l, i) => (
            <View key={l.id} style={s.tr} wrap={false}>
              <Cell w={cols.no}>{String(i + 1)}</Cell>
              <Cell w={cols.desc}>{l.description}</Cell>
              <Cell w={cols.qty} right>
                {docNumber(l.quantity, locale)}
              </Cell>
              <Cell w={cols.unit}>{l.unit ?? ""}</Cell>
              {priced ? (
                <>
                  <Cell w={cols.price} right>
                    {l.unitPrice ? docUnitPrice(l.unitPrice, locale) : ""}
                  </Cell>
                  {hasDiscount ? (
                    <Cell w={cols.disc} right>
                      {l.discountPercent ? docNumber(l.discountPercent, locale, 2) : ""}
                    </Cell>
                  ) : null}
                  <Cell w={cols.tax} right>
                    {l.taxCategory ? taxLabel(l.taxCategory.kind, l.taxCategory.ratePercent) : ""}
                  </Cell>
                  <Cell w={cols.amount} right>
                    {netById.has(l.id) ? money(netById.get(l.id)!) : ""}
                  </Cell>
                </>
              ) : hasWeight ? (
                <Cell w={cols.weight} right>
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
              <Text style={s.sectionHeading}>{t("taxNotes")}</Text>
              {totals.taxSummary
                .filter((r) => r.note)
                .map((r) => (
                  <Text
                    key={r.code}
                  >{`${r.label} (${taxLabel(r.kind, r.ratePercent)}): ${r.note}`}</Text>
                ))}
            </View>
          ) : null}

          {doc.type !== "credit_note" &&
          priced &&
          (doc.bankAccounts.length > 0 || doc.paymentTerms || doc.dueDate) ? (
            <View style={s.section} wrap={false}>
              <Text style={s.sectionHeading}>{t("payment")}</Text>
              {doc.dueDate && doc.type === "invoice" ? (
                <Text style={{ fontWeight: 700 }}>
                  {t("payBy", { date: docDate(doc.dueDate, locale) })}
                </Text>
              ) : null}
              {doc.paymentTerms ? <Text>{`${t("paymentTerms")}: ${doc.paymentTerms}`}</Text> : null}
              {doc.bankAccounts.map((b, i) => (
                <Text key={i}>
                  {[
                    b.bankName ? `${t("bank")}: ${b.bankName}` : null,
                    `${t("iban")}: ${normalizeIban(b.iban)
                      .replace(/(.{4})/g, "$1 ")
                      .trim()}`,
                    b.bic ? `${t("bic")}: ${b.bic}` : null,
                  ]
                    .filter(Boolean)
                    .join("   ")}
                </Text>
              ))}
            </View>
          ) : null}

          {doc.notes ? (
            <View style={s.section} wrap={false}>
              <Text style={s.sectionHeading}>{t("notes")}</Text>
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
