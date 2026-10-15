import { t, type Locale } from "../i18n";

export interface LoginViewProps {
  locale: Locale;
  error?: boolean;
}

/** Staff sign-in form. Posts to /api/auth/login; works without client-side JavaScript. */
export function LoginView({ locale, error = false }: LoginViewProps) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  return (
    <main className="card">
      <h1>{t(locale, "app.name")}</h1>
      <h2>{t(locale, "login.title")}</h2>
      {error ? (
        <p role="alert" className="error">
          {t(locale, "login.error")}
        </p>
      ) : null}
      <form method="post" action="/api/auth/login">
        <input type="hidden" name="locale" value={locale} />
        <label htmlFor="username">{t(locale, "login.username")}</label>
        <input id="username" name="username" autoComplete="username" required dir="ltr" />
        <label htmlFor="password">{t(locale, "login.password")}</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          dir="ltr"
        />
        <button type="submit">{t(locale, "login.submit")}</button>
      </form>
      <p>
        <a href={`/${other}/login`} hrefLang={other} lang={other}>
          {t(locale, "login.switchLanguage")}
        </a>
      </p>
    </main>
  );
}
