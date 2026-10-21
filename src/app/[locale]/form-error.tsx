import { Alert } from "../../components/ui";
import { t, type Locale } from "../../i18n";
import { FIELD_LABELS, type FormError } from "./form-state";

/** The translated error line under a form; renders nothing when there is no error. */
export function FormErrorMessage({ locale, error }: { locale: Locale; error: FormError | undefined }) {
  if (!error) return null;
  const label = error.field ? FIELD_LABELS[error.field] : undefined;
  return (
    <Alert tone="danger">
      <p>
        {error.key === "error.validationFailed" && label
          ? t(locale, "error.validationField", { field: t(locale, label) })
          : t(locale, error.key)}
      </p>
    </Alert>
  );
}
