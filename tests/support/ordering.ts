/**
The ordering the suites assert on.

RuleSync, the Data command catalog, and the installer all order their
outputs with the default string comparison, so the suites sort with the
same one. A suite that sorted differently would assert an order production
never produces.
*/

/**
Compare two strings the way the default string sort does.
*/
export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
