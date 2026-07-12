import { z } from "zod";

type RuntimeConstructor<T> = abstract new (...args: never[]) => T;

/** Safely test a platform-provided constructor without evaluating a missing global. */
export function isGlobalInstance<T>(value: unknown, name: string): value is T {
  const runtimeConstructor = (globalThis as Record<string, unknown>)[name];
  return typeof runtimeConstructor === "function" && value instanceof (runtimeConstructor as RuntimeConstructor<T>);
}

/** Zod schema for values whose constructor may not exist in every runtime. */
export function globalInstanceSchema<T>(name: string): z.ZodType<T> {
  return z.custom<T>((value) => isGlobalInstance<T>(value, name), {
    message: `Expected ${name}`,
  });
}
