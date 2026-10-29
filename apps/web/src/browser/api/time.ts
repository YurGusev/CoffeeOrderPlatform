const instantPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function instantEpochMilliseconds(value: string): number {
  const match = instantPattern.exec(value);
  if (!match) throw new Error("Некорректный expiresAt сессии");
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = "",
    zone,
  ] = match;
  if (
    !yearText ||
    !monthText ||
    !dayText ||
    !hourText ||
    !minuteText ||
    !secondText ||
    !zone
  ) {
    throw new Error("Некорректный expiresAt сессии");
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error("Некорректный expiresAt сессии");
  }
  const fractionMilliseconds = Number(`${fraction}000`.slice(0, 3));
  const zoneOffsetMinutes =
    zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return (
    daysFromCivil(year, month, day) * 86_400_000 +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1_000 +
    fractionMilliseconds -
    zoneOffsetMinutes * 60_000
  );
}

export function currentEpochMilliseconds(): number {
  return performance.timeOrigin + performance.now();
}
