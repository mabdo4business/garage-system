"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { t, type Locale, type MessageKey } from "../../i18n";
import { FormErrorMessage } from "./form-error";
import { EMPTY_FORM_STATE, type FormState } from "./form-state";

/**
 * A small form around one server action: hidden ids, server-rendered fields as children, one button, and the
 * translated error the action returns. The action is passed in from the server page.
 */
export function ActionForm({
  locale,
  action,
  hidden,
  submit,
  variant = "secondary",
  children,
  className,
}: {
  locale: Locale;
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  submit: MessageKey;
  variant?: "primary" | "secondary" | "quiet";
  children?: ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className={className ?? "form"}>
      <input type="hidden" name="locale" value={locale} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <FormErrorMessage locale={locale} error={state.error} />
      {children}
      <div className="form-actions">
        <Button variant={variant} disabled={pending}>
          {t(locale, submit)}
        </Button>
      </div>
    </form>
  );
}
