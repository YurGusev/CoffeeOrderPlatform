export function formatMoney(minor: string, currency = "RUB"): string {
  try {
    const negative = minor.startsWith("-");
    const digits = negative ? minor.slice(1) : minor;
    const padded = digits.padStart(3, "0");
    const major = padded.slice(0, -2);
    const fraction = padded.slice(-2);
    return `${negative ? "−" : ""}${major.replace(/\B(?=(\d{3})+(?!\d))/gu, " ")},${fraction} ${currency === "RUB" ? "₽" : currency}`;
  } catch {
    return `${minor} ${currency}`;
  }
}

export function formatPrivatePhone(phone: string): string {
  if (!phone.startsWith("+") || phone.length < 9) return "Телефон скрыт";
  return `${phone.slice(0, 4)}••••${phone.slice(-4)}`;
}

export function compareDecimalVersion(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}
