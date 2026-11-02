/** A notification interval: a whole number of days from 1 to 365 (the API enforces the same range). */
export const isValidDays = (value: string) =>
  /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 365;
