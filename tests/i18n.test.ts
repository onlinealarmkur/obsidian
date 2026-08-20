import { describe, expect, it } from "vitest";
import {
  createI18n,
  LOCALE_DICTIONARIES,
  resolveLocale,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage
} from "../src/i18n";
import type { Messages } from "../src/i18n/messages";
import type { TimerItem } from "../src/types";

function renderedValues(messages: Messages): string[] {
  const renderedValues: string[] = [];
  for (const key of Object.keys(messages) as (keyof Messages)[]) {
    const value: unknown = messages[key];
    if (typeof value === "string") renderedValues.push(value);
    else if (typeof value === "function") {
      const rendered: unknown = Reflect.apply(value as (...args: unknown[]) => unknown, undefined, [7, 3, 9]);
      renderedValues.push(typeof rendered === "string" ? rendered : "");
    }
  }
  return renderedValues;
}

describe("localization", () => {
  it.each([
    [undefined, "en", "en"],
    ["", "en", "en"],
    ["es", "en", "en"],
    ["en-GB", "en", "en-GB"],
    ["de-CH", "de", "de-CH"],
    ["RU_ru", "ru", "ru-RU"],
    ["ja-JP", "ja", "ja-JP"],
    ["tr-TR", "tr", "tr-TR"],
    ["zh", "zh", "zh-CN"],
    ["zh-CN", "zh", "zh-CN"],
    ["zh-Hans", "zh", "zh-CN"],
    ["zh-SG", "zh", "zh-CN"],
    ["zh-TW", "en", "en"],
    ["zh-Hant", "en", "en"],
    ["zh-HK", "en", "en"],
    ["zh-MO", "en", "en"],
    ["pt", "pt", "pt-BR"],
    ["pt-BR", "pt", "pt-BR"],
    ["pt-PT", "pt", "pt-BR"],
    ["PT_br", "pt", "pt-BR"]
  ] as const)("resolves %s to %s with date locale %s", (input, language, dateLocale) => {
    expect(resolveLocale(input)).toEqual({ language, dateLocale });
  });

  it("ships exactly the intended complete dictionaries", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "zh", "ru", "ja", "de", "pt", "tr"]);
    const englishKeys = Object.keys(LOCALE_DICTIONARIES.en).sort();
    for (const language of SUPPORTED_LANGUAGES) {
      const dictionary = LOCALE_DICTIONARIES[language];
      expect(Object.isFrozen(dictionary)).toBe(true);
      expect(Object.keys(dictionary).sort()).toEqual(englishKeys);
      expect(renderedValues(dictionary).every((value) => value.trim().length > 0)).toBe(true);
      if (language !== "en") expect(dictionary).not.toBe(LOCALE_DICTIONARIES.en);
    }
  });

  it("uses the canonical proper product name in every locale", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(LOCALE_DICTIONARIES[language].productName).toBe("Alarm and Timer");
    }
  });

  it.each([
    ["en", "Obsidian must be active for alerts."],
    ["zh", "Obsidian 必须处于活动状态才能发出提醒。"],
    ["ru", "Для сигнала Obsidian должен быть активен."],
    ["ja", "通知するには Obsidian がアクティブである必要があります。"],
    ["de", "Obsidian muss für Alarme aktiv sein."],
    ["pt", "O Obsidian precisa estar ativo para emitir alertas."],
    ["tr", "Uyarılar için Obsidian etkin olmalıdır."]
  ] as const)("keeps the closed-app warning concise in %s", (language, expected) => {
    expect(LOCALE_DICTIONARIES[language].closedAppLimitation).toBe(expected);
  });

  it.each(SUPPORTED_LANGUAGES)("preserves user labels literally in %s", (language: SupportedLanguage) => {
    const i18n = createI18n(language);
    const label = "% {label} <b>🔔 日本語 العربية";
    const item: TimerItem = {
      id: "literal",
      type: "timer",
      label,
      createdAt: 1,
      targetAt: 2,
      durationMs: 1_000,
      status: "active"
    };
    expect(i18n.displayLabel(item)).toBe(label);
    expect(i18n.messages.timerFinishedLabel(label)).toContain(label);
    expect(i18n.messages.itemRemainingAria(label, "01:00")).toContain(label);
  });

  it("uses localized fallback labels and invalid dates", () => {
    const i18n = createI18n("tr");
    const item: TimerItem = {
      id: "blank",
      type: "timer",
      label: " ",
      createdAt: 1,
      targetAt: 2,
      durationMs: 1_000,
      status: "active"
    };
    expect(i18n.displayLabel(item)).toBe("Zamanlayıcı");
    expect(i18n.formatDateTime(Number.NaN, false)).toBe("Geçersiz tarih");
  });

  it("uses Brazilian Portuguese formatting for the single pt dictionary", () => {
    const i18n = createI18n("pt-PT");
    expect(i18n.language).toBe("pt");
    expect(i18n.dateLocale).toBe("pt-BR");
    expect(i18n.messages.productName).toBe("Alarm and Timer");
  });

  it("uses natural Russian plural forms", () => {
    const messages = LOCALE_DICTIONARIES.ru;
    expect(messages.quickDurationAria(1)).toContain("минуту");
    expect(messages.quickDurationAria(2)).toContain("минуты");
    expect(messages.quickDurationAria(5)).toContain("минут");
    expect(messages.quickDurationAria(11)).toContain("минут");
    expect(messages.quickDurationAria(21)).toContain("минуту");
  });

  it("formats dates with the resolved locale and honors the clock setting", () => {
    const timestamp = Date.UTC(2026, 6, 25, 17, 5);
    const english = createI18n("en-US").formatDateTime(timestamp, false);
    const japanese = createI18n("ja").formatDateTime(timestamp, true);
    const german = createI18n("de").formatDateTime(timestamp, true);
    expect(new Set([english, japanese, german]).size).toBe(3);
    expect(japanese).not.toMatch(/\bPM\b/i);
    expect(german).not.toMatch(/\bPM\b/i);
  });
});
