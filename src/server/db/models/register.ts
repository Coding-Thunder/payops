import mongoose, { type Model, type Schema } from "mongoose";

/**
 * Register a Mongoose model with HMR-safe schema swapping.
 *
 * Why this exists: Next.js HMR re-evaluates module files when they change,
 * but Mongoose holds compiled models in a process-global cache
 * (`mongoose.models`). The old `models.X || model("X", schema)` pattern
 * returns the cached model with the OLD schema, so subsequent writes
 * silently drop any field added since the cache was warmed.
 *
 * In dev we delete + re-register so the latest schema always wins. In
 * production HMR can't fire, so we use the standard cached pattern.
 *
 * Implementation note: We deliberately call `mongoose.model(name, schema)`
 * without a generic and cast the result. Passing the generic through
 * (`mongoose.model<T>(name, schema)`) inside this function triggers an
 * infinite type-instantiation in mongoose 9.x and crashes `tsc` with an
 * OOM. Casting keeps the public `Model<T>` contract intact at every call
 * site while skipping the pathological overload resolution.
 */
export function registerModel<T>(name: string, schema: Schema): Model<T> {
  if (process.env.NODE_ENV !== "production" && mongoose.models[name]) {
    mongoose.deleteModel(name);
  }
  const cached = mongoose.models[name] as Model<T> | undefined;
  if (cached) return cached;
  return mongoose.model(name, schema) as unknown as Model<T>;
}
