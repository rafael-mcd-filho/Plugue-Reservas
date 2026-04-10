const DEFAULT_TIMEZONE = "America/Fortaleza";

function getDateTimeFormatter(timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function getZonedParts(date: Date, timeZone = DEFAULT_TIMEZONE) {
  const formatter = getDateTimeFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

export function formatDateKeyInTimeZone(date: Date, timeZone = DEFAULT_TIMEZONE) {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatTimeInTimeZone(date: Date, timeZone = DEFAULT_TIMEZONE) {
  const parts = getZonedParts(date, timeZone);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatMonthDayInTimeZone(date: Date, timeZone = DEFAULT_TIMEZONE) {
  const parts = getZonedParts(date, timeZone);
  return `${parts.month}-${parts.day}`;
}
