import { redirect } from "next/navigation";

/**
 * `/app/orders/new` is the conventional name for this page and pairs with
 * `/app/orders/[id]/edit`. The form itself lives at `/app/orders/create`,
 * which every existing link and the command palette already use, so this
 * forwards rather than moving it. A static segment wins over `[id]`, so
 * "new" is never treated as an order id.
 */
export default function NewOrderRedirect() {
  redirect("/app/orders/create");
}
