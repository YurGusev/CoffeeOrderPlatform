export function dynamicValue(): unknown {
  return new Function("return 1")();
}
