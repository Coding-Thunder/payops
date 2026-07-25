import "server-only";

import mongoose, { type Mongoose } from "mongoose";

import { env } from "@/server/env";

/**
 * Single shared Mongoose connection, cached on the Node global so
 * dev-mode HMR and route bundling don't open a new pool per reload.
 * Mirrors the main app's connection helper.
 */
type CachedMongoose = { conn: Mongoose | null; promise: Promise<Mongoose> | null };

declare global {
  // eslint-disable-next-line no-var
  var __adminMongoose: CachedMongoose | undefined;
}

const cache: CachedMongoose =
  global.__adminMongoose ?? { conn: null, promise: null };
if (!global.__adminMongoose) global.__adminMongoose = cache;

export async function connectMongo(): Promise<Mongoose> {
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    const { MONGODB_URI, MONGODB_DB } = env.server;
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: MONGODB_DB,
        bufferCommands: false,
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10_000,
      })
      .catch((err) => {
        cache.promise = null;
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}
