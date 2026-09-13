import { z } from "zod";

import { DeliverySchema, IncidentSchema } from "@scout/domain";
import { HttpError, identity } from "@/server/auth";
import { route } from "@/server/http";

export const GET = route(async (request) => {
  const id = z.uuid().parse(new URL(request.url).searchParams.get("id"));
  const { client } = await identity();
  const [incident, deliveries] = await Promise.all([
    client.rpc("scout_incident", { incident_id: id }),
    client.rpc("scout_delivery_history", { incident_id: id }),
  ]);

  if (incident.error || deliveries.error) {
    throw new Error("Incident could not be loaded.");
  }

  if (!incident.data) {
    throw new HttpError(404, "Incident not available to this account.");
  }

  return {
    incident: IncidentSchema.parse(incident.data),
    deliveries: z.array(DeliverySchema).parse(deliveries.data),
  };
});
