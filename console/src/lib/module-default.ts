/**
 * Component a CommonJS Next.js entry point (`next/link`, `next/form`)
 * exports as `default`.
 *
 * Those entry points are CommonJS files with `export default` declarations.
 * Next's compiler and the Console tsconfig (bundler resolution) bind a
 * default import to the component itself, while Node's ESM loader (which
 * runs the Console tests) and the root NodeNext typecheck bind it to
 * `module.exports`. Next's CommonJS builds also expose the component as
 * `module.exports.default`, so reading `default` when present yields the
 * component under every loader and both typechecks.
 */
export type ModuleDefault<T> = T extends { readonly default: infer D } ? D : T;

export function moduleDefault<T extends object>(imported: T): ModuleDefault<T> {
  return (
    "default" in imported ? imported.default : imported
  ) as ModuleDefault<T>;
}
