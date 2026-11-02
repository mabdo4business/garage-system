import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginView } from "../src/components/login-view";
import { catalogs, htmlAttributes, LOCALES, t } from "../src/i18n";
import { dubaiDate, formatAed, formatDubaiDateTime } from "../src/i18n/format";
import { Money } from "../src/server/core/money";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Normalises the various Unicode spaces and direction marks that Intl inserts. */
const plain = (text: string) =>
  text
    .replace(/[  ‎‏؜]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("S10 — Arabic/English scaffolding", () => {
  it("both catalogs have exactly the same keys and no empty messages", () => {
    const [ar, en] = [catalogs.ar, catalogs.en];
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("every message key referenced in the source exists in every catalog", () => {
    const referenced = new Set<string>();
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*\w+\s*,\s*"([^"]+)"/g)) {
        referenced.add(match[1]!);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const key of referenced) {
      for (const locale of LOCALES) {
        expect(catalogs[locale][key], `${locale} is missing ${key}`).toBeDefined();
      }
    }
  });

  it("renders the login page right-to-left in Arabic", () => {
    const html = renderToStaticMarkup(
      <html {...htmlAttributes("ar")}>
        <body>
          <LoginView locale="ar" />
        </body>
      </html>,
    );
    expect(html).toContain('lang="ar"');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(t("ar", "login.title"));
    expect(html).toContain(t("ar", "login.submit"));
    expect(html).toContain('href="/en/login"');
  });

  it("renders the login page left-to-right in English, with the error message when sign-in failed", () => {
    const html = renderToStaticMarkup(
      <html {...htmlAttributes("en")}>
        <body>
          <LoginView locale="en" error />
        </body>
      </html>,
    );
    expect(html).toContain('dir="ltr"');
    expect(html).toContain("Staff sign-in");
    expect(html).toContain("The username or password is incorrect.");
  });

  it("formats AED amounts exactly in both languages", () => {
    const amount = Money.parse("1234.5");
    const en = plain(formatAed(amount, "en"));
    const ar = plain(formatAed(amount, "ar"));
    expect(en).toContain("AED");
    expect(en).toContain("1,234.50");
    expect(ar).toContain("1,234.50");
    expect(ar).toContain("د.إ");
    // A value beyond float precision is not rounded through a JavaScript number.
    expect(plain(formatAed(Money.parse("90071992547409.93"), "en"))).toContain("90,071,992,547,409.93");
  });

  it("formats dates in Asia/Dubai time", () => {
    const instant = new Date("2026-10-15T20:30:00Z"); // 00:30 on 16 October in Dubai
    expect(dubaiDate(instant)).toBe("2026-10-16");
    expect(plain(formatDubaiDateTime(instant, "en"))).toMatch(/16 Oct 2026/);
    expect(plain(formatDubaiDateTime(instant, "ar"))).toContain("2026");
  });
});
