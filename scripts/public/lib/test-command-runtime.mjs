export function testCommandInvocation(command) {
  const [runtime, ...args] = command;
  if (runtime === "node") return { executable: process.execPath, args };
  if (runtime === "tsx") {
    return { executable: process.execPath, args: ["--import", "tsx", ...args] };
  }
  throw new Error(`unsupported test runtime: ${String(runtime)}`);
}

export function testSuiteRange(args, suiteLength) {
  if (!Number.isSafeInteger(suiteLength) || suiteLength < 1) {
    throw new Error("test suite length must be a positive integer");
  }
  let from = 1;
  let to = suiteLength;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = Number(args[index + 1]);
    if (!["--from", "--to"].includes(flag) || !Number.isSafeInteger(value)) {
      throw new Error("test suite range accepts only --from <row> and --to <row>");
    }
    if (flag === "--from") from = value;
    else to = value;
  }
  if (from < 1 || to > suiteLength || from > to) {
    throw new Error(`test suite range must satisfy 1 <= from <= to <= ${suiteLength}`);
  }
  return { startIndex: from - 1, endIndex: to };
}
