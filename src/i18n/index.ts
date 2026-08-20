import type { ScheduledItem } from "../types";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { ja } from "./locales/ja";
import { pt } from "./locales/pt";
import { ru } from "./locales/ru";
import { tr } from "./locales/tr";
import { zh } from "./locales/zh";
import type { Messages } from "./messages";

export type SupportedLanguage = "en" | "zh" | "ru" | "ja" | "de" | "pt" | "tr";

export interface I18n {
  readonly language: SupportedLanguage;
  readonly dateLocale: string;
  readonly messages: Messages;
  formatDateTime(timestamp: number, use24Hour: boolean): string;
  displayLabel(item: ScheduledItem): string;
}

const dictionaries: Readonly<Record<SupportedLanguage, Messages>> = Object.freeze({
  en: Object.freeze(en),
  zh: Object.freeze(zh),
  ru: Object.freeze(ru),
  ja: Object.freeze(ja),
  de: Object.freeze(de),
  pt: Object.freeze(pt),
  tr: Object.freeze(tr)
});
const regionalLanguages = new Set<SupportedLanguage>(["en", "ru", "ja", "de", "tr"]);
const traditionalChineseTags = new Set(["zh-tw", "zh-hant", "zh-hk", "zh-mo"]);
const simplifiedChineseTags = new Set(["zh", "zh-cn", "zh-hans", "zh-sg"]);

interface ResolvedLocale {
  readonly language: SupportedLanguage;
  readonly dateLocale: string;
}

function canonicalDateLocale(value: string, fallback: string): string {
  try {
    return Intl.getCanonicalLocales(value)[0] ?? fallback;
  } catch {
    return fallback;
  }
}

export function resolveLocale(rawLanguage: string | null | undefined): ResolvedLocale {
  const normalized = (rawLanguage ?? "").trim().replaceAll("_", "-").toLowerCase();
  if (traditionalChineseTags.has(normalized)) return { language: "en", dateLocale: "en" };
  if (simplifiedChineseTags.has(normalized)) return { language: "zh", dateLocale: "zh-CN" };
  if (normalized === "pt" || normalized === "pt-br" || normalized === "pt-pt") {
    return { language: "pt", dateLocale: "pt-BR" };
  }
  const base = normalized.split("-")[0] as SupportedLanguage | undefined;
  if (base !== undefined && regionalLanguages.has(base)) {
    return { language: base, dateLocale: canonicalDateLocale(normalized, base) };
  }
  return { language: "en", dateLocale: "en" };
}

export function createI18n(rawLanguage: string | null | undefined): I18n {
  const resolved = resolveLocale(rawLanguage);
  const messages = dictionaries[resolved.language];
  const formatters = new Map<boolean, Intl.DateTimeFormat>();
  const formatterFor = (use24Hour: boolean): Intl.DateTimeFormat => {
    const cached = formatters.get(use24Hour);
    if (cached !== undefined) return cached;
    const formatter = new Intl.DateTimeFormat(resolved.dateLocale, {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: !use24Hour
    });
    formatters.set(use24Hour, formatter);
    return formatter;
  };
  return Object.freeze({
    ...resolved,
    messages,
    formatDateTime(timestamp: number, use24Hour: boolean): string {
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return messages.invalidDate;
      return formatterFor(use24Hour).format(date);
    },
    displayLabel(item: ScheduledItem): string {
      return item.label.trim() || (item.type === "alarm" ? messages.alarm : messages.timer);
    }
  });
}

export const EN_I18N = createI18n("en");
export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(dictionaries) as SupportedLanguage[]);
export const LOCALE_DICTIONARIES: Readonly<Record<SupportedLanguage, Messages>> = dictionaries;
