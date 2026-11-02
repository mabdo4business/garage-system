import { getDb } from "../../../../server/db/client";
import { createHandlers } from "../../../../server/http/handlers";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return createHandlers(getDb()).getJob(request, id);
}
