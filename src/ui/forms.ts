import { MAX_DURATION_DAYS, MAX_LABEL_LENGTH } from "../constants";
import type { I18n } from "../i18n";
import type { ItemService } from "../services/item-service";
import type { AlarmItem } from "../types";
import { nextAlarmTimestamp, type DateTimeErrorCode } from "../utils/date-time";
import { parseDuration, type DurationErrorCode } from "../utils/duration-parser";

export interface FormResult {
  success: boolean;
  error?: string;
}

function labeledInput(parent: HTMLElement, id: string, label: string, type: string, value = ""): HTMLInputElement {
  const group = parent.createDiv({ cls: "online-alarm-timer-field" });
  group.createEl("label", { attr: { for: id }, text: label });
  return group.createEl("input", { attr: { id, type, value } });
}

export function createAlarmForm(parent: HTMLElement, items: ItemService, prefix: string, onSuccess: () => void, i18n: I18n): HTMLFormElement {
  const { messages } = i18n;
  const form = parent.createEl("form", { cls: "online-alarm-timer-form" });
  const time = labeledInput(form, `${prefix}-time`, messages.time, "time");
  time.required = true;
  const date = labeledInput(form, `${prefix}-date`, messages.dateOptional, "date");
  const label = labeledInput(form, `${prefix}-label`, messages.labelOptional, "text");
  label.maxLength = MAX_LABEL_LENGTH;
  const error = form.createDiv({ cls: "online-alarm-timer-error", attr: { role: "alert", "aria-live": "polite" } });
  form.createEl("p", { cls: "online-alarm-timer-limitation", text: messages.closedAppLimitation });
  const submit = form.createEl("button", { cls: "mod-cta", attr: { type: "submit" }, text: messages.setAlarm });
  let submitting = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;
    const result = nextAlarmTimestamp(time.value, date.value || undefined);
    if (result.timestamp === undefined) {
      error.setText(result.error === undefined ? messages.alarmScheduleFailed : dateTimeErrorMessage(result.error, i18n));
      return;
    }
    error.empty();
    submitting = true;
    submit.disabled = true;
    void items.addAlarm(result.timestamp, label.value).then(() => {
      form.reset();
      onSuccess();
    }).catch(() => error.setText(messages.alarmSaveFailed)).finally(() => {
      submitting = false;
      submit.disabled = false;
    });
  });
  return form;
}

export function createTimerForm(parent: HTMLElement, items: ItemService, prefix: string, onSuccess: () => void, i18n: I18n): HTMLFormElement {
  const { messages } = i18n;
  const form = parent.createEl("form", { cls: "online-alarm-timer-form" });
  const duration = labeledInput(form, `${prefix}-duration`, messages.duration, "text", `${items.settings.defaultTimerMinutes}m`);
  duration.placeholder = messages.durationPlaceholder;
  duration.required = true;
  const label = labeledInput(form, `${prefix}-label`, messages.labelOptional, "text");
  label.maxLength = MAX_LABEL_LENGTH;
  const quick = form.createDiv({ cls: "online-alarm-timer-quick", attr: { role: "group", "aria-label": messages.quickDurations } });
  for (const minutes of items.settings.quickTimerMinutes) {
    const button = quick.createEl("button", { attr: { type: "button", "aria-label": messages.quickDurationAria(minutes) }, text: `${minutes}m` });
    button.addEventListener("click", () => { duration.value = `${minutes}m`; duration.focus(); });
  }
  const error = form.createDiv({ cls: "online-alarm-timer-error", attr: { role: "alert", "aria-live": "polite" } });
  form.createEl("p", { cls: "online-alarm-timer-help", text: messages.durationHelp(MAX_DURATION_DAYS) });
  form.createEl("p", { cls: "online-alarm-timer-limitation", text: messages.closedAppLimitation });
  const submit = form.createEl("button", { cls: "mod-cta", attr: { type: "submit" }, text: messages.startTimer });
  let submitting = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;
    const result = parseDuration(duration.value);
    if (result.milliseconds === undefined) {
      error.setText(result.error === undefined ? messages.timerStartFailed : durationErrorMessage(result.error, i18n));
      return;
    }
    error.empty();
    submitting = true;
    submit.disabled = true;
    void items.addTimer(result.milliseconds, label.value).then(() => {
      label.value = "";
      onSuccess();
    }).catch(() => error.setText(messages.timerSaveFailed)).finally(() => {
      submitting = false;
      submit.disabled = false;
    });
  });
  return form;
}

export function createEditAlarmForm(
  parent: HTMLElement,
  items: ItemService,
  item: AlarmItem,
  prefix: string,
  onSuccess: () => void,
  i18n: I18n
): HTMLFormElement {
  const { messages } = i18n;
  const originalTargetAt = item.targetAt;
  const scheduled = new Date(originalTargetAt);
  const initialTime = localTimeInput(scheduled);
  const initialDate = localDateInput(scheduled);
  const form = parent.createEl("form", { cls: "online-alarm-timer-form" });
  const time = labeledInput(form, `${prefix}-time`, messages.time, "time", initialTime);
  time.required = true;
  const date = labeledInput(form, `${prefix}-date`, messages.date, "date", initialDate);
  date.required = true;
  const label = labeledInput(form, `${prefix}-label`, messages.labelOptional, "text", item.label);
  label.maxLength = MAX_LABEL_LENGTH;
  const error = form.createDiv({ cls: "online-alarm-timer-error", attr: { role: "alert", "aria-live": "polite" } });
  const submit = form.createEl("button", { cls: "mod-cta", attr: { type: "submit" }, text: messages.saveAlarm });
  let submitting = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;
    let targetAt = originalTargetAt;
    if (time.value !== initialTime || date.value !== initialDate) {
      const result = nextAlarmTimestamp(time.value, date.value || undefined);
      if (result.timestamp === undefined) {
        error.setText(result.error === undefined ? messages.alarmUpdateFailed : dateTimeErrorMessage(result.error, i18n));
        return;
      }
      targetAt = result.timestamp;
    }
    error.empty();
    submitting = true;
    submit.disabled = true;
    void items.updateAlarm(item.id, targetAt, label.value).then((updated) => {
      if (!updated) {
        error.setText(messages.alarmUnavailableToEdit);
        return;
      }
      onSuccess();
    }).catch(() => error.setText(messages.alarmSaveFailed)).finally(() => {
      submitting = false;
      submit.disabled = false;
    });
  });
  return form;
}

function dateTimeErrorMessage(error: DateTimeErrorCode, i18n: I18n): string {
  if (error === "invalid-time") return i18n.messages.validationTime;
  if (error === "invalid-date") return i18n.messages.validationDate;
  if (error === "future-required") return i18n.messages.validationFuture;
  return i18n.messages.validationOccurrence;
}

function durationErrorMessage(error: DurationErrorCode, i18n: I18n): string {
  if (error === "required") return i18n.messages.validationDurationRequired;
  if (error === "invalid-format") return i18n.messages.validationDurationFormat;
  if (error === "minimum") return i18n.messages.validationDurationMinimum;
  return i18n.messages.validationDurationMaximum(MAX_DURATION_DAYS);
}

function localDateInput(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimeInput(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
