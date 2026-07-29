import mongoose, { type Mongoose } from "mongoose";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Single shared Mongoose connection. We cache the connection promise on the
 * Node global so that dev-mode HMR and Next.js route bundling don't open a
 * new pool on every reload.
 */

type CachedMongoose = {
  conn: Mongoose | null;
  promise: Promise<Mongoose> | null;
};

declare global {
   
  var __tracetxnMongoose: CachedMongoose | undefined;
}

const cache: CachedMongoose =
  global.__tracetxnMongoose ?? { conn: null, promise: null };
if (!global.__tracetxnMongoose) global.__tracetxnMongoose = cache;

export async function connectMongo(): Promise<Mongoose> {
  if (cache.conn) return cache.conn;
  if (!cache.promise) {
    const { MONGODB_URI, MONGODB_DB } = env.server;
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: MONGODB_DB,
        bufferCommands: false,
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10_000,
        // Fail a hung *connect* or a hung in-flight *operation* fast, so a
        // stalled socket surfaces as a typed 500/502 the caller can retry
        // instead of hanging past the ingress timeout and becoming a 504.
        // Both are well below any reverse-proxy/serverless request ceiling.
        connectTimeoutMS: 10_000,
        socketTimeoutMS: 20_000,
        autoIndex: process.env.NODE_ENV !== "production",
      })
      .then((m) => {
        logger.info("mongo.connected", {
          host: m.connection.host,
          name: m.connection.name,
        });
        m.connection.on("error", (err) =>
          logger.error("mongo.error", { err: String(err) }),
        );
        m.connection.on("disconnected", () =>
          logger.warn("mongo.disconnected"),
        );
        return m;
      })
      .catch((err) => {
        cache.promise = null;
        logger.error("mongo.connect_failed", { err: String(err) });
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectMongo(): Promise<void> {
  if (cache.conn) {
    await cache.conn.disconnect();
    cache.conn = null;
    cache.promise = null;
  }
}
