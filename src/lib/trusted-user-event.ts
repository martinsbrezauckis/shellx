export interface ShellxUserEventLike {
  isTrusted?: boolean;
  nativeEvent?: {
    isTrusted?: boolean;
  };
}

export function isTrustedShellxUserEvent(event: ShellxUserEventLike | null | undefined): boolean {
  return event?.nativeEvent?.isTrusted === true || event?.isTrusted === true;
}
