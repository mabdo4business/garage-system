import { notFound } from "next/navigation";
import { LoginView } from "../../../components/login-view";
import { isLocale } from "../../../i18n";

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  return <LoginView locale={locale} error={query.error === "1"} />;
}
