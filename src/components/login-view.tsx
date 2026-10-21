import { t, type Locale } from "../i18n";
import { Alert, Button, Field } from "./ui";

export interface LoginViewProps {
  locale: Locale;
  error?: boolean;
}

/** Staff sign-in form. Posts to /api/auth/login; works without client-side JavaScript. */
export function LoginView({ locale, error = false }: LoginViewProps) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <h1>{t(locale, "app.name")}</h1>
          <p className="muted">{t(locale, "login.title")}</p>
        </div>
        <section className="card">
          {error ? (
            <Alert tone="danger">
              <p>{t(locale, "login.error")}</p>
            </Alert>
          ) : null}
          <form method="post" action="/api/auth/login" className="form">
            <input type="hidden" name="locale" value={locale} />
            <Field id="username" label={t(locale, "login.username")}>
              <input id="username" name="username" autoComplete="username" required dir="ltr" />
            </Field>
            <Field id="password" label={t(locale, "login.password")}>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                dir="ltr"
              />
            </Field>
            <Button>{t(locale, "login.submit")}</Button>
          </form>
        </section>
        <p>
          <a href={`/${other}/login`} hrefLang={other} lang={other}>
            {t(locale, "login.switchLanguage")}
          </a>
        </p>
      </div>
    </main>
  );
}
