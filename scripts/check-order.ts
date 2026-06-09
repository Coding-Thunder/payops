 
import mongoose from "mongoose";

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/payops";
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no db");

  console.log("=== Provider collection ===");
  const providers = await db
    .collection("providers")
    .find({}, { projection: { key: 1, name: 1, status: 1 } })
    .toArray();
  console.log(JSON.stringify(providers, null, 2));

  console.log("\n=== Most recent 3 orders ===");
  const latest = await db
    .collection("orders")
    .find({}, { sort: { createdAt: -1 }, limit: 3 })
    .toArray();
  if (latest.length === 0) console.log("(no orders)");
  for (const o of latest) {
    console.log("---");
    console.log("orderNumber:", o.orderNumber);
    console.log("createdAt:  ", o.createdAt);
    console.log("provider:   ", JSON.stringify(o.provider, null, 2));
    console.log("vehicle:    ", JSON.stringify(o.vehicle));
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
