/**
 * Generic type helper to pick documented fields that exist in inferred inputs.
 * This preserves JSDoc comments while ensuring type inference accuracy.
 *
 * @template TDocumented - The documented type with JSDoc comments
 * @template TInferred - The inferred type from schemas (e.g., Zod)
 */
export type PickDocumentedFields<TDocumented, TInferred> = Pick<TDocumented, keyof TDocumented & keyof TInferred>;

/**
 * Generic type helper to merge documented inputs with inferred inputs.
 * Ensures inferred types take precedence while preserving JSDoc comments.
 *
 * By intersecting PickDocumentedFields with TInferred, we get:
 * - JSDoc comments from TDocumented (from PickDocumentedFields)
 * - Accurate types from schemas (from TInferred, takes precedence in intersection)
 *
 * @template TDocumented - The documented type with JSDoc comments
 * @template TInferred - The inferred type from schemas (e.g., Zod)
 */
export type MergeDocumentedFields<TDocumented, TInferred> = PickDocumentedFields<TDocumented, TInferred> & TInferred;
