import { getDb } from "../../../../../server/db/client";
import { createHandlers } from "../../../../../server/http/handlers";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const { id, action } = await context.params;
  return createHandlers(getDb()).jobAction(request, id, action);
}
