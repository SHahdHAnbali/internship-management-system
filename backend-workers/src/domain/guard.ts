import { DomainError } from './errors';
import { isNullOrWhiteSpace, trimDotnet } from './text';

/** Mirrors Ims.Domain.Common.Guard (same codes and messages). */
export function required(value: string | null | undefined, name: string, maxLength: number): string {
  if (isNullOrWhiteSpace(value)) {
    throw new DomainError('validation.required', `${name} is required.`);
  }

  return checkMaxLength(trimDotnet(value), name, maxLength);
}

export function optional(value: string | null | undefined, name: string, maxLength: number): string | null {
  return isNullOrWhiteSpace(value) ? null : checkMaxLength(trimDotnet(value), name, maxLength);
}

function checkMaxLength(value: string, name: string, maxLength: number): string {
  if (value.length > maxLength) {
    throw new DomainError('validation.too_long', `${name} must be at most ${maxLength} characters.`);
  }

  return value;
}
