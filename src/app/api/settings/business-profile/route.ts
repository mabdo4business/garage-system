import { getDb } from "../../../../server/db/client";
import { createHandlers } from "../../../../server/http/handlers";

export async function GET(request: Request): Promise<Response> {
  return createHandlers(getDb()).getBusinessProfile(request);
}

export async function POST(request: Request): Promise<Response> {
  return createHandlers(getDb()).setBusinessProfile(request);
}
