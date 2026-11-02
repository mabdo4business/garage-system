import { getDb } from "../../../../../server/db/client";
import { createHandlers } from "../../../../../server/http/handlers";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string; photoId: string }> },
): Promise<Response> {
  const { token, photoId } = await context.params;
  return createHandlers(getDb()).customerLinkPhoto(request, token, photoId);
}
