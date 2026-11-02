import { getDb } from "../../../server/db/client";
import { createHandlers } from "../../../server/http/handlers";

export async function POST(request: Request): Promise<Response> {
  return createHandlers(getDb()).createVehicle(request);
}
