"use client";

import { useActionState } from "react";
import { Button, Field } from "../../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../../i18n";
import { FormErrorMessage } from "../../../../form-error";
import { EMPTY_FORM_STATE } from "../../../../form-state";
import {
  addJobAction,
  addLineAction,
  discardDraftAction,
  discountAction,
  excludeFindingAction,
  openEstimateAction,
  removeJobAction,
  removeLineAction,
  reproposeAction,
  sendEstimateAction,
  startVersionAction,
  updateQtyAction,
  withdrawAction,
} from "./actions";

/**
 * The estimate builder's small forms (I1-05a). One generic form: hidden ids, a few inputs, one button.
 * Typed values come back from the server on an error, so nothing the advisor typed is lost.
 */

const ACTIONS = {
  open: openEstimateAction,
  addJob: addJobAction,
  removeJob: removeJobAction,
  exclude: excludeFindingAction,
  addLine: addLineAction,
  qty: updateQtyAction,
  discount: discountAction,
  removeLine: removeLineAction,
  send: sendEstimateAction,
  startVersion: startVersionAction,
  withdraw: withdrawAction,
  discard: discardDraftAction,
  repropose: reproposeAction,
} as const;

export interface StepField {
  name: string;
  label: MessageKey;
  required?: boolean;
  defaultValue?: string;
  /** Numbers are typed as text with a decimal keyboard (never parsed as JS numbers, rule 5). */
  inputMode?: "decimal";
  options?: { group: string; items: { value: string; label: string }[] }[];
  placeholder?: MessageKey;
}

export function StepForm({
  locale,
  action,
  hidden,
  fields = [],
  submit,
  submitParams,
  variant = "secondary",
  inline = false,
}: {
  locale: Locale;
  action: keyof typeof ACTIONS;
  hidden: Record<string, string>;
  fields?: StepField[];
  submit: MessageKey;
  submitParams?: Record<string, string>;
  variant?: "primary" | "secondary" | "quiet";
  inline?: boolean;
}) {
  const [state, formAction, pending] = useActionState(ACTIONS[action], EMPTY_FORM_STATE);
  const prefix = `${action}-${Object.values(hidden).join("-")}`;
  return (
    <form action={formAction} key={state.seq} className={inline ? "form form-inline" : "form"}>
      <input type="hidden" name="locale" value={locale} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormErrorMessage locale={locale} error={state.error} />
      {fields.map((spec) => {
        const id = `${prefix}-${spec.name}`;
        const value = state.values[spec.name] ?? spec.defaultValue ?? "";
        return (
          <Field key={spec.name} id={id} label={t(locale, spec.label)}>
            {spec.options ? (
              <select id={id} name={spec.name} defaultValue={value} required={spec.required}>
                <option value="">{spec.placeholder ? t(locale, spec.placeholder) : ""}</option>
                {spec.options.map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.items.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input
                id={id}
                name={spec.name}
                defaultValue={value}
                required={spec.required}
                inputMode={spec.inputMode}
                dir={spec.inputMode ? "ltr" : "auto"}
                autoComplete="off"
              />
            )}
          </Field>
        );
      })}
      <div className="form-actions">
        <Button variant={variant} disabled={pending}>
          {t(locale, submit, submitParams)}
        </Button>
      </div>
    </form>
  );
}
