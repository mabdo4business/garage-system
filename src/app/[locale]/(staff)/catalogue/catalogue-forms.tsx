"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../components/ui";
import { t, type Locale } from "../../../../i18n";
import { FormErrorMessage } from "../../form-error";
import { EMPTY_FORM_STATE } from "../../form-state";
import { createItemAction, setActiveAction, setPriceAction, updateItemAction } from "./actions";

type Kind = "labor_rate" | "package" | "part";
const UNITS = ["piece", "set", "litre", "kg", "metre", "job"] as const;
const PART_TYPES = ["oem", "aftermarket", "other"] as const;

export interface TaxCodeOption {
  code: string;
  label: string;
}

function TaxCodeSelect({ locale, codes, value }: { locale: Locale; codes: TaxCodeOption[]; value?: string }) {
  return (
    <Field id="taxCode" label={t(locale, "catalogue.taxCode")}>
      <select id="taxCode" name="taxCode" defaultValue={value ?? codes[0]?.code ?? ""} required>
        {codes.map((code) => (
          <option key={code.code} value={code.code}>
            {t(locale, "catalogue.taxCodeOption", { code: code.code, label: code.label })}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PriceField({ locale, kind, value }: { locale: Locale; kind: Kind; value?: string }) {
  return (
    <Field
      id="price"
      label={t(locale, `catalogue.priceLabel.${kind}`)}
      hint={t(locale, "catalogue.priceInclVat")}
    >
      <input
        id="price"
        name="price"
        inputMode="decimal"
        defaultValue={value}
        required
        dir="ltr"
        autoComplete="off"
      />
    </Field>
  );
}

function DetailFields({
  locale,
  kind,
  values,
}: {
  locale: Locale;
  kind: Kind;
  values: Record<string, string>;
}) {
  const optional = t(locale, "common.optional");
  return (
    <>
      <div className="form-grid">
        <Field id="nameEn" label={t(locale, "catalogue.nameEn")}>
          <input id="nameEn" name="nameEn" defaultValue={values.nameEn} required dir="ltr" />
        </Field>
        <Field id="nameAr" label={t(locale, "catalogue.nameAr")}>
          <input id="nameAr" name="nameAr" defaultValue={values.nameAr} required dir="rtl" />
        </Field>
      </div>
      {kind === "part" ? (
        <div className="form-grid">
          <Field id="partNo" label={t(locale, "catalogue.partNo")} optionalLabel={optional}>
            <input id="partNo" name="partNo" defaultValue={values.partNo} dir="ltr" />
          </Field>
          <Field id="brand" label={t(locale, "catalogue.brand")} optionalLabel={optional}>
            <input id="brand" name="brand" defaultValue={values.brand} dir="ltr" />
          </Field>
          <Field id="partType" label={t(locale, "catalogue.partType")} optionalLabel={optional}>
            <select id="partType" name="partType" defaultValue={values.partType ?? ""}>
              <option value="">—</option>
              {PART_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(locale, `catalogue.partType.${type}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="unit" label={t(locale, "catalogue.unit")}>
            <select id="unit" name="unit" defaultValue={values.unit || "piece"} required>
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {t(locale, `catalogue.unit.${unit}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      <div className="form-grid">
        <Field id="descriptionEn" label={t(locale, "catalogue.descriptionEn")} optionalLabel={optional}>
          <textarea id="descriptionEn" name="descriptionEn" defaultValue={values.descriptionEn} dir="ltr" />
        </Field>
        <Field id="descriptionAr" label={t(locale, "catalogue.descriptionAr")} optionalLabel={optional}>
          <textarea id="descriptionAr" name="descriptionAr" defaultValue={values.descriptionAr} dir="rtl" />
        </Field>
      </div>
    </>
  );
}

export function CreateItemForm({
  locale,
  kind,
  idempotencyKey,
  taxCodes,
}: {
  locale: Locale;
  kind: Kind;
  idempotencyKey: string;
  taxCodes: TaxCodeOption[];
}) {
  const [state, formAction, pending] = useActionState(createItemAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="kind" value={kind} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-grid">
        <Field id="code" label={t(locale, "catalogue.code")} hint={t(locale, "catalogue.codeHint")}>
          <input
            id="code"
            name="code"
            defaultValue={state.values.code}
            required
            dir="ltr"
            autoComplete="off"
          />
        </Field>
        <PriceField locale={locale} kind={kind} value={state.values.price} />
        <TaxCodeSelect locale={locale} codes={taxCodes} value={state.values.taxCode} />
      </div>
      <DetailFields locale={locale} kind={kind} values={state.values} />
      {kind === "part" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            name="stockTracked"
            defaultChecked={state.seq === 0 ? true : state.values.stockTracked === "on"}
          />
          {t(locale, "catalogue.stockTracked")}
        </label>
      ) : null}
      {kind === "part" ? <p className="muted">{t(locale, "catalogue.stockTrackedHint")}</p> : null}
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "catalogue.create")}</Button>
      </div>
    </form>
  );
}

export function SetPriceForm({
  locale,
  itemId,
  kind,
  idempotencyKey,
  taxCodes,
  currentTaxCode,
}: {
  locale: Locale;
  itemId: string;
  kind: Kind;
  idempotencyKey: string;
  taxCodes: TaxCodeOption[];
  currentTaxCode: string | null;
}) {
  const [state, formAction, pending] = useActionState(setPriceAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-grid">
        <PriceField locale={locale} kind={kind} value={state.values.price} />
        <TaxCodeSelect
          locale={locale}
          codes={taxCodes}
          value={state.values.taxCode || currentTaxCode || undefined}
        />
      </div>
      <p className="muted">{t(locale, "catalogue.priceChangeHint")}</p>
      <div className="form-actions">
        <Button disabled={pending}>{t(locale, "catalogue.setPrice")}</Button>
      </div>
    </form>
  );
}

export function EditItemForm({
  locale,
  itemId,
  kind,
  initial,
}: {
  locale: Locale;
  itemId: string;
  kind: Kind;
  initial: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(updateItemAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} key={state.seq} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="itemId" value={itemId} />
      <FormErrorMessage locale={locale} error={state.error} />
      <DetailFields locale={locale} kind={kind} values={{ ...initial, ...state.values }} />
      <div className="form-actions">
        <Button variant="secondary" disabled={pending}>
          {t(locale, "finding.saveChanges")}
        </Button>
      </div>
    </form>
  );
}

export function ActiveForm({ locale, itemId, active }: { locale: Locale; itemId: string; active: boolean }) {
  const [state, formAction, pending] = useActionState(setActiveAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="form">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <FormErrorMessage locale={locale} error={state.error} />
      <div className="form-actions">
        <Button variant="secondary" disabled={pending}>
          {t(locale, active ? "catalogue.deactivate" : "catalogue.reactivate")}
        </Button>
      </div>
    </form>
  );
}
